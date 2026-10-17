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

/** What the agent in a herdr pane is doing, as herdr reports it; `gone` when the pane runs no agent, `unknown` when norn cannot tell. */
export type AgentActivity = "working" | "idle" | "done" | "blocked" | "gone" | "unknown";

/** The agent in a pane, and how long it has been doing what it does now, as far as this process has watched it. */
export interface PaneActivity {
  activity: AgentActivity;
  forMs: number;
}

/** An agent herdr runs in a pane: the pane, the agent's name if it has one, and what it does. */
export interface PaneAgent {
  pane: string;
  name: string | null;
  activity: AgentActivity;
}

/** The local machine: the repository checkout, its worktrees and the environment. */
export interface Workspace {
  /** Absolute path of the main repository checkout. */
  root: string;
  /** Absolute path norn was started in; may be inside a worktree. */
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
  /** The URL of the origin remote; null when there is none. */
  originUrl(): Promise<string | null>;
  /** Updates the remote-tracking branches from GitHub, dropping those deleted there. */
  fetchRemote(): Promise<void>;
  /**
   * The files under `dir` (relative to cwd, or absolute), with paths relative
   * to it; null when it is not a directory.
   */
  readEvidence(dir: string): Promise<{ path: string; content: Buffer }[] | null>;
  /**
   * What the agent in a herdr pane of this machine does, and for how long. `unknown` outside herdr, or when herdr does
   * not answer: norn never acts on what it cannot observe.
   */
  agentActivity(pane: string): Promise<PaneActivity>;
  /** The agents herdr runs on this machine in `dir` (absolute) or below it, e.g. a worktree's; [] outside herdr. */
  agentsIn(dir: string): Promise<PaneAgent[]>;
}
