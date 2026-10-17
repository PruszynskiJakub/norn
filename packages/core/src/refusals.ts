import type { FinishCommand } from "./briefing.js";
import type { ConfigProblem, VersionIncompatible } from "./config.js";
import type { BaseBranchMissing } from "./events.js";
import type { FlowError } from "./flow-validation.js";

import type { MergeRefusal } from "./transitions.js";
import type { Provider } from "./workspace.js";

/**
 * Why norn will not do what was asked, with the facts a front end needs to
 * say so. `story` is the story to run norn next on for something else to do,
 * when there is one. Claim times (`since`) are ISO timestamps.
 */
export type Refusal =
  | { kind: "config-invalid"; problems: ConfigProblem[] }
  | VersionIncompatible
  /** The provider is named outright, but its environment variable is not set. */
  | { kind: "provider-mismatch"; provider: Provider; variable: string }
  // No step to take
  | { kind: "closed"; issue: number }
  | { kind: "ambiguous-state"; issue: number; states: string[]; story: number | null }
  /** The issue, of the flow `flow`, waits in `state` for its slices, which move it on; see waitsForSlices. */
  | { kind: "story-in-implementation"; issue: number; flow: string; state: string }
  /** The issue, of the flow `flow`, waits in `state` for its owner to merge its PR; see waitsForMerge. */
  | { kind: "story-in-merge-queue"; issue: number; flow: string; owner: string | null; state: string }
  | { kind: "blocked"; issue: number; blockers: number[]; story: number | null }
  | { kind: "no-step"; issue: number; state: string | null; story: number | null }
  /** The issue's type names a repository flow that is broken; issues of other types are unaffected. */
  | { kind: "flow-invalid"; issue: number; flow: string; errors: FlowError[] }
  // Claims
  | { kind: "held"; issue: number; slice: boolean; since: string | null; story: number | null }
  /** Held by another session of the same user, who may take it over. */
  | { kind: "held-by-your-session"; issue: number; slice: boolean; since: string | null }
  /** --takeover on a teammate's claim, which it never takes. */
  | { kind: "held-by-teammate"; issue: number; slice: boolean; holder: string; since: string | null }
  | { kind: "not-claimed"; issue: number }
  | { kind: "held-by-other-session"; issue: number; since: string }
  // Finishing a step
  | { kind: "outcome-missing"; issue: number; step: string; finish: FinishCommand[] }
  | { kind: "outcome-unknown"; issue: number; word: string; step: string; finish: FinishCommand[] }
  | { kind: "note-missing"; issue: number; word: string; note: string; evidence: boolean }
  | { kind: "evidence-not-allowed"; issue: number; step: string; finish: FinishCommand[] }
  | { kind: "evidence-not-a-directory"; dir: string }
  | { kind: "evidence-empty"; dir: string }
  | { kind: "evidence-too-big"; files: string[]; limitBytes: number }
  | { kind: "no-slices"; issue: number; flow: string }
  /** The step opens a PR from `head` into `base`, and there is none. */
  | { kind: "no-pr"; issue: number; head: string; base: string }
  /** The outcome closes the issue, and its PR is not merged. */
  | { kind: "pr-not-merged"; issue: number; pr: number; head: string; base: string }
  | MergeRefusal
  | BaseBranchMissing
  // Other commands
  | { kind: "reason-missing"; issue: number }
  | { kind: "add-slice-usage"; story: number }
  /** Slices are added only in `slicing`, the state of the issue's flow with slices; null when its flow has none. */
  | { kind: "story-not-slicing"; story: number; flow: string | null; state: string | null; slicing: string | null }
  | NextRefusal;

/** Why norn next refuses an issue: one that works in its parent's branch, which moves on with it, or one with no flow yet. */
export type NextRefusal = { kind: "is-a-slice"; issue: number; flow: string; story: number | null } | { kind: "not-a-story"; issue: number };

export interface Refused {
  ok: false;
  refusal: Refusal;
}

export const refuse = (refusal: Refusal): Refused => ({ ok: false, refusal });
