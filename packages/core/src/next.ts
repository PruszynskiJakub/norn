import { isStale } from "./claims.js";
import type { Event } from "./events.js";
import { send } from "./notify.js";
import { join } from "node:path";
import { branchAt, createWorktreeCommand, locate } from "./location.js";
import { isWithin, type Provider } from "./workspace.js";
import type { GitHub, Issue } from "./github.js";
import { STATES, kindOf, slicesOf, stateOf, statesOf, stepFor, type State } from "./machine.js";
import { storySlug } from "./slug.js";
import { storyBranch } from "./text.js";
import { bestEffort, clearClosedState, closeMergedStory, ensureStoryBranch, needsHumanReason, promoteStory, syncBlocked, type Ctx } from "./transitions.js";

export interface StartItem {
  issue: number;
  kind: "story" | "slice";
  title: string;
  state: State;
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

/** The live claim on an item: which session holds it, since when, and whether it is one of the user's. */
export interface Holder {
  session: "this" | "yours" | "other";
  mine: boolean;
  since: string;
}

/** Under herdr, an item for a person is done in its worktree's pane: these say where, as for a StartItem. */
export interface HumanPlace {
  branch?: string | null;
  worktree?: string | null;
  createWorktree?: string | null;
  checkedOutAt?: string | null;
  here?: boolean;
  /** An item for a person that a session holds. No hand-off is offered for it. */
  heldBy?: Holder;
}

export type WaitItem = { issue: number } & (
  | { reason: "blocked"; blockers: number[] }
  /** `why` is the reason norn recorded when it set needs-human, as written; null when none is found. */
  | ({ reason: "needs-human"; why: string | null } & HumanPlace)
  | ({ reason: "human-qa"; of: "story" | "mode:hil" } & HumanPlace)
  /** Held by one of the user's own sessions (`holder.mine`): an agent of theirs at work, using a parallel slot. */
  | { reason: "held"; holder: Holder }
  | { reason: "owner-merge"; owner: string | null; into: string }
  | { reason: "no-state" }
  | { reason: "ambiguous-state"; states: State[] }
);

export interface NextReport {
  story: number;
  provider: Provider;
  maxParallel: number;
  title: string;
  state: State | null;
  branch: string;
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
  /** The user's agents at work on the story, and how many more may start under deliver.maxParallel. */
  running: number;
  slots: number;
  start: StartItem[];
  waiting: WaitItem[];
}

/**
 * Catches the story up with what earlier commands left undone or could not do:
 * the story branch, moving on once every slice is merged, closing a merged
 * story and clearing state labels left on closed issues. Removing what closed
 * issues leave behind is norn tidy's. Returns what changed or failed.
 */
async function reconcile(ctx: Ctx, storyNumber: number): Promise<Event[]> {
  const { github } = ctx;
  const notes: Event[] = [];
  const story = await github.getIssue(storyNumber);
  if (story.state === "open" && stateOf(story) === "implementation") {
    try {
      const branch = await ensureStoryBranch(ctx, story);
      if (!branch.ok) notes.push(branch.refusal);
      else if (branch.created) notes.push({ kind: "story-branch-created", branch: branch.branch });
    } catch (e) {
      notes.push({ kind: "story-branch-failed", detail: (e as Error).message });
    }
  }
  notes.push(...(await bestEffort("move-story-on", storyNumber, storyNumber, () => promoteStory(ctx, storyNumber))));
  notes.push(
    ...(await bestEffort("close-merged-story", storyNumber, storyNumber, async () => {
      if (!(await closeMergedStory(ctx, story))) return [];
      story.state = "closed";
      story.labels = story.labels.filter((l) => !(STATES as readonly string[]).includes(l));
      return [{ kind: "story-closed", story: storyNumber }];
    })),
  );
  const closed = (await slicesOf(github, storyNumber)).filter((s) => s.state === "closed");
  if (story.state === "closed") closed.push(story);
  for (const issue of closed) {
    notes.push(
      ...(await bestEffort("clear-labels", issue.number, storyNumber, async () => {
        await clearClosedState(ctx, issue);
        return [];
      })),
    );
  }
  return notes;
}

/** What can be done on a story now. Syncs blocked labels and catches up on housekeeping first. */
export async function computeNext(ctx: Ctx, storyNumber: number): Promise<NextReport> {
  const { github } = ctx;
  await syncBlocked(ctx, storyNumber);
  const notes = await reconcile(ctx, storyNumber);
  const story = await github.getIssue(storyNumber);
  const slices = await slicesOf(github, storyNumber);
  const report: NextReport = {
    story: storyNumber,
    provider: ctx.config.provider,
    maxParallel: ctx.config.maxParallel,
    title: story.title,
    // A closed story has no state, whatever labels GitHub left on it.
    state: story.state === "closed" ? null : stateOf(story),
    branch: storyBranch(storyNumber, await storySlug(ctx, story)),
    slices: { total: slices.length, merged: slices.filter((s) => s.state === "closed").length },
    start: [],
    waiting: [],
    notes,
    nothingLeft: false,
    closed: story.state === "closed",
    notPlanned: story.stateReason === "not_planned",
    notified: ctx.config.notifications !== null,
    running: 0,
    slots: ctx.config.maxParallel,
  };
  if (report.closed) {
    report.nothingLeft = true;
    return report;
  }
  if (stateOf(story) === "merge-queue") {
    report.waiting.push({ issue: storyNumber, reason: "owner-merge", owner: story.assignees[0] ?? null, into: ctx.config.baseBranch });
    report.nothingLeft = true;
    return report;
  }
  for (const issue of [story, ...slices]) {
    if (issue.state !== "open") continue;
    await classify(ctx, issue, report);
  }
  report.nothingLeft = report.start.length === 0 && !report.waiting.some((w) => w.reason === "held");
  report.running = report.waiting.filter((w) => w.reason === "held" && w.holder.mine).length;
  report.slots = Math.max(0, ctx.config.maxParallel - report.running);
  // A person already at work on everything waiting for one needs no notice.
  report.notified &&= toNotify(report).length > 0 || !report.waiting.some((w) => "heldBy" in w && w.heldBy);
  return report;
}

async function classify(ctx: Ctx, issue: Issue, report: NextReport) {
  const n = issue.number;
  const state = stateOf(issue);
  const states = statesOf(issue);
  if (states.length > 1) {
    report.waiting.push({ issue: n, reason: "ambiguous-state", states });
    return;
  }
  if (issue.labels.includes("needs-human")) {
    report.waiting.push({ issue: n, reason: "needs-human", why: await needsHumanReason(ctx.github, n), ...(await humanWork(ctx, issue)) });
    return;
  }
  // The state itself says a person is needed; their agent takes it with them.
  if (state === "needs-human-qa") {
    report.waiting.push({ issue: n, reason: "human-qa", of: kindOf(issue) === "story" ? "story" : "mode:hil", ...(await humanWork(ctx, issue)) });
    return;
  }
  if (!state) {
    // Not skipped silently: with no state norn cannot brief it, and delivery must not report nothing left.
    report.waiting.push({ issue: n, reason: "no-state" });
    return;
  }
  if (state === "blocked") {
    const open = (await ctx.github.blockedBy(n)).filter((b) => b.state === "open");
    report.waiting.push({ issue: n, reason: "blocked", blockers: open.map((b) => b.number) });
    return;
  }
  const step = stepFor(issue);
  if (!step) return;
  const held = await heldBy(ctx, n);
  if (held) {
    report.waiting.push({ issue: n, reason: "held", holder: held });
    return;
  }
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue);
  report.start.push({
    issue: n,
    branch: loc?.branch ?? null,
    worktree,
    createWorktree,
    checkedOutAt,
    here,
    // Fresh for every agent: a new agent on an item whose claim went stale must not pass for the old holder.
    session: ctx.config.provider === "git" ? `norn-${n}-${ctx.nonce()}` : null,
    kind: kindOf(issue) === "slice" ? "slice" : "story",
    title: issue.title,
    state,
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    command: `norn take ${n}`,
  });
}

/** Where an item is worked on: its worktree, and whether it must be made first or is checked out elsewhere. */
async function place(ctx: Ctx, issue: Issue) {
  const loc = await locate(issue, ctx);
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
async function humanWork(ctx: Ctx, issue: Issue): Promise<HumanPlace> {
  const held = await heldBy(ctx, issue.number);
  if (held) return { heldBy: held };
  if (ctx.config.provider !== "herdr") return {};
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue);
  return { branch: loc?.branch ?? null, worktree, createWorktree, checkedOutAt, here };
}

/** Waiting items only a person can move on. */
export const FOR_HUMAN: WaitItem["reason"][] = ["needs-human", "human-qa", "owner-merge", "no-state", "ambiguous-state"];

/** Why next refuses: n is not a story. */
export type NotAStory = { kind: "is-a-slice"; issue: number; story: number | null } | { kind: "not-a-story"; issue: number };

export async function notAStory(github: GitHub, n: number): Promise<NotAStory | null> {
  const issue = await github.getIssue(n);
  if (kindOf(issue) === "story") return null;
  if (kindOf(issue) === "slice") return { kind: "is-a-slice", issue: n, story: await github.parentOf(n) };
  return { kind: "not-a-story", issue: n };
}

/** What waits for a person that no session holds. */
function toNotify(r: NextReport) {
  return r.waiting.filter((w) => FOR_HUMAN.includes(w.reason) && !("heldBy" in w && w.heldBy));
}

/** Delivery stops: tell the user what waits for them. */
export async function notifyWaiting(ctx: Ctx, r: NextReport) {
  if (!r.notified) return;
  await send(ctx, { kind: "story-waiting", story: r.story, waiting: toNotify(r) });
}
