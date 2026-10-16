import { isStale } from "./claims.js";
import { send } from "./notify.js";
import { join } from "node:path";
import { branchAt, checkedOutElsewhere, createWorktreeCommand, locate } from "./location.js";
import { isWithin, type Provider } from "./workspace.js";
import type { GitHub, Issue } from "./github.js";
import { STATES, ambiguousStates, humanQaReason, kindOf, slicesOf, stateOf, stepFor, type State } from "./machine.js";
import { storySlug } from "./slug.js";
import { hhmm, storyBranch, wrap } from "./text.js";
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
  /** psdd runs inside the item's worktree, so this session can take it here. */
  here: boolean;
  /** Under plain git, the PSDD_SESSION to start the item's agent with, unique per listing, so each agent is its own session. */
  session: string | null;
}

export interface WaitItem {
  issue: number;
  reason: "blocked" | "needs-human" | "human-qa" | "held" | "owner-merge" | "no-state" | "ambiguous-state";
  detail: string;
  /** Under herdr, an item for a person is done in its worktree's pane: these say where, as for a StartItem. */
  branch?: string | null;
  worktree?: string | null;
  createWorktree?: string | null;
  checkedOutAt?: string | null;
  here?: boolean;
  /** An item for a person that a session holds: who, and since when. No hand-off is offered for it. */
  heldBy?: string;
  /** Held by one of the user's own sessions: an agent of theirs at work, using a parallel slot. */
  mine?: boolean;
}

export interface NextReport {
  story: number;
  provider: Provider;
  maxParallel: number;
  title: string;
  state: State | null;
  branch: string;
  slices: { total: number; merged: number };
  /** Housekeeping psdd did, e.g. closing a merged story. */
  notes: string[];
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

const DESCRIBE: Partial<Record<State, string>> = {
  "ready-for-agent": "is ready-for-agent",
  implementation: "is in implementation with no one holding it",
  "needs-review": "needs review",
  "changes-requested": "has changes requested",
  "needs-qa": "needs QA by an agent",
  "qa-failed": "failed QA",
  "merge-queue": "is in merge-queue",
};

/**
 * Catches the story up with what earlier commands left undone or could not do:
 * the story branch, moving on once every slice is merged, closing a merged
 * story and clearing state labels left on closed issues. Removing what closed
 * issues leave behind is psdd tidy's. Returns notes on what changed or failed.
 */
async function reconcile(ctx: Ctx, storyNumber: number): Promise<string[]> {
  const { github } = ctx;
  const notes: string[] = [];
  const story = await github.getIssue(storyNumber);
  if (story.state === "open" && stateOf(story) === "implementation") {
    const branch = await ensureStoryBranch(ctx, story).catch((e: Error) => ({
      ok: false as const,
      lines: [`Could not create the story branch: ${e.message}`],
    }));
    if (!branch.ok) notes.push(...branch.lines);
    else if (branch.created) notes.push(`Created the story branch ${branch.branch}.`);
  }
  notes.push(...(await bestEffort("move the story on", storyNumber, () => promoteStory(ctx, storyNumber))));
  notes.push(
    ...(await bestEffort("close the merged story", storyNumber, async () => {
      if (!(await closeMergedStory(ctx, story))) return [];
      story.state = "closed";
      story.labels = story.labels.filter((l) => !(STATES as readonly string[]).includes(l));
      return [`The story PR is merged. Closed story #${storyNumber}.`];
    })),
  );
  const closed = (await slicesOf(github, storyNumber)).filter((s) => s.state === "closed");
  if (story.state === "closed") closed.push(story);
  for (const issue of closed) {
    notes.push(
      ...(await bestEffort(`clear the labels of #${issue.number}`, storyNumber, async () => {
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
    const owner = story.assignees[0] ? `@${story.assignees[0]}` : "the story owner";
    report.waiting.push({
      issue: storyNumber,
      reason: "owner-merge",
      detail: `waits for its owner (${owner}) to merge the story PR into main`,
    });
    report.nothingLeft = true;
    return report;
  }
  for (const issue of [story, ...slices]) {
    if (issue.state !== "open") continue;
    await classify(ctx, issue, report);
  }
  report.nothingLeft = report.start.length === 0 && !report.waiting.some((w) => w.reason === "held");
  report.running = report.waiting.filter((w) => w.mine).length;
  report.slots = Math.max(0, ctx.config.maxParallel - report.running);
  // A person already at work on everything waiting for one needs no notice.
  report.notified &&= toNotify(report).length > 0 || !report.waiting.some((w) => w.heldBy);
  return report;
}

async function classify(ctx: Ctx, issue: Issue, report: NextReport) {
  const n = issue.number;
  const state = stateOf(issue);
  const ambiguous = ambiguousStates(issue);
  if (ambiguous) {
    report.waiting.push({ issue: n, reason: "ambiguous-state", detail: ambiguous });
    return;
  }
  if (issue.labels.includes("needs-human")) {
    const why = (await needsHumanReason(ctx.github, n)) ?? "see its latest comment";
    report.waiting.push({ issue: n, reason: "needs-human", detail: why, ...(await humanWork(ctx, issue)) });
    return;
  }
  // The state itself says a person is needed; their agent takes it with them.
  if (state === "needs-human-qa") {
    report.waiting.push({ issue: n, reason: "human-qa", detail: humanQaReason(issue), ...(await humanWork(ctx, issue)) });
    return;
  }
  if (!state) {
    // Not skipped silently: with no state psdd cannot brief it, and delivery must not report nothing left.
    report.waiting.push({ issue: n, reason: "no-state", detail: "has no state label; a person must set one" });
    return;
  }
  if (state === "blocked") {
    const open = (await ctx.github.blockedBy(n)).filter((b) => b.state === "open");
    report.waiting.push({ issue: n, reason: "blocked", detail: `is blocked by ${open.map((b) => `#${b.number}`).join(", ")}` });
    return;
  }
  const step = stepFor(issue);
  if (!step) return;
  const held = await heldBy(ctx, n);
  if (held) {
    report.waiting.push({ issue: n, reason: "held", detail: `is held by ${held.who}`, mine: held.mine });
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
    session: ctx.config.provider === "git" ? `psdd-${n}-${ctx.nonce()}` : null,
    kind: kindOf(issue) === "slice" ? "slice" : "story",
    title: issue.title,
    state,
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    command: `psdd take ${n}`,
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

/** The live claim on an item: which session holds it, and whether it is one of the user's. */
async function heldBy(ctx: Ctx, n: number) {
  const claim = await ctx.github.readClaim(n);
  if (!claim || isStale(claim, ctx.now(), ctx.config.staleAfterMs)) return null;
  const mine = claim.holder === (await ctx.github.currentUser());
  const who = claim.session === ctx.session ? "this session" : mine ? "another session of yours" : "another session";
  return { who: `${who} (since ${hhmm(claim.since)})`, mine };
}

/**
 * Where a person does their item: held by a session, it is being done there.
 * Otherwise, under herdr, in its worktree's pane, like every other step; elsewhere where they are.
 */
async function humanWork(ctx: Ctx, issue: Issue): Promise<Partial<WaitItem>> {
  const held = await heldBy(ctx, issue.number);
  if (held) return { heldBy: held.who };
  if (ctx.config.provider !== "herdr") return {};
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue);
  return { branch: loc?.branch ?? null, worktree, createWorktree, checkedOutAt, here };
}

/** How the user does an item for a person now: here, or with an agent in its worktree's pane. */
function humanHandOff(w: WaitItem): string[] {
  if (!w.worktree || w.heldBy) return [];
  if (w.here) return ["    You are in its worktree: if the user does it now, take it in this session."];
  if (w.checkedOutAt && w.branch) return [`    ${checkedOutElsewhere(w.branch, w.checkedOutAt)}`];
  return [
    "    If the user does it now, hand it to an agent in its worktree:",
    ...(w.createWorktree ? [`      Create the worktree: ${w.createWorktree}`] : []),
    `      herdr agent start psdd-${w.issue} --kind claude --pane <pane of ${w.worktree}>`,
    `      herdr agent prompt psdd-${w.issue} "drive ${w.issue}"`,
    `      herdr agent focus psdd-${w.issue}`,
  ];
}

/** What waits for a person, and who holds it if a session does. */
function humanDetail(w: WaitItem) {
  return `${w.detail}${w.heldBy ? `, held by ${w.heldBy}` : ""}`;
}

function waitLine(w: WaitItem) {
  // Inside its worktree this session is where the user does it, so it is not told off.
  const dont = w.here ? "" : " Do not take it.";
  if (w.reason === "needs-human") return `  - #${w.issue} needs a human: ${humanDetail(w)}.${dont}`;
  if (w.reason === "human-qa") return `  - #${w.issue} ${humanDetail(w)}.${dont}`;
  return `  - #${w.issue} ${w.detail}.`;
}

/** Waiting items only a person can move on. */
const FOR_HUMAN: WaitItem["reason"][] = ["needs-human", "human-qa", "owner-merge", "no-state", "ambiguous-state"];

function renderNothingLeft(r: NextReport): string {
  const human = r.waiting.filter((w) => FOR_HUMAN.includes(w.reason));
  const blocked = r.waiting.filter((w) => w.reason === "blocked");
  const out = [...r.notes, `Story #${r.story} "${r.title}": nothing left that you can do.`];
  if (human.length) out.push("Waiting for a human:", ...human.flatMap((w) => [`  - #${w.issue} ${humanDetail(w)}.`, ...humanHandOff(w)]));
  if (blocked.length) out.push("Blocked until then:", ...blocked.map(waitLine));
  out.push(`Stop here and report to the user.${r.notified ? " psdd has already notified them." : ""}`);
  return out.join("\n");
}

function runningNote(r: NextReport) {
  if (!r.running) return "";
  return ` (${r.running} of your agents ${r.running === 1 ? "is" : "are"} running, the limit is ${r.maxParallel})`;
}

export function renderNext(r: NextReport): string {
  if (r.closed) {
    return [...r.notes, `Story #${r.story} "${r.title}" is closed${r.notPlanned ? " as not planned" : ""}. Nothing left that you can do.`].join("\n");
  }
  if (r.nothingLeft) return renderNothingLeft(r);
  const out: string[] = [];
  if (r.notes.length) out.push(...r.notes, "");
  let head = `Story #${r.story} "${r.title}" is in ${r.state ?? "no state"}.`;
  if (r.slices.total) head += ` ${r.slices.merged} of ${r.slices.total} slices are merged into ${r.branch}.`;
  out.push(wrap(head), "");

  if (r.start.length === 0) {
    out.push(`Nothing can be started now. Wait for the running items to finish, then run psdd next ${r.story} again.`);
  } else if (r.slots === 0 && r.start.every((s) => !s.attended)) {
    const ready = `${r.start.length} item${r.start.length === 1 ? " is" : "s are"} ready`;
    out.push(
      wrap(
        `${ready}, but ${r.running} of your agents are running, the limit of deliver.maxParallel. Wait for one to finish, then run psdd next ${r.story} again.`,
      ),
      "",
      ...r.start.map((s) => `  - ${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}" ${DESCRIBE[s.state] ?? `is in ${s.state}`}.`),
    );
  } else {
    // Attended steps are done with the user, not by a fresh agent of their own.
    const attendedOnly = r.start.every((s) => s.attended);
    const count = `You can start ${r.start.length} item${r.start.length === 1 ? "" : "s"} now`;
    const agent = {
      herdr: "each as a new herdr agent in the item's worktree pane:",
      "claude-code": "each in its own fresh subagent, told to work in the item's worktree:",
      git: "each in a new agent session started in the item's worktree:",
    }[r.provider];
    out.push(
      attendedOnly
        ? `${count}, with the user:`
        : r.start.length === 1
          ? `${count}, ${agent.replace(/^each /, "")}`
          : wrap(`${count}. They are independent, so run them in parallel, at most ${r.slots} at a time${runningNote(r)}, ${agent}`),
      "",
    );
    for (const s of r.start) {
      const what = `${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}"`;
      const desc =
        s.kind === "story" && !DESCRIBE[s.state]
          ? `is in ${s.state}: ${s.step}${s.attended ? " (attended: the user takes part)" : ""}.`
          : `${DESCRIBE[s.state] ?? `is in ${s.state}`}${s.attended ? " (attended: the user takes part)" : ""}.`;
      out.push(`  - ${what} ${desc}`);
      if (s.worktree) out.push(`    Worktree: ${s.worktree}`);
      if (s.createWorktree) out.push(`    Create the worktree: ${s.createWorktree}`);
      if (s.checkedOutAt && s.branch) out.push(`    ${checkedOutElsewhere(s.branch, s.checkedOutAt)}`);
      if (r.provider === "herdr" && s.worktree) {
        const start = `herdr agent start psdd-${s.issue} --kind claude --pane <pane of ${s.worktree}>`;
        if (!s.attended) {
          const prompt = `Work in ${s.worktree}. Run psdd take ${s.issue}, follow its briefing to the end, and finish with the psdd command it gives.`;
          out.push(`    Start an agent: ${start}`, `    Then prompt it: herdr agent prompt psdd-${s.issue} "${prompt}"`);
        } else if (s.here) out.push("    You are in its worktree: take it in this session.");
        else {
          // An attended step needs the user, so the new agent drives the story from its worktree and this session stops.
          out.push(
            "    Hand the story to an agent in its worktree, which drives it on with the user:",
            `      ${start}`,
            `      herdr agent prompt psdd-${s.issue} "drive ${r.story}"`,
            `      herdr agent focus psdd-${s.issue}`,
          );
        }
      }
      if (s.session && s.worktree) out.push(`    Start an agent in ${s.worktree} with PSDD_SESSION=${s.session} set.`);
      out.push(`    Start it with: ${s.command}`);
    }
  }
  if (r.waiting.length) {
    out.push("", "Waiting, nothing to do for you:");
    for (const w of r.waiting) out.push(waitLine(w), ...humanHandOff(w));
  }
  if (r.start.some((s) => !s.attended)) out.push("", `Each phase gets a new agent. When an item is done, run psdd next ${r.story} again.`);
  return out.join("\n");
}

/** Refusal when n is not a story. */
export async function notAStory(github: GitHub, n: number): Promise<string[] | null> {
  const issue = await github.getIssue(n);
  if (kindOf(issue) === "story") return null;
  if (kindOf(issue) === "slice") {
    const p = await github.parentOf(n);
    return [`#${n} is a slice${p ? ` of story #${p}. Run psdd next ${p}` : ""} instead.`];
  }
  return [`#${n} is not a story yet. Triage it first with: psdd take ${n}`];
}

/** Delivery stops: tell the user what waits for them. */
/** What waits for a person that no session holds. */
function toNotify(r: NextReport) {
  return r.waiting.filter((w) => FOR_HUMAN.includes(w.reason) && !w.heldBy);
}

export async function notifyWaiting(ctx: Ctx, r: NextReport) {
  if (!r.notified) return;
  const waiting = toNotify(r);
  await send(ctx, {
    title: `psdd: story #${r.story} is waiting for you`,
    body: waiting.map((w) => `#${w.issue} ${w.detail}`).join("\n") || "Nothing left to do on the story.",
  });
}
