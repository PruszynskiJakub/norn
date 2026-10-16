import type { State } from "./machine.js";

/** The story branch would start from the base branch, which is not on GitHub. */
export interface BaseBranchMissing {
  kind: "base-branch-missing";
  branch: string;
  base: string;
}

/** Best-effort work after a command that shepherd next repeats until it succeeds. */
export type FollowUpTask = "unblock-slices" | "move-story-on" | "close-merged-story" | "clear-labels";

/**
 * Something shepherd did, or could not do, on its own while running a command:
 * a transition's follow-ups and shepherd next's housekeeping.
 */
export type Event =
  | { kind: "story-branch-created"; branch: string }
  /** Creating the story branch failed; `detail` is GitHub's error. */
  | { kind: "story-branch-failed"; detail: string }
  | BaseBranchMissing
  /** A closed slice's worktree stays until shepherd tidy removes it. */
  | { kind: "worktree-left-for-tidy"; worktree: string }
  /** A slice moved between blocked and ready-for-agent with its blockers. */
  | { kind: "slice-state-changed"; issue: number; state: State }
  /** Every slice is merged, so the story moved on to needs-review. */
  | { kind: "story-promoted"; story: number }
  /** The story PR is merged, so shepherd closed the story. */
  | { kind: "story-closed"; story: number }
  /** `issue` is what the task was about; `retry` the story whose shepherd next retries it; `detail` the error. */
  | { kind: "follow-up-failed"; what: FollowUpTask; issue: number; retry: number; detail: string };
