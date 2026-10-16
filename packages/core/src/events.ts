/** The story branch would start from the base branch, which is not on GitHub. */
export interface BaseBranchMissing {
  kind: "base-branch-missing";
  branch: string;
  base: string;
}

/** Best-effort work after a command that norn next repeats until it succeeds. */
export type FollowUpTask = "unblock-slices" | "move-story-on" | "close-merged-story" | "clear-labels";

/**
 * Something norn did, or could not do, on its own while running a command:
 * a transition's follow-ups and norn next's housekeeping.
 */
export type Event =
  | { kind: "story-branch-created"; branch: string }
  /** Creating the story branch failed; `detail` is GitHub's error. */
  | { kind: "story-branch-failed"; detail: string }
  | BaseBranchMissing
  /** A closed slice's worktree stays until norn tidy removes it. */
  | { kind: "worktree-left-for-tidy"; worktree: string }
  /** A sub-issue moved between the state syncsBlocked holds it in and the one it releases it to, e.g. blocked and ready-for-agent. */
  | { kind: "slice-state-changed"; issue: number; state: string }
  /** Every slice is merged, so the story moved on to needs-review. */
  | { kind: "story-promoted"; story: number }
  /** The story PR is merged, so norn closed the story. */
  | { kind: "story-closed"; story: number }
  /** `issue` is what the task was about; `retry` the story whose norn next retries it; `detail` the error. */
  | { kind: "follow-up-failed"; what: FollowUpTask; issue: number; retry: number; detail: string };
