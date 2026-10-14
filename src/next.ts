import { isStale } from "./claims.js";
import { createWorktreeCommand, locate } from "./location.js";
import type { Provider } from "./workspace.js";
import type { GitHub, Issue } from "./github.js";
import { kindOf, stateOf, stepFor, type State } from "./machine.js";
import { hhmm, storyBranch, wrap } from "./text.js";
import { removeWorktreeOf, syncBlocked, type Ctx } from "./transitions.js";

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
}

export interface WaitItem {
  issue: number;
  reason: "blocked" | "needs-human" | "held" | "owner-merge";
  detail: string;
}

export interface NextReport {
  story: number;
  provider: Provider;
  title: string;
  state: State | null;
  branch: string;
  slices: { total: number; merged: number };
  /** Housekeeping psdd did, e.g. a removed worktree. */
  notes: string[];
  start: StartItem[];
  waiting: WaitItem[];
}

const DESCRIBE: Partial<Record<State, string>> = {
  "ready-for-agent": "is ready-for-agent",
  implementation: "is in implementation with no one holding it",
  "needs-review": "needs review",
  "changes-requested": "has changes requested",
  "needs-qa": "needs QA",
  "qa-failed": "failed QA",
  "merge-queue": "is in merge-queue",
};

/** What can be done on a story now. Syncs blocked labels first. */
export async function computeNext(ctx: Ctx, storyNumber: number): Promise<NextReport> {
  const { github } = ctx;
  await syncBlocked(ctx, storyNumber);
  const story = await github.getIssue(storyNumber);
  const slices = await github.subIssues(storyNumber);
  const report: NextReport = {
    story: storyNumber,
    provider: ctx.config.provider,
    title: story.title,
    state: stateOf(story),
    branch: storyBranch(storyNumber, story.title),
    slices: { total: slices.length, merged: slices.filter((s) => s.state === "closed").length },
    start: [],
    waiting: [],
    notes: [],
  };
  if (story.state === "closed") {
    const removed = await removeWorktreeOf(ctx, story);
    if (removed) report.notes.push(`Story #${storyNumber} is merged and closed. Removed its worktree ${removed}.`);
    return report;
  }
  if (stateOf(story) === "merge-queue") {
    const owner = story.assignees[0] ? `@${story.assignees[0]}` : "the story owner";
    report.waiting.push({
      issue: storyNumber,
      reason: "owner-merge",
      detail: `waits for its owner (${owner}) to merge the story PR into main.`,
    });
    return report;
  }
  for (const issue of [story, ...slices]) {
    if (issue.state !== "open") continue;
    await classify(ctx, issue, report);
  }
  return report;
}

async function classify(ctx: Ctx, issue: Issue, report: NextReport) {
  const n = issue.number;
  const state = stateOf(issue);
  if (issue.labels.includes("needs-human")) {
    const why =
      state === "needs-qa"
        ? kindOf(issue) === "story"
          ? "story QA is done by a human"
          : "QA in mode:hil"
        : "see its latest comment";
    report.waiting.push({ issue: n, reason: "needs-human", detail: `needs a human: ${why}. Do not take it.` });
    return;
  }
  if (state === "blocked") {
    const open = (await ctx.github.blockedBy(n)).filter((b) => b.state === "open");
    report.waiting.push({ issue: n, reason: "blocked", detail: `is blocked by ${open.map((b) => `#${b.number}`).join(", ")}.` });
    return;
  }
  const step = stepFor(issue);
  if (!step || !state) return;
  const claim = await ctx.github.readClaim(n);
  if (claim && !isStale(claim, ctx.now(), ctx.config.staleAfterMs)) {
    const who = claim.session === ctx.session ? "this session" : "another session";
    report.waiting.push({ issue: n, reason: "held", detail: `is held by ${who} (since ${hhmm(claim.since)}).` });
    return;
  }
  const loc = await locate(issue, ctx.github, ctx.config.baseBranch);
  let createWorktree: string | null = null;
  if (loc && ctx.config.provider === "herdr" && !(await ctx.workspace.worktreeExists(loc.worktree))) {
    createWorktree = createWorktreeCommand("herdr", loc, ctx.workspace.root, await ctx.workspace.localBranchExists(loc.branch));
  }
  report.start.push({
    issue: n,
    branch: loc?.branch ?? null,
    worktree: loc?.worktree ?? null,
    createWorktree,
    kind: kindOf(issue) === "slice" ? "slice" : "story",
    title: issue.title,
    state,
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    command: `psdd take ${n}`,
  });
}

export function renderNext(r: NextReport): string {
  const out: string[] = [];
  if (r.notes.length) out.push(...r.notes, "");
  let head = `Story #${r.story} "${r.title}" is in ${r.state ?? "no state"}.`;
  if (r.slices.total) head += ` ${r.slices.merged} of ${r.slices.total} slices are merged into ${r.branch}.`;
  out.push(wrap(head), "");

  if (r.start.length === 0) out.push("Nothing can be started now.");
  else {
    const count = `You can start ${r.start.length} item${r.start.length === 1 ? "" : "s"} now`;
    const agent = {
      herdr: "each as a new herdr agent in the item's worktree pane:",
      "claude-code": "each in its own fresh subagent, told to work in the item's worktree:",
      git: "each in a new agent session started in the item's worktree:",
    }[r.provider];
    out.push(
      r.start.length === 1
        ? `${count}, ${agent.replace(/^each /, "")}`
        : wrap(`${count}. They are independent, so run them in parallel, ${agent}`),
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
      if (r.provider === "herdr" && s.worktree) {
        out.push(`    Start an agent: herdr agent start psdd-${s.issue} --kind claude --pane <pane of ${s.worktree}>`);
      }
      out.push(`    Start it with: ${s.command}`);
    }
  }
  if (r.waiting.length) {
    out.push("", "Waiting, nothing to do for you:");
    for (const w of r.waiting) out.push(`  - #${w.issue} ${w.detail}`);
  }
  if (r.start.length) out.push("", `Each phase gets a new agent. When an item is done, run psdd next ${r.story} again.`);
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
