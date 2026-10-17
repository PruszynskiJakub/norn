import { acquire, claimRecord, isStale } from "./claims.js";
import type { Event } from "./events.js";
import { flowOf } from "./flow-loading.js";
import type { ClaimRecord, HeldClaim, Offered } from "./github.js";
import { type NextReport, nextRefusal } from "./next.js";
import { type Refused, refuse } from "./refusals.js";
import { bestEffort, type Ctx } from "./transitions.js";

/**
 * A story's delivery lock: one orchestrator per story. It is a claim under refs/norn/deliveries/<story>, taken, gone
 * stale and taken over by the same rules, so a crashed orchestrator never blocks the next one for long.
 */

/** Who delivers a story: which session, as for a claim, how the user tells that session apart, and since when. */
export interface Delivery {
  session: "this" | "yours" | "other";
  mine: boolean;
  /** The session's herdr pane, e.g. herdr:w3T:p1, else its session id. */
  who: string;
  /** ISO timestamp of the lock's last refresh. */
  since: string;
}

/** The lock as one session sees it. */
export function deliveryOf(record: ClaimRecord, session: string, user: string): Delivery {
  const mine = record.holder === user;
  return {
    session: record.session === session ? "this" : mine ? "yours" : "other",
    mine,
    who: record.pane ? `herdr:${record.pane.id}` : record.session,
    since: record.since,
  };
}

/** The story's live delivery lock, with its record; null when there is none or it went stale. */
export async function heldDelivery(ctx: Ctx, n: number): Promise<{ delivery: Delivery; record: HeldClaim } | null> {
  const record = await ctx.github.readClaim(n, "deliveries");
  if (!record || isStale(record, ctx.now(), ctx.config.staleAfterMs)) return null;
  return { delivery: deliveryOf(record, ctx.session, await ctx.github.currentUser()), record };
}

/** Why a session may not deliver a story: another one does. `who` and `since` as in Delivery. */
export interface DeliveryHeld {
  kind: "delivery-held";
  story: number;
  flow: string;
  who: string;
  since: string;
  /** Held by another session of the user's, which they may take over once it has stopped. */
  mine: boolean;
}

export interface DeliverResult {
  ok: true;
  kind: "delivering";
  story: number;
  flow: string;
  title: string;
  /** This session already delivered the story; its lock is refreshed. */
  reacquired: boolean;
  /** The lock taken over: a stale one, or one of the user's own with --takeover. */
  tookOver: Delivery | null;
}

export interface DeliveryStoppedResult {
  ok: true;
  kind: "delivery-stopped";
  story: number;
  flow: string;
  /** Whether there was a lock to release. */
  held: boolean;
}

/**
 * norn deliver: takes the story's delivery lock for this session, or with `stop` releases it. A lock another session
 * holds is refused, naming it; with `takeover` the user's own is taken, at any age, as for a claim.
 */
export async function deliver(ctx: Ctx, n: number, opts: { takeover: boolean; stop: boolean }): Promise<DeliverResult | DeliveryStoppedResult | Refused> {
  const { github } = ctx;
  const issue = await github.getIssue(n);
  const loaded = await flowOf(ctx, issue);
  const r = await nextRefusal(github, issue, loaded);
  if (r || !loaded) return refuse(r ?? { kind: "not-a-story", issue: n });
  if (issue.state === "closed" && !opts.stop) return refuse({ kind: "closed", issue: n });
  const flow = loaded.name;
  const user = await github.currentUser();
  const held = await github.readClaim(n, "deliveries");
  if (opts.stop) {
    if (!held) return { ok: true, kind: "delivery-stopped", story: n, flow, held: false };
    const free = held.session === ctx.session || isStale(held, ctx.now(), ctx.config.staleAfterMs) || (opts.takeover && held.holder === user);
    if (!free) return refuse(heldBy(n, flow, held, ctx.session, user));
    await github.deleteClaim(n, "deliveries");
    return { ok: true, kind: "delivery-stopped", story: n, flow, held: true };
  }
  const got = await acquire(github, n, claimRecord(ctx, user), ctx.now(), ctx.config.staleAfterMs, { takeover: opts.takeover, space: "deliveries" });
  if (!got.ok) {
    const now = got.held ?? { holder: "", session: "unknown", since: ctx.now().toISOString() };
    return refuse(heldBy(n, flow, now, ctx.session, user));
  }
  return {
    ok: true,
    kind: "delivering",
    story: n,
    flow,
    title: issue.title,
    reacquired: got.reacquired ?? false,
    tookOver: got.tookOver ? deliveryOf(got.tookOver, ctx.session, user) : null,
  };
}

function heldBy(story: number, flow: string, record: ClaimRecord, session: string, user: string): DeliveryHeld {
  const { who, since, mine } = deliveryOf(record, session, user);
  return { kind: "delivery-held", story, flow, who, since, mine };
}

/** The items a report offers an agent to start, each in the state offered, as the delivery lock records them. */
export function offeredIn(r: NextReport, at: Date): Offered {
  return { at: at.toISOString(), items: r.start.filter((s) => !s.attended).map((s) => ({ issue: s.issue, state: s.state })) };
}

/**
 * Records on this session's delivery lock what its norn next offered, refreshing the lock: norn wait then wakes only for
 * what is new since. Nothing for a session that does not deliver the story. Best effort.
 */
export async function recordOffered(ctx: Ctx, r: NextReport): Promise<Event[]> {
  if (r.delivery?.session !== "this") return [];
  return bestEffort("record-offered", r.issue, r.issue, async () => {
    const held = await ctx.github.readClaim(r.issue, "deliveries");
    if (!held || held.session !== ctx.session) return [];
    const record: ClaimRecord = { ...claimRecord(ctx, held.holder), offered: offeredIn(r, ctx.now()) };
    await ctx.github.replaceClaim(r.issue, held.sha, record, "deliveries");
    return [];
  });
}
