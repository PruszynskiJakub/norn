import { win32 } from "node:path";

export type Provider = "herdr" | "claude-code" | "git";

/**
 * A path in one form for comparing: forward slashes, no trailing slash, and
 * on Windows a lower-case drive letter. git prints C:/a/b where Node joins
 * C:\a\b, so the two never match as strings.
 */
export function comparablePath(p: string, platform = process.platform) {
  const forward = (platform === "win32" ? win32.normalize(p) : p).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? forward.replace(/^[A-Z]:/, (d) => d.toLowerCase()) : forward;
}

export function samePath(a: string, b: string, platform = process.platform) {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

/** Whether `path` is `dir` or inside it. */
export function isWithin(path: string, dir: string, platform = process.platform) {
  const p = comparablePath(path, platform);
  const d = comparablePath(dir, platform);
  return p === d || p.startsWith(`${d}/`);
}

/** The local machine: the repository checkout, its worktrees and the environment. */
export interface Workspace {
  /** Absolute path of the main repository checkout. */
  root: string;
  /** Absolute path shepherd was started in; may be inside a worktree. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Reads a file relative to root; null when missing. */
  readFile(rel: string): Promise<string | null>;
  worktreeExists(rel: string): Promise<boolean>;
  localBranchExists(branch: string): Promise<boolean>;
  /** Absolute path of the checkout or worktree that has the branch checked out; null when none. */
  branchCheckedOutAt(branch: string): Promise<string | null>;
  /** Whether the worktree has uncommitted or untracked changes. */
  worktreeDirty(rel: string): Promise<boolean>;
  removeWorktree(rel: string, provider: Provider): Promise<void>;
  /** Every worktree of the repository, main checkout included: absolute path and checked-out branch. */
  listWorktrees(): Promise<{ path: string; branch: string | null }[]>;
  listLocalBranches(): Promise<string[]>;
  /** The commit a local branch points at; null when there is no such branch. */
  branchHead(branch: string): Promise<string | null>;
  /** Whether the local branch has commits that no remote-tracking branch has. */
  hasUnpushedCommits(branch: string): Promise<boolean>;
  /** Deletes a local branch; the caller has made sure nothing on it would be lost. */
  deleteLocalBranch(branch: string): Promise<void>;
  /** Updates the remote-tracking branches from GitHub, dropping those deleted there. */
  fetchRemote(): Promise<void>;
  /**
   * The files under `dir` (relative to cwd, or absolute), with paths relative
   * to it; null when it is not a directory.
   */
  readEvidence(dir: string): Promise<{ path: string; content: Buffer }[] | null>;
}
