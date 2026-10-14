import type { Issue } from "./github.js";

export const STATES = [
  "needs-refinement",
  "needs-clarification",
  "needs-plan",
  "needs-slicing",
  "blocked",
  "ready-for-agent",
  "implementation",
  "needs-review",
  "changes-requested",
  "needs-qa",
  "qa-failed",
  "merge-queue",
] as const;
export type State = (typeof STATES)[number];

export const FLAGS = ["type:story", "type:slice", "in-progress", "needs-human", "mode:afk", "mode:hil"] as const;

export type Target = State | "closed" | "not-planned";

export interface Outcome {
  to: Target;
  /** How the outcome is described in the briefing. */
  means: string;
  /** The outcome needs a note; this names it, e.g. "reason". */
  note?: string;
  /** After the transition, set needs-human; this is who must do what, e.g. "QA in mode:hil". */
  needsHuman?: string;
}

export interface Step {
  /** Human name of the step, e.g. "triage", "refinement". */
  name: string;
  skill: string;
  attended: boolean;
  /** State label the issue moves to when the step is taken, e.g. ready-for-agent → implementation. */
  enterAs?: State;
  /** Keyed by outcome word; the empty key is the single way to end. */
  outcomes: Record<string, Outcome>;
}

/** States that send an issue back for another round of implement. */
export const FIX_STATES: readonly State[] = ["changes-requested", "qa-failed"];

export function stateOf(issue: Issue): State | null {
  return (STATES as readonly string[]).find((s) => issue.labels.includes(s)) as State | null ?? null;
}

/** Every state label on the issue. More than one means a label change failed halfway. */
export function statesOf(issue: Issue): State[] {
  return STATES.filter((s) => issue.labels.includes(s));
}

/** Why an issue with more than one state label cannot be acted on; null when it has at most one. */
export function ambiguousStates(issue: Issue): string | null {
  const states = statesOf(issue);
  return states.length > 1 ? `has more than one state label (${states.join(", ")}); a person must remove the stale one` : null;
}

export function kindOf(issue: Issue): "story" | "slice" | "new" {
  if (issue.labels.includes("type:slice")) return "slice";
  if (issue.labels.includes("type:story")) return "story";
  return "new";
}

/** The story's slices: its sub-issues labelled type:slice. Anything else a person attached is not psdd's. */
export async function slicesOf(github: { subIssues(parent: number): Promise<Issue[]> }, story: number): Promise<Issue[]> {
  return (await github.subIssues(story)).filter((i) => kindOf(i) === "slice");
}

export function stepFor(issue: Issue): Step | null {
  // Two state labels: either could be the real one, so psdd briefs neither.
  if (ambiguousStates(issue)) return null;
  const kind = kindOf(issue);
  const state = stateOf(issue);
  const hil = kind === "story" || issue.labels.includes("mode:hil");
  // A human doing QA records the result through the qa step itself.
  if (issue.labels.includes("needs-human") && state && state !== "needs-qa") {
    return {
      name: "resolving needs-human",
      skill: "resolve",
      attended: true,
      outcomes: { "": { to: state, means: `clears needs-human, stays in ${state}` } },
    };
  }
  if (kind !== "new" && state === "needs-review") {
    return {
      name: "review",
      skill: "review",
      attended: false,
      outcomes: {
        approve: {
          to: "needs-qa",
          means: "no requests, moves on to QA",
          needsHuman: hil ? (kind === "story" ? "story QA" : "QA in mode:hil") : undefined,
        },
        "request-changes": { to: "changes-requested", means: "put the requests in the note", note: "requests" },
      },
    };
  }
  if (kind !== "new" && state === "needs-qa") {
    return {
      name: "QA",
      skill: "qa",
      attended: hil,
      outcomes: {
        pass: { to: "merge-queue", means: "QA approved, moves to the merge queue" },
        fail: { to: "qa-failed", means: "put the problems in the note", note: "problems" },
      },
    };
  }
  if (kind === "story" && (state === "changes-requested" || state === "qa-failed")) {
    return {
      name: "fixing",
      skill: "implement",
      attended: false,
      outcomes: { "": { to: "needs-review", means: "fixes committed on the story branch, back to review" } },
    };
  }
  if (kind === "new") {
    return {
      name: "triage",
      skill: "triage",
      attended: true,
      outcomes: {
        accept: { to: "needs-refinement", means: "accepted, moves to refinement" },
        reject: { to: "not-planned", means: "closed as not planned; give the reason", note: "reason" },
      },
    };
  }
  if (kind === "story") {
    const phase1: Partial<Record<State, Step>> = {
      "needs-refinement": {
        name: "refinement",
        skill: "refine",
        attended: true,
        outcomes: {
          clear: { to: "needs-plan", means: "no open questions, moves on to planning" },
          questions: { to: "needs-clarification", means: "open questions, moves to clarification" },
        },
      },
      "needs-clarification": {
        name: "clarification",
        skill: "clarify",
        attended: true,
        outcomes: {
          answered: { to: "needs-plan", means: "all questions answered, moves on to planning" },
          questions: { to: "needs-clarification", means: "questions remain, stays in clarification" },
        },
      },
      "needs-plan": {
        name: "planning",
        skill: "plan",
        attended: true,
        outcomes: { "": { to: "needs-slicing", means: "plan is in the spec, moves on to slicing" } },
      },
      "needs-slicing": {
        name: "slicing",
        skill: "slice",
        attended: true,
        outcomes: { "": { to: "implementation", means: "slices created, moves on to implementation" } },
      },
    };
    if (state && phase1[state]) return phase1[state]!;
  }
  if (kind === "slice" && state === "merge-queue") {
    return {
      name: "merge",
      skill: "merge",
      attended: false,
      outcomes: { "": { to: "closed", means: "slice PR merged into the story branch" } },
    };
  }
  if (kind === "slice" && (state === "ready-for-agent" || state === "implementation" || state === "changes-requested" || state === "qa-failed")) {
    return {
      name: "implementation",
      skill: "implement",
      attended: false,
      enterAs: "implementation",
      outcomes: { "": { to: "needs-review", means: "implementation done, PR open" } },
    };
  }
  return null;
}
