import type { Issue } from "./github.js";
import { type BehaviourName, type BehaviourParams, holds } from "./behaviours.js";
import type { Outcome, Step } from "./machine.js";

/**
 * A flow is the process for one issue, as data: `.agents/flows/<name>.json`
 * on the base branch. An issue labelled `type:<name>` runs the flow `<name>`.
 */
export interface Flow {
  /** What the flow is for, e.g. for triage and the dashboard. */
  description: string;
  /** The state an issue enters the flow in. */
  start: string;
  /** Where the work happens: no branch, its own branch with a PR into the base branch, or one with a PR into its parent issue's branch. */
  workspace: WorkspaceMode;
  /** Whether triage offers the flow as an outcome; it does unless this is false. */
  triage?: boolean;
  states: Record<string, FlowState>;
  /** Old state name to its new one: issues still in the old state move there when next touched. */
  renamed?: Record<string, string>;
}

export interface FlowState {
  skill: string;
  attended: boolean;
  /** The step's human name, e.g. "agent QA"; the state's name when missing. */
  name?: string;
  /** State label the issue moves to when the step is taken. */
  enterAs?: string;
  /** What the state means, as a phrase, e.g. "Waiting for review": its label's description and the dashboard's wording; the state's name when missing. */
  description?: string;
  /** The state label's colour, as hex without the #, e.g. "1d76db". */
  color?: string;
  /** The step can attach evidence files with norn done --evidence <dir>. */
  evidence?: boolean;
  /** The only mode the state runs in; in the other mode norn follows passThrough instead of entering it. */
  when?: Mode;
  /** With when: the outcome word norn follows on its own when the issue's mode skips the state. */
  passThrough?: string;
  /** Built-in mechanics the state opts into, by name, with their parameters; see behaviours.ts. */
  behaviours?: Partial<Record<BehaviourName, BehaviourParams>>;
  /** Keyed by outcome word. */
  outcomes: Record<string, Outcome>;
}

/** Where an issue's work happens: no branch, its own branch with a PR into the base branch, or one with a PR into its parent's branch. */
export type WorkspaceMode = "none" | "own" | "parent";

/** Every workspace mode, in the order the format lists them. */
export const WORKSPACE_MODES: readonly WorkspaceMode[] = ["none", "own", "parent"];

/** How an issue is worked, from its mode:afk or mode:hil label: unattended, or with a person in the loop. */
export type Mode = "afk" | "hil";

/** A flow with its name, the type of the issues that run it. */
export interface NamedFlow {
  name: string;
  flow: Flow;
}

/** The flow named by the issue's `type:<name>` label; null for none. */
export function flowNameOf(issue: Issue): string | null {
  for (const label of issue.labels) {
    const m = /^type:([a-z0-9][a-z0-9_-]*)$/.exec(label);
    if (m) return m[1];
  }
  return null;
}

/** Whether the state of the flow opts into the behaviour. */
export function uses(flow: Flow, state: string | null, name: BehaviourName): boolean {
  return state !== null && Object.hasOwn(flow.states[state]?.behaviours ?? {}, name);
}

/** Whether any state of the flow opts into the behaviour. */
export function usedIn(flow: Flow, name: BehaviourName): boolean {
  return Object.keys(flow.states).some((s) => uses(flow, s, name));
}

/** Whether the flow's issues have a spec of their own: one of its states writes it. */
export function hasSpec(flow: Flow): boolean {
  return usedIn(flow, "writesSpec");
}

/** A GitHub label as norn creates it. */
export interface LabelDefinition {
  name: string;
  /** Hex without the #. */
  color: string;
  description: string;
}

/** The colour and description of a state's label when the flow gives none, by the state's kind. */
export const DEFAULT_STATE_LABEL = {
  attended: { color: "c5def5", description: "a person takes part in this step" },
  agent: { color: "bfd4f2", description: "an agent runs this step unattended" },
} as const;

/** The label of a state of the flow: the state's colour and description, or the defaults of its kind. */
export function stateLabel(flow: Flow, state: string): LabelDefinition {
  const s = flow.states[state];
  const fallback = s.attended ? DEFAULT_STATE_LABEL.attended : DEFAULT_STATE_LABEL.agent;
  return { name: state, color: s.color ?? fallback.color, description: s.description ?? fallback.description };
}

/** The label of the type that runs the flow. */
export function typeLabel(name: string): LabelDefinition {
  return { name: `type:${name}`, color: "ededed", description: `norn ${name} flow` };
}

/**
 * The labels the flows need: every state, each once, as the first flow that has it defines it, then type:<flow> for
 * each flow, in the flows' order.
 */
export function flowLabels(flows: { name: string; flow: Flow }[]): LabelDefinition[] {
  const states = new Map<string, LabelDefinition>();
  for (const { flow } of flows) for (const state of Object.keys(flow.states)) if (!states.has(state)) states.set(state, stateLabel(flow, state));
  return [...states.values(), ...flows.map(({ name }) => typeLabel(name))];
}

/** Triage's step with an outcome for each offered flow, before reject. */
export function offerFlows(step: Step, flows: { name: string; flow: Flow }[]): Step {
  const { reject, ...rest } = step.outcomes;
  const offered: Record<string, Outcome> = Object.fromEntries(flows.map(({ name, flow }) => [name, { to: flow.start, means: flow.description, flow: name }]));
  return { ...step, outcomes: { ...rest, ...offered, ...(reject ? { reject } : {}) } };
}

/** The issue's mode from its mode:afk or mode:hil label; null for none. */
export function modeOf(issue: Issue): Mode | null {
  return issue.labels.includes("mode:hil") ? "hil" : issue.labels.includes("mode:afk") ? "afk" : null;
}

/**
 * The outcome as it lands: while it leads into a state for the other mode, norn follows that state's pass-through
 * instead, so the issue goes straight to the first state that runs in its mode. An issue with no mode runs every state.
 * `skipped` lists the states passed through, in order.
 */
export function passThrough(flow: Flow, issue: Issue, outcome: Outcome): { outcome: Outcome; skipped: string[]; mode: Mode | null } {
  const mode = modeOf(issue);
  const skipped: string[] = [];
  let landed = outcome;
  for (;;) {
    const state = flow.states[landed.to];
    // A loop of pass-throughs ends in the first state seen twice.
    if (!mode || !state?.when || state.when === mode || skipped.includes(landed.to)) break;
    skipped.push(landed.to);
    const through = state.outcomes[state.passThrough!];
    // The words and the note stay the outcome's; only where it leads and whom it notifies come from the pass-through.
    const { notify: _, ...rest } = landed;
    landed = { ...rest, to: through.to, ...(through.notify ? { notify: through.notify } : {}) };
  }
  return { outcome: landed, skipped, mode };
}

/** The state labels of the flow that the issue carries. More than one means a label change failed halfway. */
export function flowStatesOf(issue: Issue, flow: Flow): string[] {
  return Object.keys(flow.states).filter((s) => issue.labels.includes(s));
}

/**
 * The issue's step in its flow; null when it has no single state there. needs-human is resolved the same in every flow;
 * with no state of the flow, e.g. one the flow dropped, resolving moves the issue into the state a person picks.
 */
export function flowStep(issue: Issue, flow: Flow): Step | null {
  const states = flowStatesOf(issue, flow);
  if (states.length === 0 && issue.labels.includes("needs-human")) {
    return {
      name: "resolving needs-human",
      skill: "norn-resolve",
      attended: true,
      outcomes: Object.fromEntries(Object.keys(flow.states).map((s) => [s, { to: s, means: `moves it to ${s}, a state of the flow` }])),
    };
  }
  if (states.length !== 1) return null;
  const [state] = states;
  if (issue.labels.includes("needs-human")) {
    return {
      name: "resolving needs-human",
      skill: "norn-resolve",
      attended: true,
      outcomes: { "": { to: state, means: `clears needs-human, stays in ${state}` } },
    };
  }
  // A behaviour moves the issue on from here by itself, e.g. once its blockers close.
  if (holds(flow, state)) return null;
  const s = flow.states[state];
  return {
    name: s.name ?? state,
    skill: s.skill,
    attended: s.attended,
    ...(s.enterAs ? { enterAs: s.enterAs } : {}),
    outcomes: Object.fromEntries(Object.entries(s.outcomes).map(([word, o]) => [word, asLanding(flow, issue, o)])),
    // A person at a human gate can attach QA evidence.
    ...(s.evidence || uses(flow, state, "humanGate") ? { evidence: true } : {}),
  };
}

/** The outcome as the issue's mode lands it, described so when the flow says how. */
function asLanding(flow: Flow, issue: Issue, outcome: Outcome): Outcome {
  const { meansSkipped, ...rest } = outcome;
  return meansSkipped !== undefined && passThrough(flow, issue, outcome).skipped.length ? { ...rest, means: meansSkipped } : rest;
}

/** Whether an outcome of the state leads, in the issue's mode, to a human gate: a person checks the work after this step. */
export function gateAhead(flow: Flow, issue: Issue, state: string): boolean {
  return Object.values(flow.states[state]?.outcomes ?? {}).some((o) => uses(flow, passThrough(flow, issue, o).outcome.to, "humanGate"));
}
