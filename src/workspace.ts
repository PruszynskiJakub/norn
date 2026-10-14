export type Provider = "herdr" | "claude-code" | "git";

/** The local machine: the repository checkout, its worktrees and the environment. */
export interface Workspace {
  /** Absolute path of the main repository checkout. */
  root: string;
  /** Absolute path psdd was started in; may be inside a worktree. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** Reads a file relative to root; null when missing. */
  readFile(rel: string): Promise<string | null>;
  worktreeExists(rel: string): Promise<boolean>;
  localBranchExists(branch: string): Promise<boolean>;
  removeWorktree(rel: string, provider: Provider): Promise<void>;
}
