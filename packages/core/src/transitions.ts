import { acquire, claimRecord } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import type { Outcome } from "./machine.js";
import { locate } from "./location.js";
import { SLUG_MARK, slugLine, storySlug, type Slugs } from "./slug.js";
import { specPath, storyBranch } from "./text.js";
import type { Workspace } from "./workspace.js";
import type { Config } from "./config.js";
import type { BaseBranchMissing, Event, FollowUpTask } from "./events.js";
import { type Flow, flowStatesOf, hasSpec, type LabelDefinition, type Mode, type NamedFlow, renamedTo, stateLabel, typeLabel } from "./flow.js";
import { type FlowCache, loadFlow, validFlow } from "./flow-loading.js";
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
 * `fixStates` are the states that count: those of the issue's flow that opt
 * into countsFixRounds.
 */
export function fixRounds(comments: string[], fixStates: readonly string[]): number {
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
  /** The machine norn runs on, e.g. its host name: a herdr pane is one on this machine only. */
  machine: string;
  /** Waits, e.g. between norn wait's reads of GitHub; tests pass one that moves their clock instead. */
  sleep: (ms: number) => Promise<void>;
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

/** A transition comment norn wrote, read back: what applyOutcome, setState and waitsForMerge put in it. */
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

/** How an outcome is applied: the word said, the note and evidence that go in the comment, and what the mode skipped. */
export interface Applying {
  /** The outcome word; empty for a step with a single way to end. */
  word: string;
  note?: string;
  evidence?: Evidence;
  /** The issue's flow, with its name; null for a new issue, which triage gives one. */
  flow: NamedFlow | null;
  /** The line naming the states the issue's mode skipped; null for none. */
  skipped: string | null;
}

/**
 * Applies an outcome to an issue whose claim this session holds: labels,
 * comment and closing. The automatic transitions that follow are in followUps.
 */
export async function applyOutcome(ctx: Ctx, issue: Issue, outcome: Outcome, { word, note, evidence, flow: named, skipped }: Applying): Promise<void> {
  const { github } = ctx;
  const flow = named?.flow ?? null;
  const n = issue.number;
  // An issue whose state its flow dropped moves on from that state.
  const left = flow ? await leftState(ctx, issue, flow) : null;
  const from = (flow ? (flowStatesOf(issue, flow)[0] ?? left) : null) ?? "triage";
  // The resolve step has no outcome word and keeps the state; say what it did.
  const resolved = !word && issue.labels.includes("needs-human") && !outcome.needsHuman;
  const why = word || (resolved ? "needs-human resolved" : "");
  const comment = [`norn: ${from} → ${outcome.to === "not-planned" ? "closed as not planned" : outcome.to}${why ? ` (${why})` : ""}`];
  const spec = await specLink(ctx, issue, flow);
  if (spec) comment.push("", `Spec: ${spec}`);
  // Triage gives the issue its flow, which it enters here.
  const into = flow ?? (outcome.flow ? validFlow(await loadFlow(ctx, outcome.flow)) : null);
  // An issue whose flow gives it a branch of its own records its slug the first time norn writes on it, triage included.
  const slug = into?.workspace === "own" ? await slugLine(ctx, issue) : null;
  if (slug) comment.push("", slug);
  if (skipped) comment.push("", skipped);
  if (note) comment.push("", note);
  if (evidence) comment.push("", ...evidenceLines(await github.repoUrl(), evidence));

  // The new state is written before the old labels go, so a failure in between
  // leaves an issue norn can still act on, never one with no state.
  if (outcome.to === "not-planned" || outcome.to === "closed") {
    await github.comment(n, comment.join("\n"));
    await github.closeIssue(n, outcome.to === "closed" ? "completed" : "not_planned");
    await github.removeLabels(n, ["in-progress", "needs-human", ...stateLabels(issue, undefined, into)]);
  } else {
    const add: string[] = [outcome.to];
    if (into) await ensureStateLabel(ctx, into, outcome.to);
    if (!flow && outcome.flow) {
      await ensureTypeLabel(ctx, outcome.flow);
      add.push(`type:${outcome.flow}`);
      await github.assign(n, [await github.currentUser()]);
    }
    if (outcome.needsHuman) {
      add.push("needs-human");
      comment.push("", needsHumanLine(outcome.needsHuman));
    }
    const remove = ["in-progress", ...(outcome.needsHuman ? [] : ["needs-human"]), ...stateLabels(issue, outcome.to, into), ...(left ? [left] : [])];
    await github.addLabels(n, add);
    await github.comment(n, comment.join("\n"));
    await github.removeLabels(n, remove);
    if (outcome.needsHuman) await notifyNeedsHuman(ctx, n, outcome.needsHuman);
    else if (outcome.notify && named) await notifyHumanQa(ctx, n, { flow: named.name, mode: flow?.states[outcome.to]?.when ?? null });
  }
}

/**
 * Sets needs-human on an issue whose claim this session holds, with the reason as the marker norn reads back, notifies
 * the user and releases the claim. `full` is the reason with its line breaks, kept in a paragraph of its own.
 */
export async function flagNeedsHuman(ctx: Ctx, n: number, why: string, full?: string): Promise<void> {
  const { github } = ctx;
  await github.addLabels(n, ["needs-human"]);
  await github.removeLabels(n, ["in-progress"]);
  await github.comment(n, [needsHumanLine(why), ...(full?.includes("\n") ? ["", full] : [])].join("\n"));
  await notifyNeedsHuman(ctx, n, why);
  await github.deleteClaim(n);
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

/** Creates the branch of an issue with a workspace of its own from the base branch, unless it is already on GitHub. */
export async function ensureOwnBranch(ctx: Ctx, issue: Issue): Promise<Ensured> {
  const branch = storyBranch(issue.number, await storySlug(ctx, issue));
  if (await ctx.github.branchExists(branch)) return { ok: true, created: false, branch };
  const base = ctx.config.baseBranch;
  if (!(await ctx.github.branchExists(base))) return { ok: false, refusal: { kind: "base-branch-missing", branch, base } };
  await ctx.github.createBranch(branch, base);
  return { ok: true, created: true, branch };
}

/** The spec a transition comment links: the issue's own when its flow writes one, or the parent's for an issue that works in its parent's branch. */
async function specLink(ctx: Ctx, issue: Issue, flow: Flow | null): Promise<string | null> {
  let story = flow?.workspace === "own" && hasSpec(flow) ? issue : null;
  if (flow?.workspace === "parent") {
    const p = await ctx.github.parentOf(issue.number);
    if (p) story = await ctx.github.getIssue(p);
  }
  if (!story) return null;
  // The spec lives on the story branch; a local HEAD may be main or an unpushed commit.
  const slug = await storySlug(ctx, story);
  return `${await ctx.github.repoUrl()}/blob/${storyBranch(story.number, slug)}/${specPath(story.number, slug)}`;
}

/** Changes labels on an issue this session does not hold, by taking a short claim. */
export async function withShortClaim(ctx: Ctx, n: number, fn: () => Promise<void>): Promise<boolean> {
  const user = await ctx.github.currentUser();
  const got = await acquire(ctx.github, n, claimRecord(ctx, user), ctx.now(), ctx.config.staleAfterMs);
  if (!got.ok) return false;
  try {
    await fn();
  } finally {
    // A claim this session already held stays held.
    if (!got.reacquired) await ctx.github.deleteClaim(n);
  }
  return true;
}

/** Moves an issue of `flow` to `to` on norn's own, saying why, under a claim this session holds. */
export async function setState(ctx: Ctx, issue: Issue, to: string, why: string, flow: Flow) {
  const from = flowStatesOf(issue, flow)[0] ?? null;
  // An issue with a branch of its own from before the slug marker records it here, under the short claim.
  const slug = flow.workspace === "own" ? await slugLine(ctx, issue) : null;
  await ensureStateLabel(ctx, flow, to);
  await ctx.github.addLabels(issue.number, [to]);
  await ctx.github.comment(issue.number, `norn: ${from} → ${to} (automatic)\n\n${why}${slug ? `\n\n${slug}` : ""}`);
  await ctx.github.removeLabels(issue.number, stateLabels(issue, to, flow));
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

/** What norn did with an issue left in a state its flow no longer has. */
export type Settled = Extract<Event, { kind: "state-renamed" | "handed-over" }>;

/**
 * For an issue in a state its flow no longer has: follows the flow's `renamed` to the state's new name, or hands the
 * issue to a person through needs-human. Null, changing nothing, for an issue in a state of its flow. Runs under a
 * claim this session holds; `issue` is changed to what it left. It sends no notification: the caller says whether a
 * hand-over is told to the user, so norn wait can compute what next would without notifying on every check.
 */
export async function settleLeftState(ctx: Ctx, issue: Issue, { name, flow }: NamedFlow): Promise<Settled | null> {
  const from = await leftState(ctx, issue, flow);
  if (from === null) return null;
  const to = renamedTo(flow, from);
  if (to !== null) {
    await followRename(ctx, issue, flow, name, from, to);
    return { kind: "state-renamed", issue: issue.number, from, to, flow: name };
  }
  await handOverLeft(ctx, issue, name, from);
  return { kind: "handed-over", issue: issue.number, state: from, flow: name };
}

/** Moves an issue in a renamed state to its new name, under the claim this session holds. */
async function followRename(ctx: Ctx, issue: Issue, flow: Flow, name: string, from: string, to: string): Promise<void> {
  const n = issue.number;
  await ensureStateLabel(ctx, flow, to);
  await ctx.github.addLabels(n, [to]);
  await ctx.github.comment(n, `norn: ${from} → ${to} (automatic)\n\nThe flow ${name} renamed the state ${from} to ${to}.`);
  await ctx.github.removeLabels(n, [from]);
  issue.labels = [...issue.labels.filter((l) => l !== from), to];
}

/** Hands an issue in a state its flow no longer has to a person, under the claim this session holds; see notifySettled. */
async function handOverLeft(ctx: Ctx, issue: Issue, name: string, state: string): Promise<void> {
  const n = issue.number;
  await ctx.github.addLabels(n, ["needs-human"]);
  await ctx.github.comment(n, needsHumanLine(`the state ${state} is no longer in the flow ${name}`));
  // The old label goes, so the resolve step moves the issue into a state of the flow.
  await ctx.github.removeLabels(n, [state, "in-progress"]);
  issue.labels = [...issue.labels.filter((l) => l !== state && l !== "in-progress"), "needs-human"];
}

/**
 * Every state label of the issue's flow on the issue except `keep`; none
 * without a flow. A failed removal can leave two state labels; removing all of
 * them on the next transition cleans that up.
 */
export function stateLabels(issue: Issue, keep?: string, flow: Flow | null = null): string[] {
  return (flow ? Object.keys(flow.states) : []).filter((s) => s !== keep && issue.labels.includes(s));
}

/**
 * Creates the label of a state of a flow when the repository lacks it, so a
 * merged flow works without norn init. The colour and description come from the
 * state, or a default by kind; a built-in flow's match what norn init makes.
 */
export async function ensureStateLabel(ctx: Ctx, flow: Flow, state: string): Promise<void> {
  if (flow.states[state]) await ensureLabel(ctx, stateLabel(flow, state));
}

/** Creates the label type:<name> of a flow when the repository lacks it, as norn init makes it. */
export async function ensureTypeLabel(ctx: Ctx, name: string): Promise<void> {
  await ensureLabel(ctx, typeLabel(name));
}

/** Creates a label when the repository lacks it; one it has is left as it is. */
async function ensureLabel(ctx: Ctx, label: LabelDefinition): Promise<void> {
  if (!(await ctx.github.repositoryLabels()).some((l) => l.name === label.name)) await ctx.github.ensureLabels([label]);
}

/**
 * Removes the state labels of its flow a closed issue still carries, e.g. one
 * GitHub closed through its PR. Returns whether it changed anything.
 */
export async function clearClosedState(ctx: Ctx, issue: Issue, flow: Flow | null): Promise<boolean> {
  const left = stateLabels(issue, undefined, flow);
  if (issue.state !== "closed" || left.length === 0) return false;
  return withShortClaim(ctx, issue.number, () => ctx.github.removeLabels(issue.number, left));
}

/** Why a slice's merge cannot finish yet. `pr` is the slice PR, `head` its branch and `base` the parent's branch it goes into. */
export type MergeRefusal =
  | { kind: "not-in-story"; issue: number }
  | { kind: "no-slice-pr"; issue: number; head: string }
  /** A slice PR into anything but the story branch skips story review and misses the story PR. */
  | { kind: "slice-pr-wrong-base"; issue: number; pr: number; head: string; base: string; storyBranch: string; merged: boolean }
  /** The PR was closed without being merged. */
  | { kind: "slice-pr-closed"; issue: number; pr: number; head: string; base: string }
  | { kind: "slice-pr-conflicts"; issue: number; pr: number; head: string; base: string }
  /** The PR lacks commits of the parent's branch, so its checks did not run on what the merge makes. */
  | { kind: "slice-pr-behind"; issue: number; pr: number; head: string; base: string }
  /** GitHub is still working out whether the PR merges cleanly. */
  | { kind: "slice-pr-mergeability-unknown"; issue: number; pr: number }
  /** `checks` are the names of the failed ones. */
  | { kind: "slice-pr-checks-failed"; issue: number; pr: number; checks: string[] }
  /** `pending` is how many are still running. */
  | { kind: "slice-pr-checks-pending"; issue: number; pr: number; pending: number }
  /** The PR's head moved after norn read its checks, so the commit merged would be one nobody checked. */
  | { kind: "slice-pr-head-moved"; issue: number; pr: number; head: string; base: string }
  /** GitHub refused the merge, e.g. for branch protection on the parent's branch; `detail` is its reason. */
  | { kind: "slice-pr-merge-refused"; issue: number; pr: number; detail: string };

/** The slice PR from the issue's branch, where it must go, and why there is none to merge; see mergeRefusal. */
async function slicePr(ctx: Ctx, issue: Issue, flow: Flow) {
  const n = issue.number;
  const loc = await locate(issue, ctx, flow);
  if (!loc) return { refusal: { kind: "not-in-story", issue: n } as MergeRefusal };
  const head = loc.branch;
  const base = loc.base;
  const pr = await ctx.github.findPullRequest(head);
  if (!pr) return { refusal: { kind: "no-slice-pr", issue: n, head } as MergeRefusal };
  // Never the base branch: the story PR into it stays its owner's to merge.
  if (pr.base !== base || base === ctx.config.baseBranch) {
    return {
      refusal: { kind: "slice-pr-wrong-base", issue: n, pr: pr.number, head, base: pr.base, storyBranch: base, merged: pr.state === "merged" } as MergeRefusal,
    };
  }
  if (pr.state === "closed") return { refusal: { kind: "slice-pr-closed", issue: n, pr: pr.number, head, base } as MergeRefusal };
  return { pr, head, base };
}

/** Precondition for finishing a merge: the PR from the issue's branch goes into its parent's branch, and is open or merged there. */
export async function mergeRefusal(ctx: Ctx, issue: Issue, flow: Flow): Promise<MergeRefusal | null> {
  return (await slicePr(ctx, issue, flow)).refusal ?? null;
}

/**
 * Merges the slice PR into its parent's branch, with a merge commit, once it is ready: no conflicts, up to date with the
 * parent's branch, and every check on its head passed (a repository without checks merges once it is mergeable). Only
 * the head whose checks were read is merged. A PR a person already merged needs nothing. A refusal changes nothing.
 */
export async function mergeSlicePr(ctx: Ctx, issue: Issue, flow: Flow): Promise<MergeRefusal | null> {
  const found = await slicePr(ctx, issue, flow);
  if (found.refusal) return found.refusal;
  const { pr, head, base } = found;
  if (pr.state === "merged") return null;
  const n = issue.number;
  const at = { issue: n, pr: pr.number };
  const ready = await ctx.github.pullRequestReadiness(pr.number);
  if (ready.mergeable === "conflicting") return { kind: "slice-pr-conflicts", ...at, head, base };
  if (ready.mergeable === "unknown") return { kind: "slice-pr-mergeability-unknown", ...at };
  if (ready.behind) return { kind: "slice-pr-behind", ...at, head, base };
  const failed = ready.checks.filter((c) => c.state === "failed").map((c) => c.name);
  if (failed.length) return { kind: "slice-pr-checks-failed", ...at, checks: failed };
  const pending = ready.checks.filter((c) => c.state === "pending").length;
  if (pending) return { kind: "slice-pr-checks-pending", ...at, pending };
  const merge = await ctx.github.mergeAtHead(pr.number, ready.headSha);
  if (merge.merged) return null;
  // GitHub's words are not parsed: the head is read again to tell a push in between from any other refusal.
  const now = await ctx.github.findPullRequest(head);
  if (now?.state === "merged") return null;
  if ((await ctx.github.pullRequestReadiness(pr.number)).headSha !== ready.headSha) return { kind: "slice-pr-head-moved", ...at, head, base };
  return { kind: "slice-pr-merge-refused", ...at, detail: merge.detail };
}
