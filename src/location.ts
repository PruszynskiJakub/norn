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

/** Where the item's branch exists already: in this clone, only on GitHub, or nowhere yet. */
export type BranchAt = "local" | "remote" | "none";

export async function branchAt(loc: Location, workspace: Workspace, github: GitHub): Promise<BranchAt> {
  if (await workspace.localBranchExists(loc.branch)) return "local";
  return (await github.branchExists(loc.branch)) ? "remote" : "none";
}

/**
 * The command that creates the worktree with the given tool. Paths are absolute
 * and git runs against the main checkout, so it works from any directory. A new
 * branch starts from the base as it is on GitHub, fetched first.
 */
export function createWorktreeCommand(provider: Provider, loc: Location, root: string, at: BranchAt): string {
  const path = join(root, loc.worktree);
  const git = `git -C ${root}`;
  if (provider === "herdr") {
    const fetch = at === "remote" ? `${git} fetch origin ${loc.base} ${loc.branch}` : `${git} fetch origin ${loc.base}`;
    return `${fetch} && herdr worktree create --cwd ${root} --branch ${loc.branch} --base origin/${loc.base} --path ${path} --no-focus`;
  }
  if (at === "local") return `${git} worktree add ${path} ${loc.branch}`;
  if (at === "remote") return `${git} fetch origin ${loc.branch} && ${git} worktree add ${path} ${loc.branch}`;
  return `${git} fetch origin ${loc.base} && ${git} worktree add --no-track ${path} -b ${loc.branch} origin/${loc.base}`;
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
