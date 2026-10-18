import { acquire } from "./claims.js";
import { escalate, release } from "./operations.js";
import { type Ctx, NEEDS_HUMAN_MARK, parseTransitionComment } from "./transitions.js";

/**
 * A run: one item's step done by an agent that norn starts and watches, so the
 * agent never has to keep itself alive. This module is the policy, read from
 * and written to GitHub; the supervisor process that starts and watches the
 * agent lives with the CLI.
 */

/** The marker norn writes when a run's attempt ended without finishing its step. */
export const RUN_MARK = "norn: run — ";

/** How one attempt's agent ended, as the supervisor saw it. */
export type AttemptEnd =
  /** The agent's process exited. */
  | { kind: "exited"; code: number | null; signal: string | null }
  /** The agent could not be started at all; `detail` is the tool's own error. */
  | { kind: "not-started"; detail: string }
  /** The agent's turn ended with the agent still there, e.g. idle or done in its pane. */
  | { kind: "stopped-early"; state: string }
  /** The agent, or the pane it ran in, went away: closed, crashed or quit. */
  | { kind: "gone"; what: "pane" | "agent" }
  /** The supervisor stopped it: its screen did not change for `afterMs`. */
  | { kind: "stalled"; afterMs: number }
  /** The supervisor stopped it: it ran longer than `afterMs`. */
  | { kind: "timed-out"; afterMs: number }
  /** It waited on a person for `afterMs`, e.g. at a dialog no one answered. */
  | { kind: "blocked"; afterMs: number };

/** An attempt's end and how long the attempt ran. */
export interface Attempt {
  end: AttemptEnd;
  minutes: number;
}

/** What the supervisor does after an attempt. */
export type Settlement =
  /** The agent finished the step: norn done, escalate or release gave the claim up with the issue moved on. */
  | { kind: "finished" }
  /** Another session holds the claim now, e.g. after the lease ran out. The run stops. */
  | { kind: "lost"; holder: string; session: string }
  /** The step is not done; the attempt is recorded on the issue and the run tries again. */
  | { kind: "retry"; attempts: number; end: AttemptEnd }
  /** The step is not done and the attempt budget is spent, or the agent waited on a person too long: the issue needs a human. */
  | { kind: "escalated"; attempts: number; end: AttemptEnd };

const minutesOf = (ms: number) => Math.round(ms / 6000) / 10;

/** An attempt's end as norn writes it on the issue. */
export function attemptEndText(end: AttemptEnd): string {
  switch (end.kind) {
    case "exited":
      return end.signal ? `the agent was killed by ${end.signal}` : `the agent exited ${end.code} without finishing its step`;
    case "not-started":
      return `the agent could not start: ${end.detail.replace(/\s+/g, " ").trim()}`;
    case "stopped-early":
      return `the agent stopped (${end.state}) without finishing its step`;
    case "gone":
      return `the agent's herdr ${end.what} went away`;
    case "stalled":
      return `stalled: its screen did not change for ${minutesOf(end.afterMs)}m`;
    case "timed-out":
      return `timed out after ${minutesOf(end.afterMs)}m`;
    case "blocked":
      return `the agent waited for a person for ${minutesOf(end.afterMs)}m`;
  }
}

/**
 * Attempts at the current step that ended without finishing it, read from
 * norn's run comments: those since the last transition or needs-human, so a
 * new step, or a person resolving an escalation, starts a fresh budget.
 */
export function abandonedAttempts(comments: string[]): number {
  let n = 0;
  for (const body of comments) {
    if (body.startsWith(RUN_MARK)) n++;
    else if (parseTransitionComment(body) || body.startsWith(NEEDS_HUMAN_MARK)) n = 0;
  }
  return n;
}

/** Whether a comment says a step ended: a transition norn done made, or an escalation. */
function endsStep(body: string) {
  return parseTransitionComment(body) !== null || body.startsWith(NEEDS_HUMAN_MARK);
}

/**
 * After an attempt, GitHub says what happened, never the agent's own state.
 * Another session holds the claim: the run lost it. No claim, and the issue
 * closed or a transition or escalation written since the attempt began, when
 * it had `commentsBefore` comments: the step is finished. Labels alone do not
 * say so, since norn take moves them too. Otherwise the step is not done (the
 * agent stopped holding the claim, gave it up without a transition, or never
 * took it): the attempt is recorded on the issue under the run's claim, and
 * the run tries again, or escalates once `maxAttempts` are spent or when the
 * agent waited on a person too long, since that dialog would only come back.
 * `ctx.session` is the run's session.
 */
export async function settleRun(ctx: Ctx, n: number, attempt: Attempt, commentsBefore: number): Promise<Settlement> {
  const { github } = ctx;
  const claim = await github.readClaim(n);
  if (claim && claim.session !== ctx.session) return { kind: "lost", holder: claim.holder, session: claim.session };
  if (!claim) {
    const issue = await github.getIssue(n);
    if (issue.state === "closed" || (await github.listComments(n)).slice(commentsBefore).some(endsStep)) return { kind: "finished" };
    // Nothing moved: take the claim back to record the attempt, and carry on under it.
    const got = await acquire(
      github,
      n,
      { holder: await github.currentUser(), session: ctx.session, since: ctx.now().toISOString(), leaseMs: ctx.config.run.leaseMs },
      ctx.now(),
      ctx.config.staleAfterMs,
    );
    if (!got.ok) return got.held ? { kind: "lost", holder: got.held.holder, session: got.held.session } : { kind: "finished" };
  }
  const { maxAttempts } = ctx.config.run;
  const attempts = abandonedAttempts(await github.listComments(n)) + 1;
  await github.comment(n, `${RUN_MARK}attempt ${attempts} of ${maxAttempts}: ${attemptEndText(attempt.end)}, after ${attempt.minutes}m`);
  if (attempts < maxAttempts && attempt.end.kind !== "blocked") return { kind: "retry", attempts, end: attempt.end };
  const why =
    attempt.end.kind === "blocked"
      ? `the run's agent waited for a person in its herdr pane for ${minutesOf(attempt.end.afterMs)}m; answer it there or take the issue over`
      : `${attempts} runs ended without finishing the step; the last: ${attemptEndText(attempt.end)}`;
  const r = await escalate(ctx, n, why);
  // The claim was the run's a moment ago; if escalate is refused it was lost in between, so release is a no-op.
  if (!r.ok) await release(ctx, n);
  return { kind: "escalated", attempts, end: attempt.end };
}

/** What renewing a run's lease found. */
export type Renewal = "renewed" | "not-taken" | "released" | "lost";

/**
 * Keeps the run's claim fresh while its agent lives, with the run's own
 * short lease. Before the agent's norn take there is no claim of the run's
 * session yet, and another session's claim is one the agent may be about to
 * take over as stale, so it is not the run's to lose. Once taken: gone means
 * the agent gave it up, e.g. with norn done; another session's means the run
 * lost it and must stop its agent.
 */
export async function renewLease(ctx: Ctx, n: number, takenOnce: boolean): Promise<Renewal> {
  const claim = await ctx.github.readClaim(n);
  if (!claim) return takenOnce ? "released" : "not-taken";
  if (claim.session !== ctx.session) return takenOnce ? "lost" : "not-taken";
  const ok = await ctx.github.replaceClaim(n, claim.sha, {
    holder: claim.holder,
    session: claim.session,
    since: ctx.now().toISOString(),
    leaseMs: ctx.config.run.leaseMs,
  });
  if (ok) return "renewed";
  // The ref moved under the renewal: often the agent itself, refreshing it with norn take or giving it up with norn done.
  const now = await ctx.github.readClaim(n);
  if (!now) return "released";
  return now.session === ctx.session ? "renewed" : "lost";
}
