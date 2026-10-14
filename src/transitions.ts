import { join } from "node:path";
import { acquire } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { FIX_STATES, STATES, kindOf, slicesOf, stateOf, type Outcome, type State } from "./machine.js";
import { locate } from "./location.js";
import { slugLine, storySlug, type Slugs } from "./slug.js";
import { sliceBranch, specPath, storyBranch } from "./text.js";
import { isWithin, type Workspace } from "./workspace.js";
import type { Config } from "./config.js";
import { notifyNeedsHuman, type Notify } from "./notify.js";

/** The marker psdd writes when it sets needs-human; psdd next reads the reason back from it. */
export const NEEDS_HUMAN_MARK = "psdd: needs-human — ";

export function needsHumanLine(reason: string) {
  return `${NEEDS_HUMAN_MARK}${oneLine(reason)}`;
}

/** Collapses a free-form note onto one line, so the marker line psdd reads back stays whole. */
export function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
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

export function fixLimitReason(max: number) {
  return `(${max} fix rounds reached)`;
}

const FIX_LIMIT = new RegExp(`^${NEEDS_HUMAN_MARK}.*\\(\\d+ fix rounds reached\\)$`, "m");
const TRANSITION = /^psdd: (\S+) → (\S+)/;

/**
 * Fix rounds that count toward the limit, read from psdd's transition comments:
 * entries into a fix state from another state, since the last time the limit
 * escalated. A person resolving that escalation so starts a fresh budget; the
 * needs-human of QA in mode:hil does not reset it.
 */
export function fixRounds(comments: string[]): number {
  let rounds = 0;
  for (const body of comments) {
    if (FIX_LIMIT.test(body)) {
      rounds = 0;
      continue;
    }
    const m = TRANSITION.exec(body);
    if (m && m[1] !== m[2] && FIX_STATES.includes(m[2] as State)) rounds++;
  }
  return rounds;
}

export interface Ctx {
  github: GitHub;
  notify: Notify;
  workspace: Workspace;
  config: Config;
  now: () => Date;
  session: string;
  /** A short random string, e.g. to make each agent's PSDD_SESSION unique. */
  nonce: () => string;
  /** Story slugs read during this command; see slug.ts. */
  slugs: Slugs;
}

/**
 * Applies an outcome to an issue whose claim this session holds: labels,
 * comment and closing. The automatic transitions that follow are in followUps.
 */
export async function applyOutcome(ctx: Ctx, issue: Issue, outcome: Outcome, word: string, note?: string): Promise<void> {
  const { github } = ctx;
  const n = issue.number;
  const from = stateOf(issue) ?? "triage";
  // The resolve step has no outcome word and keeps the state; say what it did.
  const resolved = !word && issue.labels.includes("needs-human") && !outcome.needsHuman;
  const why = word || (resolved ? "needs-human resolved" : "");
  const comment = [`psdd: ${from} → ${outcome.to === "not-planned" ? "closed as not planned" : outcome.to}${why ? ` (${why})` : ""}`];
  const spec = await specLink(ctx, issue);
  if (spec) comment.push("", `Spec: ${spec}`);
  // A story records its slug the first time psdd writes on it, triage included.
  const becomesStory = kindOf(issue) === "story" || (kindOf(issue) === "new" && outcome.to !== "not-planned");
  const slug = becomesStory ? await slugLine(ctx, issue) : null;
  if (slug) comment.push("", slug);
  if (note) comment.push("", note);

  // The new state is written before the old labels go, so a failure in between
  // leaves an issue psdd can still act on, never one with no state.
  if (outcome.to === "not-planned" || outcome.to === "closed") {
    await github.comment(n, comment.join("\n"));
    await github.closeIssue(n, outcome.to === "closed" ? "completed" : "not_planned");
    await github.removeLabels(n, ["in-progress", "needs-human", ...stateLabels(issue)]);
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
    const remove = ["in-progress", ...(outcome.needsHuman ? [] : ["needs-human"]), ...stateLabels(issue, outcome.to)];
    await github.addLabels(n, add);
    await github.comment(n, comment.join("\n"));
    await github.removeLabels(n, remove);
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
  const loc = await locate(issue, ctx);
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

export type Ensured = { ok: true; created: boolean; branch: string } | { ok: false; lines: string[] };

/** Creates the story branch from the base branch unless it is already on GitHub. */
export async function ensureStoryBranch(ctx: Ctx, story: Issue): Promise<Ensured> {
  const branch = storyBranch(story.number, await storySlug(ctx, story));
  if (await ctx.github.branchExists(branch)) return { ok: true, created: false, branch };
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
  return { ok: true, created: true, branch };
}

async function specLink(ctx: Ctx, issue: Issue): Promise<string | null> {
  let story = kindOf(issue) === "story" ? issue : null;
  if (kindOf(issue) === "slice") {
    const p = await ctx.github.parentOf(issue.number);
    if (p) story = await ctx.github.getIssue(p);
  }
  if (!story) return null;
  // The spec lives on the story branch; a local HEAD may be main or an unpushed commit.
  const slug = await storySlug(ctx, story);
  return `${await ctx.github.repoUrl()}/blob/${storyBranch(story.number, slug)}/${specPath(story.number, slug)}`;
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
  // A story from before the slug marker records it here, under the short claim.
  const slug = kindOf(issue) === "story" ? await slugLine(ctx, issue) : null;
  await ctx.github.addLabels(issue.number, [to]);
  await ctx.github.comment(issue.number, `psdd: ${from} → ${to} (automatic)\n\n${why}${slug ? `\n\n${slug}` : ""}`);
  await ctx.github.removeLabels(issue.number, stateLabels(issue, to));
}

/**
 * Every state label on the issue except `keep`. A failed removal can leave two
 * state labels; removing all of them on the next transition cleans that up.
 */
export function stateLabels(issue: Issue, keep?: string): State[] {
  return STATES.filter((s) => s !== keep && issue.labels.includes(s));
}

/**
 * Removes the state labels a closed issue still carries, e.g. merge-queue on a
 * story GitHub closed through its PR. Returns whether it changed anything.
 */
export async function clearClosedState(ctx: Ctx, issue: Issue): Promise<boolean> {
  const left = stateLabels(issue);
  if (issue.state !== "closed" || left.length === 0) return false;
  return withShortClaim(ctx, issue.number, () => ctx.github.removeLabels(issue.number, left));
}

/**
 * Brings blocked / ready-for-agent in line with native blocked-by relations
 * for the open slices of a story. Returns lines describing changes.
 */
export async function syncBlocked(ctx: Ctx, story: number): Promise<string[]> {
  const lines: string[] = [];
  for (const slice of await slicesOf(ctx.github, story)) {
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
  const slices = await slicesOf(github, storyNumber);
  const story = await github.getIssue(storyNumber);
  if (story.state === "open" && slices.length && slices.every((s) => s.state === "closed") && stateOf(story) === "implementation") {
    const slug = await storySlug(ctx, story);
    const branch = storyBranch(story.number, slug);
    const base = ctx.config.baseBranch;
    const moved = await withShortClaim(ctx, storyNumber, async () => {
      const pr =
        (await github.findPullRequest(branch)) ??
        (await github.createPullRequest({
          head: branch,
          base,
          title: story.title,
          body: `Closes #${story.number}\n\nSpec: ${specPath(story.number, slug)}`,
        }));
      await setState(ctx, story, "needs-review", `Every slice is merged into ${branch}. Story PR: #${pr.number}.`);
    });
    if (moved) lines.push(`Every slice is merged. Story #${storyNumber} is now in needs-review.`);
  }
  return lines;
}

/** Precondition for finishing a merge: the slice PR is merged. */
export async function sliceMergeRefusal(ctx: Ctx, slice: Issue): Promise<string[] | null> {
  const { github } = ctx;
  const storyNumber = await github.parentOf(slice.number);
  if (!storyNumber) return [`#${slice.number} is not a sub-issue of a story.`];
  const story = await github.getIssue(storyNumber);
  const slug = await storySlug(ctx, story);
  const head = sliceBranch(story.number, slug, slice.number);
  const base = storyBranch(story.number, slug);
  const pr = await github.findPullRequest(head);
  if (!pr) return [`No PR from ${head} was found. Open and merge it before running psdd done ${slice.number}.`];
  // A slice PR into anything but the story branch skips story review and misses the story PR.
  if (pr.base !== base) {
    return [
      `PR #${pr.number} from ${head} targets ${pr.base}, not the story branch ${base}.`,
      pr.state === "merged"
        ? `Its changes are not on ${base}, and a person must sort that out. Run: psdd escalate ${slice.number} "slice PR #${pr.number} was merged into ${pr.base}, not ${base}"`
        : `Retarget it with: gh pr edit ${pr.number} --base ${base}, then merge it and run psdd done ${slice.number}.`,
    ];
  }
  if (pr.state !== "merged") {
    return [
      `PR #${pr.number} from ${head} is not merged yet.`,
      `Merge it into ${pr.base} (resolve conflicts if needed), then run psdd done ${slice.number}.`,
    ];
  }
  return null;
}

/**
 * Removes the issue's local worktree, if there is one. Returns its path when
 * removed. A worktree with uncommitted changes is kept and returned as kept:
 * removal forces, and someone may still be working there.
 * Throws rather than remove the worktree psdd is running in.
 */
export async function removeWorktreeOf(ctx: Ctx, issue: Issue): Promise<{ removed: string } | { kept: string } | null> {
  const loc = await locate(issue, ctx);
  if (!loc || !(await ctx.workspace.worktreeExists(loc.worktree))) return null;
  const abs = join(ctx.workspace.root, loc.worktree);
  if (isWithin(ctx.workspace.cwd, abs)) {
    throw new Error(`psdd is running inside it; run psdd next from another directory to remove it`);
  }
  if (await ctx.workspace.worktreeDirty(loc.worktree)) return { kept: abs };
  await ctx.workspace.removeWorktree(loc.worktree, ctx.config.provider);
  return { removed: loc.worktree };
}
