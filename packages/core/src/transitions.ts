import { acquire } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { FIX_STATES, STATES, kindOf, slicesOf, stateOf, type Outcome, type State } from "./machine.js";
import { locate } from "./location.js";
import { SLUG_MARK, slugLine, storySlug, type Slugs } from "./slug.js";
import { sliceBranch, specPath, storyBranch } from "./text.js";
import type { Workspace } from "./workspace.js";
import type { Config } from "./config.js";
import type { BaseBranchMissing, Event, FollowUpTask } from "./events.js";
import { type Flow, type FlowCache, type Mode, flowStatesOf, repositoryFlow } from "./flow.js";
import { notifyHumanQa, notifyNeedsHuman, type Notify } from "./notify.js";

/** The marker norn writes when it sets needs-human; norn next reads the reason back from it. */
export const NEEDS_HUMAN_MARK = "norn: needs-human — ";

export function needsHumanLine(reason: string) {
  return `${NEEDS_HUMAN_MARK}${oneLine(reason)}`;
}

/** Says on a transition comment which states the issue's mode skipped, each of them for the other mode. */
export function skipLine(skipped: string[], mode: Mode): string {
  const other = mode === "afk" ? "hil" : "afk";
  return `Skipped ${skipped.join(", ")} in mode:${mode}: ${skipped.length === 1 ? "it runs" : "they run"} in mode:${other} only.`;
}
const SKIP_LINE = /^Skipped .+ in mode:(afk|hil): (it runs|they run) in mode:(afk|hil) only\.$/;

/** Collapses a free-form note onto one line, so the marker line norn reads back stays whole. */
export function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

/** The reason norn last gave for needs-human on an issue, read back from its comments. */
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

/** Every comment norn writes starts so; anything else is a person's. */
export function isNornComment(body: string) {
  return body.startsWith("norn: ");
}

export function fixLimitReason(max: number) {
  return `(${max} fix rounds reached)`;
}

const FIX_LIMIT = new RegExp(`^${NEEDS_HUMAN_MARK}.*\\(\\d+ fix rounds reached\\)$`, "m");
const TRANSITION = /^norn: (\S+) → (\S+)/;

/**
 * Fix rounds that count toward the limit, read from norn's transition comments:
 * entries into a fix state from another state, since the last time the limit
 * escalated. A person resolving that escalation so starts a fresh budget.
 * `fixStates` are the states that count: the built-in ones, or those of a flow
 * that opt into countsFixRounds.
 */
export function fixRounds(comments: string[], fixStates: readonly string[] = FIX_STATES): number {
  let rounds = 0;
  for (const body of comments) {
    if (FIX_LIMIT.test(body)) {
      rounds = 0;
      continue;
    }
    const m = TRANSITION.exec(body);
    if (m && m[1] !== m[2] && fixStates.includes(m[2])) rounds++;
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
  /** A short random string, e.g. to make each agent's NORN_SESSION unique. */
  nonce: () => string;
  /** Story slugs read during this command; see slug.ts. */
  slugs: Slugs;
  /** Repository flows read during this command; filled on first use, see repositoryFlow. */
  flows?: FlowCache;
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

/** A transition comment norn wrote, read back: what applyOutcome, setState and closeMergedStory put in it. */
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
 * Reads back a comment norn wrote on a transition; null for any other. The
 * inverse of applyOutcome's comment, kept beside it so the two change together.
 */
export function parseTransitionComment(body: string): TransitionComment | null {
  const lines = body.split("\n");
  const head = /^norn: (\S+) → (closed as not planned|\S+)(?: \((.+)\))?$/.exec(lines[0]);
  if (!head) return null;
  let rest = lines.slice(1);
  const needsHuman = needsHumanIn(body);
  if (needsHuman !== null) rest = rest.filter((l) => !l.startsWith(NEEDS_HUMAN_MARK));
  // The markers come first, each in its own paragraph: the spec link, the slug, then the states the mode skipped.
  for (const marker of ["Spec: ", SLUG_MARK]) {
    if (rest[0] === "" && rest[1]?.startsWith(marker)) rest = rest.slice(2);
  }
  if (rest[0] === "" && SKIP_LINE.test(rest[1] ?? "")) rest = rest.slice(2);
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
export async function applyOutcome(
  ctx: Ctx,
  issue: Issue,
  outcome: Outcome,
  word: string,
  note?: string,
  evidence?: Evidence,
  flow: Flow | null = null,
  skipped: string | null = null,
): Promise<void> {
  const { github } = ctx;
  const n = issue.number;
  // An issue whose state its flow dropped moves on from that state.
  const left = flow ? await leftState(ctx, issue, flow) : null;
  const from = (flow ? (flowStatesOf(issue, flow)[0] ?? left) : stateOf(issue)) ?? "triage";
  // The resolve step has no outcome word and keeps the state; say what it did.
  const resolved = !word && issue.labels.includes("needs-human") && !outcome.needsHuman;
  const why = word || (resolved ? "needs-human resolved" : "");
  const comment = [`norn: ${from} → ${outcome.to === "not-planned" ? "closed as not planned" : outcome.to}${why ? ` (${why})` : ""}`];
  const spec = flow ? null : await specLink(ctx, issue);
  if (spec) comment.push("", `Spec: ${spec}`);
  // Triage may give the issue a repository flow, which it enters here.
  const given = outcome.flow ? await repositoryFlow(ctx, outcome.flow) : null;
  const into = flow ?? (given?.ok ? given.flow : null);
  // A story records its slug the first time norn writes on it, triage included; so does an issue whose flow gives it a branch.
  const becomesStory = !flow && (kindOf(issue) === "story" || (kindOf(issue) === "new" && !outcome.flow && outcome.to !== "not-planned"));
  const slug = becomesStory || into?.workspace === "own" ? await slugLine(ctx, issue) : null;
  if (slug) comment.push("", slug);
  if (skipped) comment.push("", skipped);
  if (note) comment.push("", note);
  if (evidence) comment.push("", ...evidenceLines(await github.repoUrl(), evidence));

  // The new state is written before the old labels go, so a failure in between
  // leaves an issue norn can still act on, never one with no state.
  if (outcome.to === "not-planned" || outcome.to === "closed") {
    await github.comment(n, comment.join("\n"));
    await github.closeIssue(n, outcome.to === "closed" ? "completed" : "not_planned");
    await github.removeLabels(n, ["in-progress", "needs-human", ...stateLabels(issue, undefined, flow)]);
  } else {
    const add: string[] = [outcome.to];
    if (into) await ensureStateLabel(ctx, into, outcome.to);
    if (!flow && kindOf(issue) === "new") {
      add.push(`type:${outcome.flow ?? "story"}`);
      await github.assign(n, [await github.currentUser()]);
    }
    if (outcome.needsHuman) {
      add.push("needs-human");
      comment.push("", needsHumanLine(outcome.needsHuman));
    }
    const remove = ["in-progress", ...(outcome.needsHuman ? [] : ["needs-human"]), ...stateLabels(issue, outcome.to, flow), ...(left ? [left] : [])];
    await github.addLabels(n, add);
    await github.comment(n, comment.join("\n"));
    await github.removeLabels(n, remove);
    if (outcome.needsHuman) await notifyNeedsHuman(ctx, n, outcome.needsHuman);
    else if (outcome.notify) await notifyHumanQa(ctx, n, outcome.notify);
  }
}

/**
 * The automatic transitions after an outcome, run once its claim is released.
 * Each is best effort: norn next repeats them, so a failure is only reported.
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

/** Runs fn; a failure becomes an event instead of an error. `retry` is the story whose norn next retries it. */
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
  await ctx.github.comment(issue.number, `norn: ${from} → ${to} (automatic)\n\n${why}${slug ? `\n\n${slug}` : ""}`);
  await ctx.github.removeLabels(issue.number, stateLabels(issue, to));
}

/**
 * The state an issue of a repository flow was left in that the flow no longer
 * has; null when it carries a state of the flow, or never had one. A label the
 * flow's `renamed` names counts; else the state norn last moved it to.
 */
export async function leftState(ctx: Ctx, issue: Issue, flow: Flow): Promise<string | null> {
  if (issue.state === "closed" || flowStatesOf(issue, flow).length) return null;
  const renamed = Object.keys(flow.renamed ?? {}).find((s) => issue.labels.includes(s));
  if (renamed) return renamed;
  const comments = await ctx.github.listComments(issue.number);
  for (const body of [...comments].reverse()) {
    const t = parseTransitionComment(body);
    if (!t) continue;
    const ended = t.to === "closed" || t.to === "closed as not planned";
    return ended || Object.hasOwn(flow.states, t.to) ? null : t.to;
  }
  return null;
}

/** Moves an issue in a renamed state to its new name, under the claim this session holds. */
export async function followRename(ctx: Ctx, issue: Issue, flow: Flow, name: string, from: string, to: string): Promise<void> {
  const n = issue.number;
  await ensureStateLabel(ctx, flow, to);
  await ctx.github.addLabels(n, [to]);
  await ctx.github.comment(n, `norn: ${from} → ${to} (automatic)\n\nThe flow ${name} renamed the state ${from} to ${to}.`);
  await ctx.github.removeLabels(n, [from]);
  issue.labels = [...issue.labels.filter((l) => l !== from), to];
}

/** Hands an issue in a state its flow no longer has to a person, under the claim this session holds. */
export async function handOverLeft(ctx: Ctx, issue: Issue, name: string, state: string): Promise<void> {
  const n = issue.number;
  const why = `the state ${state} is no longer in the flow ${name}`;
  await ctx.github.addLabels(n, ["needs-human"]);
  await ctx.github.comment(n, needsHumanLine(why));
  // The old label goes, so the resolve step moves the issue into a state of the flow.
  await ctx.github.removeLabels(n, [state, "in-progress"]);
  await notifyNeedsHuman(ctx, n, why);
}

/**
 * Every state label on the issue except `keep`: of its repository flow, or of
 * the built-in process. A failed removal can leave two state labels; removing
 * all of them on the next transition cleans that up.
 */
export function stateLabels(issue: Issue, keep?: string, flow: Flow | null = null): string[] {
  return (flow ? Object.keys(flow.states) : STATES).filter((s) => s !== keep && issue.labels.includes(s));
}

/** A state's label colour and description when the state names none, by its kind. */
export const DEFAULT_STATE_LABEL = {
  attended: { color: "c5def5", description: "a person takes part in this step" },
  agent: { color: "bfd4f2", description: "an agent runs this step unattended" },
} as const;

/**
 * Creates the label of a state of a repository flow when the repository lacks
 * it, so a merged flow works without norn init. The colour and description come
 * from the state, or a default by kind. Built-in labels are made by norn init.
 */
export async function ensureStateLabel(ctx: Ctx, flow: Flow, state: string): Promise<void> {
  const s = flow.states[state];
  if (!s || (await ctx.github.labelNames()).includes(state)) return;
  const fallback = s.attended ? DEFAULT_STATE_LABEL.attended : DEFAULT_STATE_LABEL.agent;
  await ctx.github.ensureLabels([{ name: state, color: s.color ?? fallback.color, description: s.description ?? fallback.description }]);
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
    await ctx.github.comment(story.number, `norn: merge-queue → closed (automatic)\n\nThe story PR #${pr.number} is merged into ${pr.base}.`);
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
