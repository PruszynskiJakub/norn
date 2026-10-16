/**
 * What a step is, in every flow: the outcomes it can end with. The steps
 * themselves come from the issue's flow (see flow.ts); only triage, which runs
 * before an issue has a flow, and resolving needs-human are the engine's own.
 */

/** The labels norn sets on issues of every flow, besides their state and type. */
export const ENGINE_FLAGS = ["in-progress", "needs-human", "mode:afk", "mode:hil"] as const;

export interface Outcome {
  /** A state of the issue's flow, closed or not-planned. */
  to: string;
  /** How the outcome is described in the briefing. */
  means: string;
  /** How it is described instead when the issue's mode skips the state it leads to, so it lands further on. */
  meansSkipped?: string;
  /** The outcome needs a note; this names it, e.g. "reason". */
  note?: string;
  /** After the transition, set needs-human; this is who must do what, e.g. an escalation's reason. */
  needsHuman?: string;
  /**
   * After the transition, a person does QA without the needs-human flag. This
   * names why: story, mode:hil for a slice, or type:<flow> for a flow's human gate.
   */
  notify?: string;
  /** Triage gives the issue this flow: the label type:<flow>, and the flow's start as `to`. */
  flow?: string;
}

export interface Step {
  /** Human name of the step, e.g. "triage", "refinement". */
  name: string;
  skill: string;
  attended: boolean;
  /** State label the issue moves to when the step is taken, e.g. ready-for-agent → implementation. */
  enterAs?: string;
  /** Keyed by outcome word; the empty key is the single way to end. */
  outcomes: Record<string, Outcome>;
  /** The step can attach evidence files with norn done --evidence <dir>. */
  evidence?: boolean;
}

/** The step of an issue with no type yet. Its outcomes are the flows on offer, see offerFlows, and reject. */
export const TRIAGE: Step = {
  name: "triage",
  skill: "norn-triage",
  attended: true,
  outcomes: {
    reject: { to: "not-planned", means: "closed as not planned; give the reason", note: "reason" },
  },
};
