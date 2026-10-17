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
 * a transition's follow-ups and norn next's housekeeping. `flow` is the
 * issue's type, e.g. story, so a front end can call it so.
 */
export type Event =
  | { kind: "story-branch-created"; flow: string; branch: string }
  /** Creating the issue's own branch failed; `detail` is GitHub's error. */
  | { kind: "story-branch-failed"; flow: string; detail: string }
  | BaseBranchMissing
  /** A closed slice's worktree stays until norn tidy removes it. */
  | { kind: "worktree-left-for-tidy"; worktree: string }
  /** A sub-issue moved between the state syncsBlocked holds it in and the one it releases it to, e.g. blocked and ready-for-agent. */
  | { kind: "slice-state-changed"; issue: number; state: string }
  /** The issue was in `from`, which the flow `flow` renamed to `to`, so norn moved it there. */
  | { kind: "state-renamed"; issue: number; from: string; to: string; flow: string }
  /** The issue was in `state`, which the flow `flow` no longer has, so norn handed it to a person through needs-human. */
  | { kind: "handed-over"; issue: number; state: string; flow: string }
  /** Every slice is merged, so the issue moved on to `to`, the state waitsForSlices names, with its PR open. */
  | { kind: "story-promoted"; story: number; flow: string; to: string }
  /** The issue's PR is merged, so norn closed the issue. */
  | { kind: "story-closed"; story: number; flow: string }
  /** `issue` is what the task was about; `retry` the story whose norn next retries it; `detail` the error. */
  | { kind: "follow-up-failed"; what: FollowUpTask; issue: number; retry: number; detail: string };
