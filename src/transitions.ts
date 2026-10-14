import { join, sep } from "node:path";
import { acquire } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { kindOf, stateOf, type Outcome, type State } from "./machine.js";
import { locate } from "./location.js";
import { sliceBranch, specPath, storyBranch } from "./text.js";
import type { Workspace } from "./workspace.js";
import type { Config } from "./config.js";
import { notifyNeedsHuman, type Notify } from "./notify.js";

/** The marker psdd writes when it sets needs-human; psdd next reads the reason back from it. */
export const NEEDS_HUMAN_MARK = "psdd: needs-human — ";

export function needsHumanLine(reason: string) {
  return `${NEEDS_HUMAN_MARK}${reason}`;
}

/** The reason psdd last gave for needs-human on an issue, read back from its comments. */
export async function needsHumanReason(github: GitHub, n: number): Promise<string | null> {
  const comments = await github.listComments(n);
  for (const body of comments.reverse()) {
    const line = body.split("\n").find((l) => l.startsWith(NEEDS_HUMAN_MARK));
    if (line) return line.slice(NEEDS_HUMAN_MARK.length);
  }
  return null;
}

export interface Ctx {
  github: GitHub;
  notify: Notify;
  workspace: Workspace;
  config: Config;
  now: () => Date;
  session: string;
  headSha: () => Promise<string>;
}

/**
 * Applies an outcome to an issue whose claim this session holds: labels,
 * comment and closing. The automatic transitions that follow are in followUps.
 */
export async function applyOutcome(ctx: Ctx, issue: Issue, outcome: Outcome, word: string, note?: string): Promise<void> {
  const { github } = ctx;
  const n = issue.number;
  const from = stateOf(issue) ?? "triage";
  const comment = [`psdd: ${from} → ${outcome.to === "not-planned" ? "closed as not planned" : outcome.to}${word ? ` (${word})` : ""}`];
  const spec = await specLink(ctx, issue);
  if (spec) comment.push("", `Spec: ${spec}`);
  if (note) comment.push("", note);

  if (outcome.to === "not-planned" || outcome.to === "closed") {
    await github.removeLabels(n, ["in-progress", "needs-human", ...(stateOf(issue) ? [stateOf(issue)!] : [])]);
    await github.comment(n, comment.join("\n"));
    await github.closeIssue(n, outcome.to === "closed" ? "completed" : "not_planned");
  } else {
    const add: string[] = [outcome.to];
    if (kindOf(issue) === "new") {
      add.push("type:story");
      await github.assign(n, [await github.currentUser()]);
    }
    if (outcome.needsHuman) {
      add.push("needs-human");
      comment.push("", needsHumanLine(outcome.needsHuman));
    }
    const state = stateOf(issue);
    const remove = ["in-progress", ...(outcome.needsHuman ? [] : ["needs-human"])];
    if (state && state !== outcome.to) remove.push(state);
    await github.removeLabels(n, remove);
    await github.addLabels(n, add);
    await github.comment(n, comment.join("\n"));
    if (outcome.needsHuman) await notifyNeedsHuman(ctx, n, outcome.needsHuman);
  }
}

/**
 * The automatic transitions after an outcome, run once its claim is released.
 * Each is best effort: psdd next repeats them, so a failure is only reported.
 */
export async function followUps(ctx: Ctx, issue: Issue, outcome: Outcome): Promise<string[]> {
  if (kindOf(issue) !== "slice" || outcome.to !== "closed") return [];
  const story = await ctx.github.parentOf(issue.number);
  if (!story) return [];
  const lines: string[] = [];
  const loc = await locate(issue, ctx.github, ctx.config.baseBranch);
  if (loc && (await ctx.workspace.worktreeExists(loc.worktree))) {
    lines.push(`Its worktree ${loc.worktree} is removed by the next psdd next ${story}.`);
  }
  lines.push(...(await bestEffort("unblock the slices waiting on it", story, () => syncBlocked(ctx, story))));
  lines.push(...(await bestEffort("move the story on", story, () => promoteStory(ctx, story))));
  return lines;
}

/** Runs fn; a failure becomes a report line instead of an error. */
export async function bestEffort(what: string, story: number, fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch (e) {
    return [`Could not ${what}: ${(e as Error).message}. psdd next ${story} will retry this.`];
  }
}

export type Ensured = { ok: true; created: boolean } | { ok: false; lines: string[] };

/** Creates the story branch from the base branch unless it is already on GitHub. */
export async function ensureStoryBranch(ctx: Ctx, story: Issue): Promise<Ensured> {
  const branch = storyBranch(story.number, story.title);
  if (await ctx.github.branchExists(branch)) return { ok: true, created: false };
  const base = ctx.config.baseBranch;
  if (!(await ctx.github.branchExists(base))) {
    return {
      ok: false,
      lines: [
        `The story branch ${branch} would start from ${base}, but ${base} does not exist on GitHub.`,
        `Set baseBranch in .agents/psdd.config.json to the repository's default branch and run the command again.`,
      ],
    };
  }
  await ctx.github.createBranch(branch, base);
  return { ok: true, created: true };
}

async function specLink(ctx: Ctx, issue: Issue): Promise<string | null> {
  let story = kindOf(issue) === "story" ? issue : null;
  if (kindOf(issue) === "slice") {
    const p = await ctx.github.parentOf(issue.number);
    if (p) story = await ctx.github.getIssue(p);
  }
  if (!story) return null;
  return `${await ctx.github.repoUrl()}/blob/${await ctx.headSha()}/${specPath(story.number, story.title)}`;
}

/** Changes labels on an issue this session does not hold, by taking a short claim. */
async function withShortClaim(ctx: Ctx, n: number, fn: () => Promise<void>): Promise<boolean> {
  const user = await ctx.github.currentUser();
  const got = await acquire(ctx.github, n, { holder: user, session: ctx.session, since: ctx.now().toISOString() }, ctx.now(), ctx.config.staleAfterMs);
  if (!got.ok) return false;
  try {
    await fn();
  } finally {
    // A claim this session already held stays held.
    if (!got.reacquired) await ctx.github.deleteClaim(n);
  }
  return true;
}

async function setState(ctx: Ctx, issue: Issue, to: State, why: string) {
  const from = stateOf(issue);
  if (from) await ctx.github.removeLabels(issue.number, [from]);
  await ctx.github.addLabels(issue.number, [to]);
  await ctx.github.comment(issue.number, `psdd: ${from} → ${to} (automatic)\n\n${why}`);
}

/**
 * Brings blocked / ready-for-agent in line with native blocked-by relations
 * for the open slices of a story. Returns lines describing changes.
 */
export async function syncBlocked(ctx: Ctx, story: number): Promise<string[]> {
  const lines: string[] = [];
  for (const slice of await ctx.github.subIssues(story)) {
    const state = stateOf(slice);
    if (slice.state !== "open" || (state !== "blocked" && state !== "ready-for-agent")) continue;
    const open = (await ctx.github.blockedBy(slice.number)).filter((b) => b.state === "open");
    const want: State = open.length ? "blocked" : "ready-for-agent";
    if (want === state) continue;
    const why = open.length
      ? `Blocked by ${open.map((b) => `#${b.number}`).join(", ")}.`
      : "All blockers are closed.";
    if (await withShortClaim(ctx, slice.number, () => setState(ctx, slice, want, why))) {
      lines.push(`#${slice.number} is now ${want}.`);
    }
  }
  return lines;
}

/** Once every slice is merged, opens the story PR and moves the story to needs-review. */
export async function promoteStory(ctx: Ctx, storyNumber: number): Promise<string[]> {
  const { github } = ctx;
  const lines: string[] = [];
  const slices = await github.subIssues(storyNumber);
  const story = await github.getIssue(storyNumber);
  if (story.state === "open" && slices.length && slices.every((s) => s.state === "closed") && stateOf(story) === "implementation") {
    const branch = storyBranch(story.number, story.title);
    const base = ctx.config.baseBranch;
    const moved = await withShortClaim(ctx, storyNumber, async () => {
      const pr =
        (await github.findPullRequest(branch)) ??
        (await github.createPullRequest({
          head: branch,
          base,
          title: story.title,
          body: `Closes #${story.number}\n\nSpec: ${specPath(story.number, story.title)}`,
        }));
      await setState(ctx, story, "needs-review", `Every slice is merged into ${branch}. Story PR: #${pr.number}.`);
    });
    if (moved) lines.push(`Every slice is merged. Story #${storyNumber} is now in needs-review.`);
  }
  return lines;
}

/** Precondition for finishing a merge: the slice PR is merged. */
export async function sliceMergeRefusal(github: GitHub, slice: Issue): Promise<string[] | null> {
  const storyNumber = await github.parentOf(slice.number);
  if (!storyNumber) return [`#${slice.number} is not a sub-issue of a story.`];
  const story = await github.getIssue(storyNumber);
  const head = sliceBranch(story.number, story.title, slice.number);
  const pr = await github.findPullRequest(head);
  if (!pr) return [`No PR from ${head} was found. Open and merge it before running psdd done ${slice.number}.`];
  if (pr.state !== "merged") {
    return [
      `PR #${pr.number} from ${head} is not merged yet.`,
      `Merge it into ${pr.base} (resolve conflicts if needed), then run psdd done ${slice.number}.`,
    ];
  }
  return null;
}

/**
 * Removes the issue's local worktree, if there is one. Returns its path when removed.
 * Throws rather than remove the worktree psdd is running in.
 */
export async function removeWorktreeOf(ctx: Ctx, issue: Issue): Promise<string | null> {
  const loc = await locate(issue, ctx.github, ctx.config.baseBranch);
  if (!loc || !(await ctx.workspace.worktreeExists(loc.worktree))) return null;
  const abs = join(ctx.workspace.root, loc.worktree);
  const cwd = ctx.workspace.cwd;
  if (cwd === abs || cwd.startsWith(abs + sep)) {
    throw new Error(`psdd is running inside it; run psdd next from another directory to remove it`);
  }
  await ctx.workspace.removeWorktree(loc.worktree, ctx.config.provider);
  return loc.worktree;
}
