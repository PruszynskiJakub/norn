import { isStale } from "./claims.js";
import { type Delivery, heldDelivery } from "./delivery.js";
import type { Event } from "./events.js";
import { send } from "./notify.js";
import { join } from "node:path";
import { branchAt, createWorktreeCommand, locate } from "./location.js";
import { isWithin, type Provider } from "./workspace.js";
import type { GitHub, Issue } from "./github.js";
import type { NextRefusal } from "./refusals.js";
import { gateOf, heldInput, heldWaiting, holds, inFlowOf, needsBranch, reconcileState, releaseBlocked, slicesOf } from "./behaviours.js";
import { type Flow, flowStatesOf, flowStep, type NamedFlow, usedIn, uses } from "./flow.js";
import { flowOf, validFlow } from "./flow-loading.js";
import type { LoadedFlow } from "./flow-validation.js";
import type { Holder, HumanPlace, WaitItem } from "./waiting.js";
import type { Step } from "./machine.js";
import {
  bestEffort,
  clearClosedState,
  type Ctx,
  ensureOwnBranch,
  leftState,
  needsHumanReason,
  type Settled,
  settleLeftState,
  withShortClaim,
} from "./transitions.js";

export interface StartItem {
  issue: number;
  /** An issue of a repository flow is an `issue`. */
  kind: "story" | "slice" | "issue";
  /** The flow the item runs, its type, e.g. story or bug. */
  flow: string;
  title: string;
  state: string;
  /** What the state means, as its flow describes it, e.g. "Waiting for review"; null when the flow gives no description. */
  description: string | null;
  step: string;
  skill: string;
  attended: boolean;
  command: string;
  branch: string | null;
  worktree: string | null;
  /** Under herdr, the agent starts in the worktree's pane, so the worktree is made first. */
  createWorktree: string | null;
  /** Under herdr, where the item's branch is checked out instead, so no worktree can be made for it. */
  checkedOutAt: string | null;
  /** norn runs inside the item's worktree, so this session can take it here. */
  here: boolean;
  /** Under plain git, the NORN_SESSION to start the item's agent with, unique per listing, so each agent is its own session. */
  session: string | null;
}

export interface NextReport {
  /** The issue next is about: a story with its slices, or an issue of any other flow. */
  issue: number;
  /** The flow the issue runs, its type, e.g. story or bug. */
  flow: string;
  provider: Provider;
  maxParallel: number;
  title: string;
  state: string | null;
  /** The story's branch; for an issue of a flow, its own, or null without a workspace. */
  branch: string | null;
  slices: { total: number; merged: number };
  /** Housekeeping norn did, e.g. closing a merged story, or could not do. */
  notes: Event[];
  /** Nothing can start and nothing is running: only people can move the story on, or the story is closed. */
  nothingLeft: boolean;
  /** The story is closed: merged, or closed as not planned. Nothing waits for anyone. */
  closed: boolean;
  notPlanned: boolean;
  /** Notifications are on and something no one holds waits for a person, so the user has been told. */
  notified: boolean;
  /** The session delivering the story under its delivery lock; null when none does. */
  delivery: Delivery | null;
  /** The user's agents at work on the story, and how many more may start under deliver.maxParallel. */
  running: number;
  slots: number;
  start: StartItem[];
  waiting: WaitItem[];
}

/**
 * Catches the issue up with what earlier commands left undone or could not do:
 * its own branch, what the behaviours of its state do on their own, e.g. moving
 * on once every slice is merged or closing it once its PR is merged, and
 * clearing state labels left on closed issues. Removing what closed issues
 * leave behind is norn tidy's. Returns what changed or failed.
 */
async function reconcile(ctx: Ctx, n: number, named: NamedFlow): Promise<Event[]> {
  const { github } = ctx;
  const { flow } = named;
  const notes: Event[] = [];
  const issue = await github.getIssue(n);
  const held = issue.state === "open" ? heldInput(ctx, issue, named) : null;
  if (held && needsBranch(flow, held.state)) {
    try {
      const branch = await ensureOwnBranch(ctx, issue);
      if (!branch.ok) notes.push(branch.refusal);
      else if (branch.created) notes.push({ kind: "story-branch-created", flow: named.name, branch: branch.branch });
    } catch (e) {
      notes.push({ kind: "story-branch-failed", flow: named.name, detail: (e as Error).message });
    }
  }
  if (held) notes.push(...(await reconcileState(held)));
  const closed = (await slicesOf(github, n, flow)).filter((s) => s.state === "closed");
  if (issue.state === "closed") closed.push(issue);
  for (const i of closed) {
    notes.push(
      ...(await bestEffort("clear-labels", i.number, n, async () => {
        await clearClosedState(ctx, i, i === issue ? flow : validFlow(await flowOf(ctx, i)));
        return [];
      })),
    );
  }
  return notes;
}

/**
 * What can be done on an issue of a flow now: on the issue itself and, for
 * one with slices, on each of them. Syncs blocked labels and catches up on
 * housekeeping first. An issue of a broken flow waits for a person to fix it.
 */
export async function computeNext(ctx: Ctx, n: number, loaded: LoadedFlow): Promise<NextReport> {
  const { github } = ctx;
  const flow = validFlow(loaded);
  // An issue with slices is a story: next runs it with its slices.
  const story = flow !== null && usedIn(flow, "slices");
  if (story) await releaseBlocked(ctx, n);
  const notes = loaded.ok ? await reconcile(ctx, n, loaded) : [];
  const issue = await github.getIssue(n);
  const slices = flow ? await slicesOf(github, n, flow) : [];
  const loc = flow ? await locate(issue, ctx, flow) : null;
  const report: NextReport = {
    issue: n,
    flow: loaded.name,
    provider: ctx.config.provider,
    maxParallel: ctx.config.maxParallel,
    title: issue.title,
    // A closed issue has no state, whatever labels GitHub left on it.
    state: issue.state === "closed" || !flow ? null : (flowStatesOf(issue, flow)[0] ?? null),
    branch: loc?.branch ?? null,
    slices: { total: slices.length, merged: slices.filter((s) => s.state === "closed").length },
    start: [],
    waiting: [],
    notes,
    nothingLeft: false,
    closed: issue.state === "closed",
    notPlanned: issue.stateReason === "not_planned",
    notified: ctx.config.notifications !== null,
    running: 0,
    slots: ctx.config.maxParallel,
    delivery: (await heldDelivery(ctx, n))?.delivery ?? null,
  };
  if (report.closed) {
    report.nothingLeft = true;
    return report;
  }
  // A broken flow cannot run: a person fixes it first.
  if (!loaded.ok) report.waiting.push({ issue: n, reason: "flow-invalid", flow: loaded.name, errors: loaded.errors });
  else await classifyInFlow(ctx, issue, report, loaded, story ? "story" : "issue");
  for (const slice of slices) {
    if (slice.state !== "open") continue;
    await classify(ctx, slice, report);
  }
  report.nothingLeft = report.start.length === 0 && !report.waiting.some((w) => w.reason === "held");
  report.running = report.waiting.filter((w) => w.reason === "held" && w.holder.mine).length;
  report.slots = Math.max(0, ctx.config.maxParallel - report.running);
  // A person already at work on everything waiting for one needs no notice.
  report.notified &&= toNotify(report).length > 0 || !report.waiting.some((w) => "heldBy" in w && w.heldBy);
  return report;
}

/** Sorts one of the story's slices between people and agents: it runs its own flow. */
async function classify(ctx: Ctx, issue: Issue, report: NextReport) {
  const loaded = await flowOf(ctx, issue);
  if (!loaded) return;
  if (!loaded.ok) {
    report.waiting.push({ issue: issue.number, reason: "flow-invalid", flow: loaded.name, errors: loaded.errors });
    return;
  }
  await classifyInFlow(ctx, issue, report, loaded, "slice");
}

/**
 * Sorts an issue of a flow between people and agents: a human gate and
 * needs-human wait for a person, a state that holds it waits for its blockers,
 * any other state is offered to start, attended or not as the state says.
 * `kind` is how it is offered: a slice of the story, or an issue on its own.
 */
async function classifyInFlow(ctx: Ctx, issue: Issue, report: NextReport, named: NamedFlow, kind: StartItem["kind"]) {
  const { name, flow } = named;
  const n = issue.number;
  const states = flowStatesOf(issue, flow);
  if (states.length > 1) {
    report.waiting.push({ issue: n, reason: "ambiguous-state", states });
    return;
  }
  if (issue.labels.includes("needs-human")) {
    report.waiting.push({ issue: n, reason: "needs-human", why: await needsHumanReason(ctx.github, n), ...(await humanWork(ctx, issue, flow)) });
    return;
  }
  const state = states[0];
  if (state === undefined) {
    const left = await leftState(ctx, issue, flow);
    if (left === null) {
      report.waiting.push({ issue: n, reason: "no-state" });
      return;
    }
    // As take does: the rename is followed, or a person decides where the issue goes; then it is sorted where it landed.
    let settled: Settled | null = null;
    const claimed = await withShortClaim(ctx, n, async () => {
      settled = await settleLeftState(ctx, issue, named);
    });
    if (!claimed) {
      report.waiting.push({ issue: n, reason: "state-left", state: left, flow: name });
      return;
    }
    if (settled) report.notes.push(settled);
    await classifyInFlow(ctx, issue, report, named, kind);
    return;
  }
  if (uses(flow, state, "humanGate")) {
    report.waiting.push({ issue: n, reason: "human-qa", gate: gateOf(named, state), ...(await humanWork(ctx, issue, flow)) });
    return;
  }
  if (holds(flow, state)) {
    // What holds it says what it waits for, if anything a listing needs.
    const item = await heldWaiting({ ...inFlowOf(ctx, issue, named), state });
    if (item) report.waiting.push(item);
    return;
  }
  const step = flowStep(issue, flow);
  if (!step) return;
  await offer(ctx, issue, report, { kind, state, step, named });
}

/** Lists an item to start, or as held when a live claim is on it. */
async function offer(
  ctx: Ctx,
  issue: Issue,
  report: NextReport,
  { kind, state, step, named }: { kind: StartItem["kind"]; state: string; step: Step; named: NamedFlow },
) {
  const { flow } = named;
  const n = issue.number;
  const held = await heldBy(ctx, n);
  if (held) {
    report.waiting.push({ issue: n, reason: "held", holder: held });
    return;
  }
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue, flow);
  report.start.push({
    issue: n,
    branch: loc?.branch ?? null,
    worktree,
    createWorktree,
    checkedOutAt,
    here,
    // Fresh for every agent: a new agent on an item whose claim went stale must not pass for the old holder.
    session: ctx.config.provider === "git" ? `norn-${n}-${ctx.nonce()}` : null,
    kind,
    flow: named.name,
    title: issue.title,
    state,
    description: flow?.states[state]?.description ?? null,
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    command: `norn take ${n}`,
  });
}

/** Where an item is worked on: its worktree, and whether it must be made first or is checked out elsewhere. */
async function place(ctx: Ctx, issue: Issue, flow: Flow | null = null) {
  const loc = await locate(issue, ctx, flow);
  const worktree = loc ? join(ctx.workspace.root, loc.worktree) : null;
  const here = worktree !== null && isWithin(ctx.workspace.cwd, worktree);
  let createWorktree: string | null = null;
  let checkedOutAt: string | null = null;
  // Under herdr and plain git the agent starts in the worktree, so it is made first; a Claude Code subagent makes it from its briefing.
  if (loc && ctx.config.provider !== "claude-code" && !(await ctx.workspace.worktreeExists(loc.worktree))) {
    checkedOutAt = await ctx.workspace.branchCheckedOutAt(loc.branch);
    if (!checkedOutAt) {
      createWorktree = createWorktreeCommand(ctx.config.provider, loc, ctx.workspace.root, await branchAt(loc, ctx.workspace, ctx.github));
    }
  }
  return { loc, worktree, createWorktree, checkedOutAt, here };
}

/** The live claim on an item, if any. */
async function heldBy(ctx: Ctx, n: number): Promise<Holder | null> {
  const claim = await ctx.github.readClaim(n);
  if (!claim || isStale(claim, ctx.now(), ctx.config.staleAfterMs)) return null;
  const mine = claim.holder === (await ctx.github.currentUser());
  return { session: claim.session === ctx.session ? "this" : mine ? "yours" : "other", mine, since: claim.since };
}

/**
 * Where a person does their item: held by a session, it is being done there.
 * Otherwise, under herdr, in its worktree's pane, like every other step; elsewhere where they are.
 */
async function humanWork(ctx: Ctx, issue: Issue, flow: Flow | null = null): Promise<HumanPlace> {
  const held = await heldBy(ctx, issue.number);
  if (held) return { heldBy: held };
  if (ctx.config.provider !== "herdr") return {};
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue, flow);
  return { branch: loc?.branch ?? null, worktree, createWorktree, checkedOutAt, here };
}

/** Waiting items only a person can move on. */
export const FOR_HUMAN: WaitItem["reason"][] = ["needs-human", "human-qa", "owner-merge", "no-state", "ambiguous-state", "state-left", "flow-invalid"];

/** Why next refuses the issue, of `loaded` flow: one with no flow yet, or one that works in its parent's branch, which moves on with it. */
export async function nextRefusal(github: GitHub, issue: Issue, loaded: LoadedFlow | null): Promise<NextRefusal | null> {
  const n = issue.number;
  if (loaded?.ok && loaded.flow.workspace === "parent") return { kind: "is-a-slice", issue: n, flow: loaded.name, story: await github.parentOf(n) };
  return loaded ? null : { kind: "not-a-story", issue: n };
}

/** What waits for a person that no session holds. */
function toNotify(r: NextReport) {
  return r.waiting.filter((w) => FOR_HUMAN.includes(w.reason) && !("heldBy" in w && w.heldBy));
}

/** Delivery stops: tell the user what waits for them. */
export async function notifyWaiting(ctx: Ctx, r: NextReport) {
  if (!r.notified) return;
  await send(ctx, { kind: "story-waiting", story: r.issue, flow: r.flow, waiting: toNotify(r) });
}
