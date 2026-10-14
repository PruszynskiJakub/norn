import { join } from "node:path";
import type { GitHub, Issue } from "./github.js";
import { kindOf } from "./machine.js";
import { sliceBranch, storyBranch, worktreePath } from "./text.js";
import type { Provider, Workspace } from "./workspace.js";

/** Where an issue's work happens: its branch, the branch it starts from, and its worktree. */
export interface Location {
  branch: string;
  base: string;
  worktree: string;
  /** The story, for a slice; the issue itself, for a story. */
  story: Issue;
}

export async function locate(issue: Issue, github: GitHub, baseBranch: string): Promise<Location | null> {
  if (kindOf(issue) === "story") {
    const branch = storyBranch(issue.number, issue.title);
    return { branch, base: baseBranch, worktree: worktreePath(branch), story: issue };
  }
  if (kindOf(issue) === "slice") {
    const parent = await github.parentOf(issue.number);
    if (!parent) return null;
    const story = await github.getIssue(parent);
    const branch = sliceBranch(story.number, story.title, issue.number);
    return { branch, base: storyBranch(story.number, story.title), worktree: worktreePath(branch), story };
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
 * - A local branch that is also on GitHub is fast-forwarded first, e.g. a story
 *   branch behind slices merged there; the fetch refuses if it has diverged.
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
  if (at.local) return at.remote ? `${git} fetch origin ${branch}:${branch} && ${add}` : add;
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
    const at = await branchAt(loc, workspace, github);
    lines.push("It does not exist yet. Create it first:", `  ${createWorktreeCommand(provider, loc, workspace.root, at)}`);
  }
  return lines;
}
