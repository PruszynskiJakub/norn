import type { FinishCommand } from "./briefing.js";
import type { ConfigProblem, VersionIncompatible } from "./config.js";
import type { BaseBranchMissing } from "./events.js";
import type { FlowError } from "./flow.js";
import type { State } from "./machine.js";
import type { NotAStory } from "./next.js";
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
  | { kind: "story-in-implementation"; issue: number }
  | { kind: "story-in-merge-queue"; issue: number; owner: string | null }
  | { kind: "blocked"; issue: number; blockers: number[]; story: number | null }
  | { kind: "no-step"; issue: number; state: string | null; story: number | null }
  /** The issue's type names a repository flow that is broken; issues of other types are unaffected. */
  | { kind: "flow-invalid"; issue: number; flow: string; errors: FlowError[] }
  /** The issue was in `state`, which its flow no longer has; norn set needs-human on it. */
  | { kind: "state-left"; issue: number; state: string; flow: string }
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
  | { kind: "no-slices"; issue: number }
  | MergeRefusal
  | BaseBranchMissing
  // Other commands
  | { kind: "reason-missing"; issue: number }
  | { kind: "add-slice-usage"; story: number }
  | { kind: "story-not-slicing"; story: number; state: State | null }
  | NotAStory;

export interface Refused {
  ok: false;
  refusal: Refusal;
}

export const refuse = (refusal: Refusal): Refused => ({ ok: false, refusal });
