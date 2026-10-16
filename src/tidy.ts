import { join, relative } from "node:path";
import type { Issue, PullRequest } from "./github.js";
import { kindOf, slicesOf } from "./machine.js";
import { storySlug } from "./slug.js";
import { sliceBranch, storyBranch, worktreePath } from "./text.js";
import type { Ctx } from "./transitions.js";
import { isWithin, samePath } from "./workspace.js";

/** The branch QA evidence of an issue is pushed to. */
export function qaBranch(n: number) {
  return `psdd/qa/${n}`;
}

export interface TidyReport {
  dryRun: boolean;
  /** What was removed, or with --dry-run what would be. */
  removed: string[];
  /** What was left because removing it could lose work, and why. */
  kept: string[];
  /** Removals that failed; the rest still ran. */
  failed: string[];
  /** Anything that makes the checks less sure, e.g. a fetch that failed. */
  notes: string[];
}

/** A psdd branch and the issue it belongs to. */
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
export async function tidy(ctx: Ctx, dryRun: boolean): Promise<TidyReport> {
  const { github, workspace } = ctx;
  const report: TidyReport = { dryRun, removed: [], kept: [], failed: [], notes: [] };
  /** Removes one thing, or with --dry-run only lists it. A failure is reported and the rest still runs. */
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      if (!dryRun) await fn();
      report.removed.push(what);
      return true;
    } catch (e) {
      report.failed.push(`${what}: ${(e as Error).message}`);
      return false;
    }
  };

  const issues = new Map<number, Promise<Issue | null>>();
  // A number with no issue behind it, e.g. a branch someone named by hand, is not psdd's.
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
    report.notes.push(`Could not fetch from GitHub, so work pushed since the last fetch counts as unpushed and is kept: ${(e as Error).message}`);
  }

  for (const branch of await github.listBranches("psdd/qa/")) {
    const n = Number(branch.slice("psdd/qa/".length));
    if (Number.isInteger(n) && (await closed(n))) await attempt(`QA evidence branch ${branch} (#${n} is closed)`, () => github.deleteBranch(branch));
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
    const who = `${kindOf(owned.issue)} #${n}`;
    // Commits that are on no remote branch were never pushed, unless they are what the PR merged.
    const unpushed = async () => local.has(branch) && (await workspace.hasUnpushedCommits(branch)) && !(await mergedHead(ctx, branch, pr));

    const wtAbs = join(workspace.root, worktreePath(branch));
    const checkedOut = worktrees.find((w) => w.branch === branch);
    let localFree = !checkedOut;
    if (checkedOut && samePath(checkedOut.path, wtAbs)) {
      const rel = relative(workspace.root, wtAbs);
      let keep: string | null = null;
      if (isWithin(workspace.cwd, wtAbs)) keep = "psdd is running inside it. Run psdd tidy from another directory to remove it.";
      else if (await workspace.worktreeDirty(rel)) keep = "it has uncommitted changes. Commit and push them, or remove it by hand when done.";
      else if (await unpushed()) keep = `branch ${branch} has commits that are not on GitHub. Push them, or remove it by hand when done.`;
      // A kept worktree keeps its branch too, here and on GitHub, so its work can still be pushed.
      if (keep) {
        report.kept.push(`${wtAbs}: ${keep}`);
        continue;
      }
      localFree = await attempt(`worktree ${rel} (${who} is closed)`, () => workspace.removeWorktree(rel, ctx.config.provider));
    } else if (checkedOut && merged && local.has(branch)) {
      report.kept.push(`branch ${branch}: it is checked out at ${checkedOut.path}. Switch that checkout to another branch to let psdd tidy remove it.`);
    }
    if (!merged) continue;
    const where = `merged into ${owned.into}`;
    if (local.has(branch) && localFree) {
      if (await unpushed()) {
        report.kept.push(`branch ${branch}: it has commits that are not on GitHub. Push them, or delete it by hand.`);
        continue;
      }
      await attempt(`local branch ${branch} (${where})`, () => workspace.deleteLocalBranch(branch));
    }
    if (remote.has(branch)) await attempt(`branch ${branch} on GitHub (${where})`, () => github.deleteBranch(branch));
  }

  for (const n of (await github.listClaims()).sort((a, b) => a - b)) {
    if (await closed(n)) await attempt(`claim on #${n} (#${n} is closed)`, () => github.deleteClaim(n));
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
 * its slices. Anything else, e.g. a branch named by hand, is not psdd's.
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

export function renderTidy(r: TidyReport): string {
  const out: string[] = [...r.notes];
  if (r.removed.length) {
    out.push(r.dryRun ? "psdd tidy would remove (dry run, nothing was changed):" : "psdd tidy removed:", ...r.removed.map((x) => `  - ${x}`));
  }
  if (r.kept.length) out.push("Kept, so no work is lost:", ...r.kept.map((x) => `  - ${x}`));
  if (r.failed.length) out.push("Could not remove, the rest still ran:", ...r.failed.map((x) => `  - ${x}`));
  if (out.length === r.notes.length) out.push("Nothing to tidy: nothing is left of closed issues.");
  return out.join("\n");
}
