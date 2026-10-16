import { join } from "node:path";
import type { Flow } from "./flow.js";
import type { GitHub, Issue } from "./github.js";

import { storySlug, type Slugs } from "./slug.js";
import { sh, sliceBranch, storyBranch, worktreePath } from "./text.js";
import type { Provider, Workspace } from "./workspace.js";

/** Where an issue's work happens: its branch, the branch it starts from, and its worktree. */
export interface Location {
  branch: string;
  base: string;
  worktree: string;
  /** The parent, for an issue whose flow works in its parent's branch, e.g. a slice; else the issue itself. */
  story: Issue;
  /** The story's recorded slug. */
  slug: string;
}

/** `flow` is the issue's flow, when it runs one: its workspace decides. An issue with no flow has no workspace. */
export async function locate(
  issue: Issue,
  ctx: { github: GitHub; slugs: Slugs; config: { baseBranch: string } },
  flow: Flow | null = null,
): Promise<Location | null> {
  if (flow?.workspace === "none") return null;
  // An own workspace: a branch named after the issue, with a PR into the base branch.
  if (flow?.workspace === "own") {
    const slug = await storySlug(ctx, issue);
    const branch = storyBranch(issue.number, slug);
    return { branch, base: ctx.config.baseBranch, worktree: worktreePath(branch), story: issue, slug };
  }
  // A parent workspace is named after the parent's branch, which its PR goes into.
  if (flow?.workspace === "parent") {
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
export function createWorktreeCommand(provider: Provider, loc: Location, absRoot: string, at: BranchAt): string {
  // Every interpolated word is quoted, so a checkout under e.g. "/Users/Jane Doe" still works.
  const root = sh(absRoot);
  const path = sh(join(absRoot, loc.worktree));
  const git = `git -C ${root}`;
  const branch = sh(loc.branch);
  const base = sh(loc.base);
  const herdr = (extra: string) => `herdr worktree create --cwd ${root} --branch ${branch}${extra} --path ${path} --no-focus`;
  const add = provider === "herdr" ? herdr("") : `${git} worktree add ${path} ${branch}`;
  if (at.local) return at.remote ? `${git} fetch origin ${branch} && ${add} && git -C ${path} merge --ff-only origin/${branch}` : add;
  if (at.remote) {
    return provider === "herdr" ? `${git} fetch origin ${base} ${branch} && ${herdr(` --base origin/${branch}`)}` : `${git} fetch origin ${branch} && ${add}`;
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

/** Where a briefing says to work: the worktree, and what to do about it first. */
export interface WorkIn {
  /** Absolute path of the worktree. */
  path: string;
  branch: string;
  worktree:
    | { kind: "missing"; create: string }
    /** git checks a branch out in one worktree only, so no create command can work. */
    | { kind: "checked-out-elsewhere"; at: string }
    /** `dirty`: an earlier session may have stopped partway and left its work here. `update`: the command that catches it up with GitHub, when the branch is there. */
    | { kind: "exists"; dirty: boolean; update: string | null };
}

export async function workIn(loc: Location, workspace: Workspace, github: GitHub, provider: Provider): Promise<WorkIn> {
  const where = { path: join(workspace.root, loc.worktree), branch: loc.branch };
  if (!(await workspace.worktreeExists(loc.worktree))) {
    const elsewhere = await workspace.branchCheckedOutAt(loc.branch);
    if (elsewhere) return { ...where, worktree: { kind: "checked-out-elsewhere", at: elsewhere } };
    const at = await branchAt(loc, workspace, github);
    return { ...where, worktree: { kind: "missing", create: createWorktreeCommand(provider, loc, workspace.root, at) } };
  }
  const dirty = await workspace.worktreeDirty(loc.worktree);
  // Others push here too, e.g. slices merged into the story branch; catch up before starting.
  const update = (await github.branchExists(loc.branch)) ? updateWorktreeCommand(loc, workspace.root) : null;
  return { ...where, worktree: { kind: "exists", dirty, update } };
}

/** Fast-forwards an existing worktree to its branch on GitHub; a diverged branch fails and says so. */
export function updateWorktreeCommand(loc: Location, absRoot: string): string {
  const wt = `git -C ${sh(join(absRoot, loc.worktree))}`;
  return `${wt} fetch origin ${sh(loc.branch)} && ${wt} merge --ff-only origin/${sh(loc.branch)}`;
}
