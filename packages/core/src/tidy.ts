import { join, relative } from "node:path";
import type { Issue, PullRequest } from "./github.js";
import { kindOf, slicesOf } from "./machine.js";
import { storySlug } from "./slug.js";
import { sliceBranch, storyBranch, worktreePath } from "./text.js";
import type { Ctx } from "./transitions.js";
import { isWithin, samePath } from "./workspace.js";

/** The branch QA evidence of an issue is pushed to. */
export function qaBranch(n: number) {
  return `shepherd/qa/${n}`;
}

/** Something tidy removes. `into` is where a branch was merged. */
export type Removal =
  | { kind: "qa-branch"; branch: string; issue: number }
  | { kind: "worktree"; path: string; of: "story" | "slice" | "new"; issue: number }
  | { kind: "local-branch"; branch: string; into: string }
  | { kind: "remote-branch"; branch: string; into: string }
  | { kind: "claim"; issue: number };

/** Something tidy leaves because removing it could lose work. Paths are absolute. */
export type Kept =
  | { kind: "worktree-in-use"; path: string }
  | { kind: "worktree-dirty"; path: string }
  | { kind: "worktree-unpushed"; path: string; branch: string }
  | { kind: "branch-checked-out"; branch: string; at: string }
  | { kind: "branch-unpushed"; branch: string };

export interface TidyResult {
  ok: true;
  kind: "tidy";
  dryRun: boolean;
  /** What was removed, or with --dry-run what would be. */
  removed: Removal[];
  kept: Kept[];
  /** Removals that failed, with the error; the rest still ran. */
  failed: { removal: Removal; detail: string }[];
  /** The fetch failed, so work pushed since the last fetch counts as unpushed and is kept; the error. */
  fetchFailed: string | null;
}

/** A shepherd branch and the issue it belongs to. */
interface Owned {
  branch: string;
  issue: Issue;
  /** Where the branch merges: the story branch for a slice, the base branch for a story. */
  into: string;
}

/**
 * Removes what belongs to closed issues: QA evidence branches, worktrees,
 * merged slice and story branches, and claim refs. Works it out from GitHub,
 * so it is safe to run at any time. Never removes a worktree or branch with
 * uncommitted or unpushed work, nor the worktree it runs in: those are named.
 */
export async function tidy(ctx: Ctx, dryRun: boolean): Promise<TidyResult> {
  const { github, workspace } = ctx;
  const report: TidyResult = { ok: true, kind: "tidy", dryRun, removed: [], kept: [], failed: [], fetchFailed: null };
  /** Removes one thing, or with --dry-run only lists it. A failure is reported and the rest still runs. */
  const attempt = async (removal: Removal, fn: () => Promise<void>) => {
    try {
      if (!dryRun) await fn();
      report.removed.push(removal);
      return true;
    } catch (e) {
      report.failed.push({ removal, detail: (e as Error).message });
      return false;
    }
  };

  const issues = new Map<number, Promise<Issue | null>>();
  // A number with no issue behind it, e.g. a branch someone named by hand, is not shepherd's.
  const issue = (n: number) => {
    let found = issues.get(n);
    if (!found) {
      found = github.getIssue(n).catch(() => null);
      issues.set(n, found);
    }
    return found;
  };
  const closed = async (n: number) => (await issue(n))?.state === "closed";

  try {
    await workspace.fetchRemote();
  } catch (e) {
    report.fetchFailed = (e as Error).message;
  }

  for (const branch of await github.listBranches("shepherd/qa/")) {
    const n = Number(branch.slice("shepherd/qa/".length));
    if (Number.isInteger(n) && (await closed(n))) await attempt({ kind: "qa-branch", branch, issue: n }, () => github.deleteBranch(branch));
  }

  const worktrees = await workspace.listWorktrees();
  const local = new Set(await workspace.listLocalBranches());
  const remote = new Set(await github.listBranches(""));
  const candidates = new Set([...local, ...remote, ...worktrees.flatMap((w) => (w.branch ? [w.branch] : []))]);
  const slices = new Map<number, Promise<Issue[]>>();
  for (const branch of [...candidates].sort()) {
    const owned = await ownerOf(ctx, branch, issue, slices);
    if (owned?.issue.state !== "closed") continue;
    const pr = await github.findPullRequest(branch);
    const merged = pr?.state === "merged" && pr.base === owned.into;
    const n = owned.issue.number;
    // Commits that are on no remote branch were never pushed, unless they are what the PR merged.
    const unpushed = async () => local.has(branch) && (await workspace.hasUnpushedCommits(branch)) && !(await mergedHead(ctx, branch, pr));

    const wtAbs = join(workspace.root, worktreePath(branch));
    const checkedOut = worktrees.find((w) => w.branch === branch);
    let localFree = !checkedOut;
    if (checkedOut && samePath(checkedOut.path, wtAbs)) {
      const rel = relative(workspace.root, wtAbs);
      let keep: Kept | null = null;
      if (isWithin(workspace.cwd, wtAbs)) keep = { kind: "worktree-in-use", path: wtAbs };
      else if (await workspace.worktreeDirty(rel)) keep = { kind: "worktree-dirty", path: wtAbs };
      else if (await unpushed()) keep = { kind: "worktree-unpushed", path: wtAbs, branch };
      // A kept worktree keeps its branch too, here and on GitHub, so its work can still be pushed.
      if (keep) {
        report.kept.push(keep);
        continue;
      }
      localFree = await attempt({ kind: "worktree", path: rel, of: kindOf(owned.issue), issue: n }, () => workspace.removeWorktree(rel, ctx.config.provider));
    } else if (checkedOut && merged && local.has(branch)) {
      report.kept.push({ kind: "branch-checked-out", branch, at: checkedOut.path });
    }
    if (!merged) continue;
    if (local.has(branch) && localFree) {
      if (await unpushed()) {
        report.kept.push({ kind: "branch-unpushed", branch });
        continue;
      }
      await attempt({ kind: "local-branch", branch, into: owned.into }, () => workspace.deleteLocalBranch(branch));
    }
    if (remote.has(branch)) await attempt({ kind: "remote-branch", branch, into: owned.into }, () => github.deleteBranch(branch));
  }

  for (const n of (await github.listClaims()).sort((a, b) => a - b)) {
    if (await closed(n)) await attempt({ kind: "claim", issue: n }, () => github.deleteClaim(n));
  }
  return report;
}

/** The local branch points at the commit its merged PR merged, so nothing on it is lost. */
async function mergedHead(ctx: Ctx, branch: string, pr: PullRequest | null) {
  if (pr?.state !== "merged" || !pr.headSha) return false;
  return (await ctx.workspace.branchHead(branch)) === pr.headSha;
}

/**
 * The story or slice a branch belongs to, from the story's recorded slug and
 * its slices. Anything else, e.g. a branch named by hand, is not shepherd's.
 */
async function ownerOf(ctx: Ctx, branch: string, issue: (n: number) => Promise<Issue | null>, slices: Map<number, Promise<Issue[]>>): Promise<Owned | null> {
  const m = /^(\d+)-/.exec(branch);
  if (!m) return null;
  const story = await issue(Number(m[1]));
  if (!story || kindOf(story) !== "story") return null;
  const own = storyBranch(story.number, await storySlug(ctx, story));
  if (branch === own) return { branch, issue: story, into: ctx.config.baseBranch };
  if (!branch.startsWith(`${own}-`)) return null;
  if (!slices.has(story.number)) slices.set(story.number, slicesOf(ctx.github, story.number));
  const slice = (await slices.get(story.number)!).find((s) => sliceBranch(story.number, own.slice(`${story.number}-`.length), s.number) === branch);
  return slice ? { branch, issue: slice, into: own } : null;
}
