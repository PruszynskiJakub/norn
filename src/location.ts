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

/** The command that creates the worktree with the given tool. */
export function createWorktreeCommand(provider: Provider, loc: Location, root: string, branchExists: boolean): string {
  if (provider === "herdr") {
    return `herdr worktree create --cwd ${root} --branch ${loc.branch} --base ${loc.base} --path ${loc.worktree} --no-focus`;
  }
  return branchExists
    ? `git worktree add ${loc.worktree} ${loc.branch}`
    : `git worktree add ${loc.worktree} -b ${loc.branch} ${loc.base}`;
}

/** Auto-detection, in order: herdr, then Claude Code, then plain git. */
export function detectProvider(env: Record<string, string | undefined>): Provider {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.CLAUDECODE === "1") return "claude-code";
  return "git";
}

/** "Work in" lines of a briefing. */
export async function workInLines(loc: Location, workspace: Workspace, provider: Provider): Promise<string[]> {
  const lines = [`Work in: ${loc.worktree} (branch ${loc.branch})`];
  if (!(await workspace.worktreeExists(loc.worktree))) {
    const exists = await workspace.localBranchExists(loc.branch);
    lines.push("It does not exist yet. Create it first:", `  ${createWorktreeCommand(provider, loc, workspace.root, exists)}`);
  }
  return lines;
}
