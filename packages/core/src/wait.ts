import { claimRecord, isStale } from "./claims.js";
import { type Delivery, deliveryOf, type DeliveryHeld } from "./delivery.js";
import { flowOf } from "./flow-loading.js";
import type { ClaimRecord, Offered } from "./github.js";
import { computeNext, type NextReport, nextRefusal, type StartItem } from "./next.js";
import { type Refused, refuse } from "./refusals.js";
import { type Ctx, flagNeedsHuman } from "./transitions.js";
import type { AgentActivity } from "./workspace.js";

/**
 * norn wait: blocks until norn next has something new for the orchestrator to do, so it never writes a monitor of its
 * own. The condition is level-triggered: it holds on what norn next would answer now, so a change made before the wait
 * started is never missed, and it is one pure function a dispatcher can reuse. Waiting reads GitHub sparingly: a cheap
 * stamp first, the full answer only when the stamp changes, backing off while nothing does.
 */

/** What the orchestrator does next, by the wake condition. */
export type Wake =
  /** Items it has not been offered yet can start: run norn next. */
  | { kind: "start"; items: StartItem[] }
  /** Nothing is left that it can do, or the story is closed. */
  | { kind: "stop" }
  | { kind: "wait" };

/**
 * The wake condition, on norn next's answer and on what the orchestrator's last norn next offered. An item counts as
 * new when that norn next did not offer it in the state it is in now, or offered it longer ago than `graceMs` and no
 * agent has taken it since; a state an agent finished moves it on, so its next step is new. Attended steps are a
 * person's, never an agent's to start.
 */
export function wakeOf(r: NextReport, offered: Offered | null, now: Date, graceMs: number): Wake {
  if (r.closed || r.nothingLeft) return { kind: "stop" };
  const startable = r.start.filter((s) => !s.attended);
  const running = r.waiting.some((w) => w.reason === "held");
  if (!startable.length && !running) return { kind: "stop" };
  const lapsed = offered !== null && now.getTime() - new Date(offered.at).getTime() > graceMs;
  const fresh = startable.filter((s) => lapsed || !offered?.items.some((o) => o.issue === s.issue && o.state === s.state));
  return fresh.length && r.slots > 0 ? { kind: "start", items: fresh } : { kind: "wait" };
}

/** Checks start this often, and back off to MAX_CHECK_MS while nothing changes. */
export const MIN_CHECK_MS = 30_000;
export const MAX_CHECK_MS = 120_000;
/** A claim goes stale with no change GitHub records, so the full answer is worked out at least this often. */
const FULL_CHECK_MS = 10 * 60_000;
/** The delivery lock is refreshed at least this often, far inside claims.staleAfter. */
const LOCK_REFRESH_MS = 5 * 60_000;

/** An item norn escalated because the agent holding it stopped: in which pane, doing what, and the reason recorded. */
export interface StuckEscalation {
  issue: number;
  pane: string;
  activity: AgentActivity;
  reason: string;
}

export interface WaitResult {
  ok: true;
  kind: "waited";
  story: number;
  flow: string;
  /** start: something new can start; stop: nothing left that the orchestrator can do; timeout: --timeout passed first. */
  wake: "start" | "stop" | "timeout";
  /** For start, the items new to start. */
  items: StartItem[];
  /** norn next's answer at the last check. */
  report: NextReport;
  escalated: StuckEscalation[];
}

/** An activity that means the agent holding a claim no longer works on it. */
const STOPPED: AgentActivity[] = ["idle", "done", "gone", "blocked"];

/** The reason recorded for a stuck agent, saying what it is doing in which pane. */
export function stuckReason(pane: string, activity: AgentActivity): string {
  return activity === "blocked" ? `agent in pane ${pane} is waiting at a permission prompt` : `agent in pane ${pane} stopped while holding the claim`;
}

export async function wait(ctx: Ctx, n: number, opts: { timeoutMs: number }): Promise<WaitResult | Refused> {
  const { github } = ctx;
  const issue = await github.getIssue(n);
  const loaded = await flowOf(ctx, issue);
  const r = await nextRefusal(github, issue, loaded);
  if (r || !loaded) return refuse(r ?? { kind: "not-a-story", issue: n });
  const user = await github.currentUser();
  const started = ctx.now().getTime();
  const lock = await holdLock(ctx, n, loaded.name, user);
  if (!lock.ok) return lock;
  let offered = lock.offered;
  let lockedAt = started;
  const escalated: StuckEscalation[] = [];
  const records = new Map<number, ClaimRecord>();
  let stamp: string | null = null;
  let report: NextReport | null = null;
  let fullAt = 0;
  let interval = MIN_CHECK_MS;
  const done = (wake: WaitResult["wake"], items: StartItem[] = []): WaitResult => ({
    ok: true,
    kind: "waited",
    story: n,
    flow: loaded.name,
    wake,
    items,
    report: report!,
    escalated,
  });
  for (;;) {
    const now = ctx.now().getTime();
    const seen = await github.activityStamp(n);
    if (report === null || seen !== stamp || now - fullAt >= FULL_CHECK_MS) {
      report = await computeNext(ctx, n, loaded);
      // norn next's own follow-ups may have changed what the stamp covers; the stamp after them is the one to compare.
      stamp = await github.activityStamp(n);
      fullAt = now;
      interval = MIN_CHECK_MS;
    } else interval = Math.min(interval * 2, MAX_CHECK_MS);
    const stuck = await escalateStuck(ctx, report, records, user);
    if (stuck.length) {
      escalated.push(...stuck);
      report = await computeNext(ctx, n, loaded);
      stamp = await github.activityStamp(n);
    }
    const wake = wakeOf(report, offered, ctx.now(), ctx.config.stuckAfterMs);
    if (wake.kind === "start") return done("start", wake.items);
    if (wake.kind === "stop") {
      // Delivery stops here, so the lock goes: a finished delivery never blocks the next one.
      await github.deleteClaim(n, "deliveries");
      return done("stop");
    }
    const elapsed = ctx.now().getTime() - started;
    if (elapsed >= opts.timeoutMs) return done("timeout");
    if (ctx.now().getTime() - lockedAt >= LOCK_REFRESH_MS) {
      const kept = await holdLock(ctx, n, loaded.name, user);
      if (!kept.ok) return kept;
      offered = kept.offered;
      lockedAt = ctx.now().getTime();
    }
    await ctx.sleep(Math.min(interval, opts.timeoutMs - elapsed));
  }
}

/**
 * Takes or refreshes the story's delivery lock for this session, keeping what its last norn next offered; refused
 * while another session holds it live. Returns what was offered.
 */
async function holdLock(ctx: Ctx, n: number, flow: string, user: string): Promise<{ ok: true; offered: Offered | null } | Refused> {
  const { github } = ctx;
  const held = await github.readClaim(n, "deliveries");
  const own = held?.session === ctx.session;
  if (held && !own && !isStale(held, ctx.now(), ctx.config.staleAfterMs)) return refuse(lockHeld(n, flow, deliveryOf(held, ctx.session, user)));
  const offered = own ? (held.offered ?? null) : null;
  const record: ClaimRecord = { ...claimRecord(ctx, user), ...(offered ? { offered } : {}) };
  const ok = held ? await github.replaceClaim(n, held.sha, record, "deliveries") : await github.createClaim(n, record, "deliveries");
  if (ok) return { ok: true, offered };
  // Another session took it in between.
  const now = await github.readClaim(n, "deliveries");
  return refuse(
    lockHeld(n, flow, now ? deliveryOf(now, ctx.session, user) : { session: "other", mine: false, who: "unknown", since: ctx.now().toISOString() }),
  );
}

function lockHeld(story: number, flow: string, d: Delivery): DeliveryHeld {
  return { kind: "delivery-held", story, flow, who: d.who, since: d.since, mine: d.mine };
}

/**
 * Escalates each item of the story held by one of the user's sessions in a herdr pane of this machine whose agent has
 * been idle, done, gone or blocked for longer than deliver.stuckAfter: needs-human with what the agent is doing and
 * where, the claim deleted and the user notified, as the agent should have done. Never a teammate's claim, nor one of
 * a session norn cannot observe. `records` caches claim records by item, read again when the claim is refreshed.
 */
async function escalateStuck(ctx: Ctx, r: NextReport, records: Map<number, ClaimRecord>, user: string): Promise<StuckEscalation[]> {
  const out: StuckEscalation[] = [];
  for (const w of r.waiting) {
    if (w.reason !== "held" || !w.holder.mine || w.holder.session === "this") continue;
    let record = records.get(w.issue);
    if (record?.since !== w.holder.since) {
      record = (await ctx.github.readClaim(w.issue)) ?? undefined;
      if (record) records.set(w.issue, record);
    }
    const pane = record?.pane;
    if (!record || record.holder !== user || !pane || pane.machine !== ctx.machine) continue;
    const { activity, forMs } = await ctx.workspace.agentActivity(pane.id);
    if (!STOPPED.includes(activity) || forMs <= ctx.config.stuckAfterMs) continue;
    const reason = stuckReason(pane.id, activity);
    if (await takeFromStopped(ctx, w.issue, record, user)) {
      await flagNeedsHuman(ctx, w.issue, reason);
      out.push({ issue: w.issue, pane: pane.id, activity, reason });
    }
  }
  return out;
}

/** Takes the claim from the stopped session, only while it is still the one read, so a claim refreshed since is never taken. */
async function takeFromStopped(ctx: Ctx, n: number, was: ClaimRecord, user: string): Promise<boolean> {
  const held = await ctx.github.readClaim(n);
  if (!held || held.session !== was.session || held.since !== was.since) return false;
  return ctx.github.replaceClaim(n, held.sha, claimRecord(ctx, user));
}
