import { acquire } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { FIX_STATES, STATES, kindOf, slicesOf, stateOf, type Outcome, type State } from "./machine.js";
import { locate } from "./location.js";
import { SLUG_MARK, slugLine, storySlug, type Slugs } from "./slug.js";
import { sliceBranch, specPath, storyBranch } from "./text.js";
import type { Workspace } from "./workspace.js";
import type { Config } from "./config.js";
import type { BaseBranchMissing, Event, FollowUpTask } from "./events.js";
import { notifyHumanQa, notifyNeedsHuman, type Notify } from "./notify.js";

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
  return lastNeedsHumanReason(await github.listComments(n));
}

/** The reason in the latest needs-human marker among comments, oldest first. */
export function lastNeedsHumanReason(comments: string[]): string | null {
  for (const body of [...comments].reverse()) {
    const reason = needsHumanIn(body);
    if (reason !== null) return reason;
  }
  return null;
}

/** The reason of the needs-human marker in one comment, or null. */
export function needsHumanIn(body: string): string | null {
  const line = body.split("\n").find((l) => l.startsWith(NEEDS_HUMAN_MARK));
  return line === undefined ? null : line.slice(NEEDS_HUMAN_MARK.length);
}

/** Every comment psdd writes starts so; anything else is a person's. */
export function isPsddComment(body: string) {
  return body.startsWith("psdd: ");
}

export function fixLimitReason(max: number) {
  return `(${max} fix rounds reached)`;
}

const FIX_LIMIT = new RegExp(`^${NEEDS_HUMAN_MARK}.*\\(\\d+ fix rounds reached\\)$`, "m");
const TRANSITION = /^psdd: (\S+) → (\S+)/;

/**
 * Fix rounds that count toward the limit, read from psdd's transition comments:
 * entries into a fix state from another state, since the last time the limit
 * escalated. A person resolving that escalation so starts a fresh budget.
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

/** QA evidence files pushed to their branch, to embed in the transition comment. */
export interface Evidence {
  branch: string;
  sha: string;
  /** Paths inside the commit. */
  files: string[];
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const EVIDENCE_HEAD = /^Evidence \((\S+) at (\S+)\):$/;
/** An evidence file line as evidenceLines writes it: an embedded image or a link, at its commit. */
const EVIDENCE_FILE = /^(?:!\[(.*)\]\((\S+?)\?raw=true\)|- \[(.*)\]\((\S+)\))$/;

/** A transition comment psdd wrote, read back: what applyOutcome, setState and closeMergedStory put in it. */
export interface TransitionComment {
  /** The state before; "triage" for a new issue. */
  from: string;
  /** The state after, "closed", or "closed as not planned". */
  to: string;
  /** What is in the brackets: the outcome word, "automatic" or "needs-human resolved"; null for none. */
  why: string | null;
  /** The note after the markers, as written; null for none. */
  note: string | null;
  evidence: Evidence | null;
  /** The reason of the needs-human marker the comment sets, or null. */
  needsHuman: string | null;
}

/**
 * Reads back a comment psdd wrote on a transition; null for any other. The
 * inverse of applyOutcome's comment, kept beside it so the two change together.
 */
export function parseTransitionComment(body: string): TransitionComment | null {
  const lines = body.split("\n");
  const head = /^psdd: (\S+) → (closed as not planned|\S+)(?: \((.+)\))?$/.exec(lines[0]);
  if (!head) return null;
  let rest = lines.slice(1);
  const needsHuman = needsHumanIn(body);
  if (needsHuman !== null) rest = rest.filter((l) => !l.startsWith(NEEDS_HUMAN_MARK));
  // The markers come first, each in its own paragraph: the spec link, then the slug.
  for (const marker of ["Spec: ", SLUG_MARK]) {
    if (rest[0] === "" && rest[1]?.startsWith(marker)) rest = rest.slice(2);
  }
  let evidence: Evidence | null = null;
  let at = rest.length - 1;
  while (at >= 0 && !EVIDENCE_HEAD.test(rest[at])) at--;
  if (at >= 0 && rest.slice(at + 1).every((l) => l === "" || EVIDENCE_FILE.test(l))) {
    const [, branch] = EVIDENCE_HEAD.exec(rest[at])!;
    const files: string[] = [];
    let sha = "";
    for (const l of rest.slice(at + 1)) {
      const m = EVIDENCE_FILE.exec(l);
      if (!m) continue;
      files.push(m[1] ?? m[3]);
      sha ||= /\/blob\/([^/]+)\//.exec(m[2] ?? m[4])?.[1] ?? "";
    }
    evidence = { branch, sha: sha || EVIDENCE_HEAD.exec(rest[at])![2], files };
    rest = rest.slice(0, at);
  }
  const note = rest.join("\n").trim();
  return { from: head[1], to: head[2], why: head[3] ?? null, note: note || null, evidence, needsHuman };
}

/** Markdown that embeds the evidence at its commit: images inline, other files as links. */
export function evidenceLines(repoUrl: string, e: Evidence): string[] {
  const lines = [`Evidence (${e.branch} at ${e.sha.slice(0, 7)}):`, ""];
  for (const f of e.files) {
    const url = `${repoUrl}/blob/${e.sha}/${f.split("/").map(encodeURIComponent).join("/")}`;
    lines.push(IMAGE.test(f) ? `![${f}](${url}?raw=true)` : `- [${f}](${url})`);
  }
  return lines;
}

/**
 * Applies an outcome to an issue whose claim this session holds: labels,
 * comment and closing. The automatic transitions that follow are in followUps.
 */
export async function applyOutcome(ctx: Ctx, issue: Issue, outcome: Outcome, word: string, note?: string, evidence?: Evidence): Promise<void> {
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
  if (evidence) comment.push("", ...evidenceLines(await github.repoUrl(), evidence));

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
    else if (outcome.notify) await notifyHumanQa(ctx, n, outcome.notify);
  }
}

/**
 * The automatic transitions after an outcome, run once its claim is released.
 * Each is best effort: psdd next repeats them, so a failure is only reported.
 */
export async function followUps(ctx: Ctx, issue: Issue, outcome: Outcome): Promise<Event[]> {
  if (kindOf(issue) !== "slice" || outcome.to !== "closed") return [];
  const story = await ctx.github.parentOf(issue.number);
  if (!story) return [];
  const events: Event[] = [];
  const loc = await locate(issue, ctx);
  if (loc && (await ctx.workspace.worktreeExists(loc.worktree))) events.push({ kind: "worktree-left-for-tidy", worktree: loc.worktree });
  events.push(...(await bestEffort("unblock-slices", story, story, () => syncBlocked(ctx, story))));
  events.push(...(await bestEffort("move-story-on", story, story, () => promoteStory(ctx, story))));
  return events;
}

/** Runs fn; a failure becomes an event instead of an error. `retry` is the story whose psdd next retries it. */
export async function bestEffort(what: FollowUpTask, issue: number, retry: number, fn: () => Promise<Event[]>): Promise<Event[]> {
  try {
    return await fn();
  } catch (e) {
    return [{ kind: "follow-up-failed", what, issue, retry, detail: (e as Error).message }];
  }
}

export type Ensured = { ok: true; created: boolean; branch: string } | { ok: false; refusal: BaseBranchMissing };

/** Creates the story branch from the base branch unless it is already on GitHub. */
export async function ensureStoryBranch(ctx: Ctx, story: Issue): Promise<Ensured> {
  const branch = storyBranch(story.number, await storySlug(ctx, story));
  if (await ctx.github.branchExists(branch)) return { ok: true, created: false, branch };
  const base = ctx.config.baseBranch;
  if (!(await ctx.github.branchExists(base))) return { ok: false, refusal: { kind: "base-branch-missing", branch, base } };
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
 * Closes a story in merge-queue whose story PR is merged. GitHub closes it
 * through `Closes #N` only for PRs into the default branch, so a baseBranch like
 * develop would leave it open for good. Returns whether the story was closed.
 */
export async function closeMergedStory(ctx: Ctx, story: Issue): Promise<boolean> {
  if (story.state !== "open" || stateOf(story) !== "merge-queue") return false;
  const branch = storyBranch(story.number, await storySlug(ctx, story));
  const pr = await ctx.github.findPullRequest(branch);
  if (pr?.state !== "merged") return false;
  return withShortClaim(ctx, story.number, async () => {
    await ctx.github.comment(story.number, `psdd: merge-queue → closed (automatic)\n\nThe story PR #${pr.number} is merged into ${pr.base}.`);
    await ctx.github.closeIssue(story.number, "completed");
    await ctx.github.removeLabels(story.number, ["in-progress", ...stateLabels(story)]);
  });
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
 * for the open slices of a story. Returns what changed.
 */
export async function syncBlocked(ctx: Ctx, story: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const slice of await slicesOf(ctx.github, story)) {
    const state = stateOf(slice);
    if (slice.state !== "open" || (state !== "blocked" && state !== "ready-for-agent")) continue;
    const open = (await ctx.github.blockedBy(slice.number)).filter((b) => b.state === "open");
    const want: State = open.length ? "blocked" : "ready-for-agent";
    if (want === state) continue;
    const why = open.length ? `Blocked by ${open.map((b) => `#${b.number}`).join(", ")}.` : "All blockers are closed.";
    if (await withShortClaim(ctx, slice.number, () => setState(ctx, slice, want, why))) {
      events.push({ kind: "slice-state-changed", issue: slice.number, state: want });
    }
  }
  return events;
}

/** Once every slice is merged, opens the story PR and moves the story to needs-review. */
export async function promoteStory(ctx: Ctx, storyNumber: number): Promise<Event[]> {
  const { github } = ctx;
  const events: Event[] = [];
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
    if (moved) events.push({ kind: "story-promoted", story: storyNumber });
  }
  return events;
}

/** Why a slice's merge cannot finish yet. */
export type MergeRefusal =
  | { kind: "not-in-story"; issue: number }
  | { kind: "no-slice-pr"; issue: number; head: string }
  /** A slice PR into anything but the story branch skips story review and misses the story PR. */
  | { kind: "slice-pr-wrong-base"; issue: number; pr: number; head: string; base: string; storyBranch: string; merged: boolean }
  | { kind: "slice-pr-not-merged"; issue: number; pr: number; head: string; base: string };

/** Precondition for finishing a merge: the slice PR is merged into the story branch. */
export async function sliceMergeRefusal(ctx: Ctx, slice: Issue): Promise<MergeRefusal | null> {
  const { github } = ctx;
  const n = slice.number;
  const storyNumber = await github.parentOf(n);
  if (!storyNumber) return { kind: "not-in-story", issue: n };
  const story = await github.getIssue(storyNumber);
  const slug = await storySlug(ctx, story);
  const head = sliceBranch(story.number, slug, n);
  const base = storyBranch(story.number, slug);
  const pr = await github.findPullRequest(head);
  if (!pr) return { kind: "no-slice-pr", issue: n, head };
  if (pr.base !== base) return { kind: "slice-pr-wrong-base", issue: n, pr: pr.number, head, base: pr.base, storyBranch: base, merged: pr.state === "merged" };
  if (pr.state !== "merged") return { kind: "slice-pr-not-merged", issue: n, pr: pr.number, head, base: pr.base };
  return null;
}
