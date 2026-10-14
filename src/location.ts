import { join } from "node:path";
import type { GitHub, Issue } from "./github.js";
import { kindOf } from "./machine.js";
import { storySlug, type Slugs } from "./slug.js";
import { sliceBranch, storyBranch, worktreePath } from "./text.js";
import type { Provider, Workspace } from "./workspace.js";

/** Where an issue's work happens: its branch, the branch it starts from, and its worktree. */
export interface Location {
  branch: string;
  base: string;
  worktree: string;
  /** The story, for a slice; the issue itself, for a story. */
  story: Issue;
  /** The story's recorded slug. */
  slug: string;
}

export async function locate(issue: Issue, ctx: { github: GitHub; slugs: Slugs; config: { baseBranch: string } }): Promise<Location | null> {
  if (kindOf(issue) === "story") {
    const slug = await storySlug(ctx, issue);
    const branch = storyBranch(issue.number, slug);
    return { branch, base: ctx.config.baseBranch, worktree: worktreePath(branch), story: issue, slug };
  }
  if (kindOf(issue) === "slice") {
    const parent = await ctx.github.parentOf(issue.number);
    if (!parent) return null;
    const story = await ctx.github.getIssue(parent);
    const slug = await storySlug(ctx, story);
    const branch = sliceBranch(story.number, slug, issue.number);
    return { branch, base: storyBranch(story.number, slug), worktree: worktreePath(branch), story, slug };
  }
  return null;
}

/** Where the item's branch exists already: in this clone, on GitHub, both, or nowhere yet. */
export interface BranchAt {
  local: boolean;
  remote: boolean;
}

export async function branchAt(loc: Location, workspace: Workspace, github: GitHub): Promise<BranchAt> {
  return { local: await workspace.localBranchExists(loc.branch), remote: await github.branchExists(loc.branch) };
}

/**
 * The command that creates the worktree with the given tool. Paths are absolute
 * and git runs against the main checkout, so it works from any directory.
 * - A local branch that is also on GitHub is fast-forwarded inside the new
 *   worktree, e.g. a story branch behind slices merged there. A branch ahead of
 *   GitHub keeps its commits; one that has diverged gets its worktree, and the
 *   failing --ff-only says so.
 * - A branch only on GitHub is fetched and checked out with its commits.
 * - A new branch starts from the base as it is on GitHub, without tracking it.
 * herdr ignores --base for an existing local branch and otherwise tracks the
 * base, so a new branch is made with git first and handed to herdr.
 */
export function createWorktreeCommand(provider: Provider, loc: Location, root: string, at: BranchAt): string {
  const path = join(root, loc.worktree);
  const git = `git -C ${root}`;
  const { branch, base } = loc;
  const herdr = (extra: string) => `herdr worktree create --cwd ${root} --branch ${branch}${extra} --path ${path} --no-focus`;
  const add = provider === "herdr" ? herdr("") : `${git} worktree add ${path} ${branch}`;
  if (at.local) return at.remote ? `${git} fetch origin ${branch} && ${add} && git -C ${path} merge --ff-only origin/${branch}` : add;
  if (at.remote) {
    return provider === "herdr"
      ? `${git} fetch origin ${base} ${branch} && ${herdr(` --base origin/${branch}`)}`
      : `${git} fetch origin ${branch} && ${add}`;
  }
  return provider === "herdr"
    ? `${git} fetch origin ${base} && ${git} branch --no-track ${branch} origin/${base} && ${herdr("")}`
    : `${git} fetch origin ${base} && ${git} worktree add --no-track ${path} -b ${branch} origin/${base}`;
}

/** Auto-detection, in order: herdr, then Claude Code, then plain git. */
export function detectProvider(env: Record<string, string | undefined>): Provider {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.CLAUDECODE === "1") return "claude-code";
  return "git";
}

/** "Work in" lines of a briefing. */
export async function workInLines(loc: Location, workspace: Workspace, github: GitHub, provider: Provider): Promise<string[]> {
  const lines = [`Work in: ${join(workspace.root, loc.worktree)} (branch ${loc.branch})`];
  if (!(await workspace.worktreeExists(loc.worktree))) {
    const elsewhere = await workspace.branchCheckedOutAt(loc.branch);
    if (elsewhere) {
      lines.push(checkedOutElsewhere(loc.branch, elsewhere));
      return lines;
    }
    const at = await branchAt(loc, workspace, github);
    lines.push("It does not exist yet. Create it first:", `  ${createWorktreeCommand(provider, loc, workspace.root, at)}`);
  }
  return lines;
}

/** git checks a branch out in one worktree only, so no create command can work. */
export function checkedOutElsewhere(branch: string, path: string) {
  return `Branch ${branch} is checked out at ${path}; work there or switch that checkout to another branch.`;
}
