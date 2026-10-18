import { join } from "node:path";
import {
  type AttemptEnd,
  type Ctx,
  next,
  notifyRunBlocked,
  type Refusal,
  renewLease,
  type RunAgent,
  type Settlement,
  settleRun,
  type WaitItem,
} from "@norn/core";
import type { AgentAttempt, AgentDriver, AgentEnd } from "./agent-driver.js";
import type { Herdr } from "./herdr.js";
import { closePane, herdrDriver } from "./herdr-driver.js";
import { readRecord, type RunRecord, runDirFor, supervisorLives, writeRecord, writeWake } from "./run-records.js";

/**
 * norn run: a supervisor per item, so an agent never has to keep itself
 * alive. norn run checks that norn next offers the item to an agent, makes
 * its worktree and starts the supervisor as a detached process. The
 * supervisor starts the agent in a herdr pane, keeps the claim's lease fresh
 * while the agent lives, stops it when it stalls, times out or loses the
 * claim, settles each attempt from GitHub (finished, retry, escalated,
 * lost), and leaves a wake for the norn deliver waiting on the story.
 */

/** What norn run and norn deliver need from the machine, beyond the ports. */
export interface RunHost {
  /** The herdr CLI, in the herdr session norn runs in. */
  herdr: Herdr;
  /** Runs a shell command, e.g. one that creates a worktree; its exit code. */
  shell: (command: string, cwd: string) => Promise<number>;
  /** Starts a run's supervisor as a process of its own that outlives the caller; its pid. */
  startSupervisor: (start: SupervisorStart) => Promise<number>;
  /** Prints one line of a long command's progress as it happens. */
  print: (line: string) => void;
  /** The command that runs this norn, which a run's agent uses for every norn command of its step. */
  norn: string;
}

/** What a supervisor is started with. */
export interface SupervisorStart {
  issue: number;
  story: number;
  /** The run's own norn session. */
  session: string;
  agent: string;
  worktree: string;
  /** Where the supervisor's own output goes. */
  log: string;
}

export interface RunStarted {
  ok: true;
  kind: "run-started";
  issue: number;
  story: number;
  step: string;
  agent: string;
  session: string;
  pid: number;
  worktree: string;
  log: string;
}

/** Why norn run cannot start a run of the item now. */
export type RunBlocker =
  | { kind: "waits"; wait: WaitItem }
  | { kind: "not-offered" }
  | { kind: "attended"; step: string }
  | { kind: "checked-out"; branch: string; at: string }
  | { kind: "worktree-failed"; command: string };

export type RunRefusal =
  | { kind: "run-already-running"; issue: number; session: string; pid: number }
  | { kind: "run-not-startable"; issue: number; story: number; why: RunBlocker };

/** Something the supervisor did, for its log. */
export type RunEvent =
  | { kind: "attempt-started"; attempt: number; agent: string; pane: string | null }
  | { kind: "nudged"; attempt: number; pane: string }
  | { kind: "taken" }
  | { kind: "blocked"; pane: string }
  | { kind: "stopping"; why: AttemptEnd | { kind: "lost-claim" } }
  | { kind: "settled"; attempt: number; end: AttemptEnd; minutes: number; settled: Settlement }
  | { kind: "tick-failed"; detail: string };

type RunCtx = Ctx & { runs: RunHost };
const refuse = (refusal: RunRefusal) => ({ ok: false as const, refusal });

/** Starts a supervisor for issue n. The caller returns at once; the run goes on without it. */
export async function startRun(ctx: RunCtx, n: number, opts: { agent?: string } = {}): Promise<RunStarted | { ok: false; refusal: RunRefusal | Refusal }> {
  const root = ctx.workspace.root;
  const agent = opts.agent ?? ctx.config.run.agent;
  const existing = readRecord(root, n);
  if (existing?.state === "running" && supervisorLives(existing))
    return refuse({ kind: "run-already-running", issue: n, session: existing.session, pid: existing.pid });
  const story = (await ctx.github.parentOf(n)) ?? n;
  const answer = await next(ctx, story);
  if (!answer.ok) return answer;
  const notStartable = (why: RunBlocker) => refuse({ kind: "run-not-startable", issue: n, story, why });
  const item = answer.report.start.find((s) => s.issue === n);
  if (!item) {
    const wait = answer.report.waiting.find((w) => w.issue === n);
    return notStartable(wait ? { kind: "waits", wait } : { kind: "not-offered" });
  }
  if (item.attended) return notStartable({ kind: "attended", step: item.step });
  if (item.checkedOutAt && item.branch) return notStartable({ kind: "checked-out", branch: item.branch, at: item.checkedOutAt });
  // The agent starts in its worktree's pane, so the worktree is made first.
  if (item.createWorktree && (await ctx.runs.shell(item.createWorktree, root)) !== 0)
    return notStartable({ kind: "worktree-failed", command: item.createWorktree });
  const worktree = item.worktree ?? root;
  const session = `run-${n}-${ctx.nonce()}`;
  const log = join(runDirFor(root, n), "supervisor.log");
  const pid = await ctx.runs.startSupervisor({ issue: n, story, session, agent, worktree, log });
  // Recorded before returning, so a norn deliver asking again before the agent's take sees the run.
  writeRecord(root, { issue: n, story, session, agent, worktree, pid, pane: null, startedAt: ctx.now().toISOString(), state: "running", attempts: [] });
  return { ok: true, kind: "run-started", issue: n, story, step: item.step, agent, session, pid, worktree, log };
}

/** The caller's agent tool and terminal identity stay out of a run: it is a session of its own. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !/^(CLAUDE|HERDR_|AI_AGENT|CODEX_|NORN_SESSION)/.test(k)) out[k] = v;
  return out;
}

/**
 * A supervisor's environment: clean, but with herdr's socket, so it can make
 * panes and watch agents in the caller's herdr session. The caller's own
 * pane, tab and workspace stay out.
 */
export function supervisorEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out = cleanEnv(env);
  for (const [k, v] of Object.entries(env)) if (v !== undefined && /^HERDR_/.test(k) && !/^HERDR_(PANE|TAB|WORKSPACE)_ID$/.test(k)) out[k] = v;
  return out;
}

/** run.env for the agent's pane: a value `$NAME` is read from the supervisor's environment, and left out when it is not set there. */
export function paneEnv(run: Record<string, string>, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(run)) {
    const value = /^\$\w+$/.test(v) ? env[v.slice(1)] : v;
    if (value !== undefined) out[k] = value;
  }
  return out;
}

/** The herdr kind and arguments of an agent: from run.agents, else its name as herdr's kind, e.g. claude or codex. */
export function runAgent(agents: Record<string, RunAgent>, agent: string): RunAgent {
  return agents[agent] ?? { kind: agent, args: [] };
}

/** What a supervisor can be given in place of its defaults; tests pass a scripted driver and short ticks. */
export interface SuperviseOptions {
  driver?: AgentDriver;
  tickMs?: number;
  /** The environment run.env reads `$NAME` values from. */
  env?: Record<string, string | undefined>;
  /** The waits before each retry of a GitHub call the run cannot go on without. */
  retryMs?: number[];
  prompt: (n: number, worktree: string, previous: AttemptEnd | null) => string;
  log: (event: RunEvent) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A GitHub call the run cannot go on without, tried again after a failure, e.g. a network blip, before the supervisor gives up. */
async function retrying<T>(call: () => Promise<T>, log: (e: RunEvent) => void, waitsMs = [5000, 30_000, 120_000]): Promise<T> {
  for (const wait of waitsMs) {
    try {
      return await call();
    } catch (e) {
      log({ kind: "tick-failed", detail: (e as Error).message });
      await sleep(wait);
    }
  }
  return call();
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10;

/**
 * The supervisor itself: attempts until the step is finished, lost or
 * escalated, then a wake. `ctx.session` is the run's session. An agent that
 * stopped early but is still in its pane is nudged there, keeping its
 * context; otherwise a fresh agent starts in a new pane.
 */
export async function supervise(ctx: RunCtx, start: SupervisorStart, opts: SuperviseOptions): Promise<Exclude<Settlement, { kind: "retry" }>> {
  const root = ctx.workspace.root;
  const { issue: n, agent, worktree } = start;
  const { run } = ctx.config;
  const driver = opts.driver ?? herdrDriver({ herdr: ctx.runs.herdr, root, issue: n, agent: runAgent(run.agents, agent) });
  const tickMs = opts.tickMs ?? 5000;
  const recorded = readRecord(root, n);
  // A record of another session is an earlier run's, which this run must not carry on.
  const record: RunRecord = (recorded?.session === ctx.session ? recorded : null) ?? {
    issue: n,
    story: start.story,
    session: ctx.session,
    agent,
    worktree,
    pid: process.pid,
    pane: null,
    startedAt: ctx.now().toISOString(),
    state: "running",
    attempts: [],
  };
  record.pid = process.pid;
  writeRecord(root, record);
  const env = paneEnv(run.env, opts.env ?? {});
  let previous: AttemptEnd | null = null;
  let attempt: AgentAttempt | null = null;
  let notified = false;
  for (;;) {
    const number = record.attempts.length + 1;
    const prompt = opts.prompt(n, worktree, previous);
    const startedAt = Date.now();
    const commentsBefore = (await retrying(() => ctx.github.listComments(n), opts.log, opts.retryMs)).length;
    if (attempt && (await attempt.nudge(prompt))) opts.log({ kind: "nudged", attempt: number, pane: attempt.pane ?? "" });
    else {
      await attempt?.stop();
      attempt = await driver.start({
        prompt,
        worktree,
        session: ctx.session,
        env,
        log: join(runDirFor(root, n), `attempt-${number}.log`),
        onPane: (pane) => writeRecord(root, { ...record, pane }),
      });
      opts.log({ kind: "attempt-started", attempt: number, agent, pane: attempt.pane });
    }
    record.pane = attempt.pane;
    writeRecord(root, record);
    const beat = () => {
      record.beatAt = new Date().toISOString();
      writeRecord(root, record);
    };
    const watched = await watch(ctx, n, attempt, { tickMs, startedAt, alreadyNotified: notified, log: opts.log, beat });
    notified ||= watched.notified;
    const mins = minutes(Date.now() - startedAt);
    const settled = await retrying(() => settleRun(ctx, n, { end: watched.end, minutes: mins }, commentsBefore), opts.log, opts.retryMs);
    opts.log({ kind: "settled", attempt: number, end: watched.end, minutes: mins, settled });
    record.attempts.push({ startedAt: new Date(startedAt).toISOString(), end: watched.end, minutes: mins, settled: settled.kind });
    writeRecord(root, record);
    if (settled.kind === "retry") {
      previous = watched.end;
      continue;
    }
    // An escalated step keeps its agent, so the person called in finds its work and its question in the pane.
    if (settled.kind !== "escalated") await attempt.stop();
    record.state = settled.kind;
    record.finishedAt = ctx.now().toISOString();
    writeRecord(root, record);
    writeWake(root, {
      issue: n,
      story: start.story,
      session: ctx.session,
      settled,
      attempts: record.attempts.length,
      minutes: minutes(Date.now() - new Date(record.startedAt).getTime()),
      at: ctx.now().toISOString(),
    });
    return settled;
  }
}

/**
 * Watches one attempt until its agent's turn ends or a rule ends it: no
 * change on screen for stallAfter, longer than timeout, or blocked on a
 * person for blockedAfter. Time blocked counts toward neither the stall nor
 * the timeout. Renews the lease meanwhile, and stops the agent once the run
 * has lost the claim.
 */
async function watch(
  ctx: RunCtx,
  n: number,
  attempt: AgentAttempt,
  o: { tickMs: number; startedAt: number; alreadyNotified: boolean; log: (e: RunEvent) => void; beat: () => void },
): Promise<{ end: AttemptEnd; notified: boolean }> {
  const { run } = ctx.config;
  // Renewed well inside the lease, so one slow GitHub call cannot let it lapse.
  const renewEveryMs = Math.max(1000, Math.floor(run.leaseMs / 5));
  const turn: { end: AgentEnd | null } = { end: null };
  void attempt.ended().then((end) => {
    turn.end = end;
  });
  let notified = o.alreadyNotified;
  let takenOnce = false;
  let lastRenew = 0;
  let pausedMs = 0;
  let blockedSince: number | null = null;
  let resumedAt = 0;
  const tick = async (): Promise<AttemptEnd | { kind: "lost-claim" } | null> => {
    const look = await attempt.look();
    if (turn.end) return null;
    const now = Date.now();
    if (look.blocked) {
      if (blockedSince === null) {
        blockedSince = now;
        o.log({ kind: "blocked", pane: attempt.pane ?? "" });
        if (!notified && attempt.pane) {
          notified = true;
          await notifyRunBlocked(ctx, n, attempt.pane);
        }
      }
      if (now - blockedSince > run.blockedAfterMs) return { kind: "blocked", afterMs: run.blockedAfterMs };
    } else {
      if (blockedSince !== null) {
        pausedMs += now - blockedSince;
        resumedAt = now;
        blockedSince = null;
      }
      if (now - Math.max(look.activityAt, resumedAt) > run.stallAfterMs) return { kind: "stalled", afterMs: run.stallAfterMs };
      if (now - o.startedAt - pausedMs > run.timeoutMs) return { kind: "timed-out", afterMs: run.timeoutMs };
    }
    // Look for the agent's take on every tick, then renew on the lease's schedule.
    if (takenOnce && now - lastRenew < renewEveryMs) return null;
    const renewal = await renewLease(ctx, n, takenOnce);
    if (renewal === "lost") return { kind: "lost-claim" };
    if (renewal === "renewed") {
      if (!takenOnce) o.log({ kind: "taken" });
      takenOnce = true;
      lastRenew = now;
    }
    return null;
  };
  while (!turn.end) {
    await Promise.race([sleep(o.tickMs), attempt.ended()]);
    if (turn.end) break;
    o.beat();
    let verdict: AttemptEnd | { kind: "lost-claim" } | null = null;
    try {
      verdict = await tick();
    } catch (e) {
      o.log({ kind: "tick-failed", detail: (e as Error).message });
    }
    if (!verdict) continue;
    o.log({ kind: "stopping", why: verdict });
    // A blocked agent is left in its pane for the person the issue is escalated to.
    if (verdict.kind === "blocked") return { end: verdict, notified };
    await attempt.stop();
    const end = await attempt.ended();
    return { end: verdict.kind === "lost-claim" ? end : verdict, notified };
  }
  return { end: turn.end, notified };
}

/** Stops the agent of a run whose supervisor is gone, so it does not work on beside the run that takes the item over. */
export async function stopOrphan(herdr: Herdr, record: RunRecord) {
  if (record.pane) await closePane(herdr, record.pane);
}
