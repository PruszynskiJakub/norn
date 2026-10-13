import { isStale } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { kindOf, stateOf, stepFor, type State } from "./machine.js";
import { hhmm, storyBranch, wrap } from "./text.js";
import { syncBlocked, type Ctx } from "./transitions.js";

export interface StartItem {
  issue: number;
  kind: "story" | "slice";
  title: string;
  state: State;
  step: string;
  skill: string;
  attended: boolean;
  command: string;
}

export interface WaitItem {
  issue: number;
  reason: "blocked" | "needs-human" | "held" | "owner-merge";
  detail: string;
}

export interface NextReport {
  story: number;
  title: string;
  state: State | null;
  branch: string;
  slices: { total: number; merged: number };
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
    title: story.title,
    state: stateOf(story),
    branch: storyBranch(storyNumber, story.title),
    slices: { total: slices.length, merged: slices.filter((s) => s.state === "closed").length },
    start: [],
    waiting: [],
  };
  if (story.state === "closed") return report;
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
  if (claim && !isStale(claim, ctx.now())) {
    const who = claim.session === ctx.session ? "this session" : "another session";
    report.waiting.push({ issue: n, reason: "held", detail: `is held by ${who} (since ${hhmm(claim.since)}).` });
    return;
  }
  report.start.push({
    issue: n,
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
  let head = `Story #${r.story} "${r.title}" is in ${r.state ?? "no state"}.`;
  if (r.slices.total) head += ` ${r.slices.merged} of ${r.slices.total} slices are merged into ${r.branch}.`;
  out.push(wrap(head), "");

  if (r.start.length === 0) out.push("Nothing can be started now.");
  else {
    const count = `You can start ${r.start.length} item${r.start.length === 1 ? "" : "s"} now`;
    out.push(
      r.start.length === 1
        ? `${count}:`
        : wrap(`${count}. They are independent, so run them in parallel, each in its own subagent:`),
      "",
    );
    for (const s of r.start) {
      const what = `${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}"`;
      const desc =
        s.kind === "story" && !DESCRIBE[s.state]
          ? `is in ${s.state}: ${s.step}${s.attended ? " (attended: the user takes part)" : ""}.`
          : `${DESCRIBE[s.state] ?? `is in ${s.state}`}${s.attended ? " (attended: the user takes part)" : ""}.`;
      out.push(`  - ${what} ${desc}`, `    Start it with: ${s.command}`);
    }
  }
  if (r.waiting.length) {
    out.push("", "Waiting, nothing to do for you:");
    for (const w of r.waiting) out.push(`  - #${w.issue} ${w.detail}`);
  }
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
