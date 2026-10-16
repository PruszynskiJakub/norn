import type { Issue } from "./github.js";
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
  /** Where the work happens: no branch, or its own branch with a PR into the base branch. */
  workspace: "none" | "own";
  /** Whether triage offers the flow as an outcome; it does unless this is false. */
  triage?: boolean;
  states: Record<string, FlowState>;
}

export interface FlowState {
  skill: string;
  attended: boolean;
  /** The step's human name, e.g. "agent QA"; the state's name when missing. */
  name?: string;
  /** State label the issue moves to when the step is taken. */
  enterAs?: string;
  /** What the state means, for its label. */
  description?: string;
  /** The state label's colour, as hex without the #, e.g. "1d76db". */
  color?: string;
  /** The step can attach evidence files with norn done --evidence <dir>. */
  evidence?: boolean;
  /** Built-in mechanics the state opts into; see behaviours.ts. */
  behaviours?: BehaviourName[];
  /** Keyed by outcome word. */
  outcomes: Record<string, Outcome>;
}

/** The closed set of behaviours a state can opt into. A name outside it fails validation, e.g. one from a newer norn. */
export const BEHAVIOURS = ["opensPR", "countsFixRounds", "humanGate"] as const;
export type BehaviourName = (typeof BEHAVIOURS)[number];

/** A flow read from its file: valid, or kept with what is wrong with it. */
export type LoadedFlow = { ok: true; name: string; flow: Flow } | { ok: false; name: string; errors: FlowError[] };

/** What is wrong with a flow, as facts for a front end to word. */
export type FlowError =
  /** The file is not JSON; `detail` is the parser's message. */
  | { kind: "not-json"; detail: string }
  /** A field is missing or has the wrong type; `path` is e.g. "states.fixing.outcomes.fixed.to". */
  | { kind: "field-invalid"; path: string; expected: string }
  | { kind: "start-unknown"; start: string }
  | { kind: "target-unknown"; state: string; word: string; to: string }
  /** A state takes a name norn keeps for itself, e.g. closed. */
  | { kind: "state-reserved"; state: string }
  | { kind: "behaviour-unknown"; state: string; behaviour: string };

/** Ends every flow can lead to; no state may take these names. */
export const RESERVED_TARGETS = ["closed", "not-planned"] as const;

/** Labels norn sets itself on every issue; no state may take these names either. */
const ENGINE_LABELS = ["in-progress", "needs-human"];

/** Reads a flow file and checks it; an invalid flow is kept with its errors. */
export function parseFlow(name: string, text: string): LoadedFlow {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, name, errors: [{ kind: "not-json", detail: (e as Error).message }] };
  }
  const errors = validateFlow(data);
  return errors.length ? { ok: false, name, errors } : { ok: true, name, flow: data as Flow };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The core checks: the shape, the start exists, every target exists or is an end, and no reserved names. */
export function validateFlow(data: unknown): FlowError[] {
  const errors: FlowError[] = [];
  const field = (path: string, expected: string) => errors.push({ kind: "field-invalid", path, expected });
  if (!isObject(data)) {
    field("", "an object");
    return errors;
  }
  if (typeof data.description !== "string") field("description", "a string");
  if (typeof data.start !== "string") field("start", "a string");
  if (data.workspace !== "none" && data.workspace !== "own") field("workspace", '"none" or "own"');
  if (data.triage !== undefined && typeof data.triage !== "boolean") field("triage", "true or false");
  if (!isObject(data.states)) {
    field("states", "an object");
    return errors;
  }
  const states = data.states;
  for (const [name, state] of Object.entries(states)) {
    const at = `states.${name}`;
    if ((RESERVED_TARGETS as readonly string[]).includes(name) || ENGINE_LABELS.includes(name)) errors.push({ kind: "state-reserved", state: name });
    if (!isObject(state)) {
      field(at, "an object");
      continue;
    }
    if (typeof state.skill !== "string") field(`${at}.skill`, "a string");
    if (typeof state.attended !== "boolean") field(`${at}.attended`, "true or false");
    for (const key of ["name", "description", "color"]) if (state[key] !== undefined && typeof state[key] !== "string") field(`${at}.${key}`, "a string");
    if (state.evidence !== undefined && typeof state.evidence !== "boolean") field(`${at}.evidence`, "true or false");
    if (state.enterAs !== undefined && (typeof state.enterAs !== "string" || !Object.hasOwn(states, state.enterAs))) {
      field(`${at}.enterAs`, "a state of the flow");
    }
    if (state.behaviours !== undefined) {
      if (!Array.isArray(state.behaviours)) field(`${at}.behaviours`, "a list of behaviour names");
      else {
        for (const [i, b] of state.behaviours.entries()) {
          if (typeof b !== "string") field(`${at}.behaviours.${i}`, "a behaviour name");
          else if (!(BEHAVIOURS as readonly string[]).includes(b)) errors.push({ kind: "behaviour-unknown", state: name, behaviour: b });
        }
      }
    }
    if (!isObject(state.outcomes)) {
      field(`${at}.outcomes`, "an object");
      continue;
    }
    for (const [word, outcome] of Object.entries(state.outcomes)) {
      const o = `${at}.outcomes.${word}`;
      if (!isObject(outcome)) {
        field(o, "an object");
        continue;
      }
      if (typeof outcome.means !== "string") field(`${o}.means`, "a string");
      for (const key of ["note", "needsHuman"]) if (outcome[key] !== undefined && typeof outcome[key] !== "string") field(`${o}.${key}`, "a string");
      if (outcome.notify !== undefined && outcome.notify !== "story" && outcome.notify !== "mode:hil") field(`${o}.notify`, '"story" or "mode:hil"');
      if (typeof outcome.to !== "string") field(`${o}.to`, "a string");
      else if (!Object.hasOwn(states, outcome.to) && !(RESERVED_TARGETS as readonly string[]).includes(outcome.to)) {
        errors.push({ kind: "target-unknown", state: name, word, to: outcome.to });
      }
    }
  }
  if (typeof data.start === "string" && !Object.hasOwn(states, data.start)) errors.push({ kind: "start-unknown", start: data.start });
  return errors;
}

/** The flow named by the issue's `type:<name>` label, for any type but the built-in story and slice; null for none. */
export function flowNameOf(issue: Issue): string | null {
  for (const label of issue.labels) {
    const m = /^type:([a-z0-9][a-z0-9_-]*)$/.exec(label);
    if (m && m[1] !== "story" && m[1] !== "slice") return m[1];
  }
  return null;
}

/** Repository flows read during one command, by name; see repositoryFlow. */
export type FlowCache = Map<string, Promise<LoadedFlow | null>>;

/** Where a repository keeps its flows. */
export const FLOWS_DIR = ".agents/flows";

/**
 * The repository's flow `name`, read from the base branch on GitHub, never
 * from the working tree: the team's process is what is merged. Null when the
 * repository has no such flow. Read once per command.
 */
export function repositoryFlow(
  ctx: { github: { readFileAt(path: string, ref: string): Promise<string | null> }; config: { baseBranch: string }; flows?: FlowCache },
  name: string,
): Promise<LoadedFlow | null> {
  ctx.flows ??= new Map();
  let flow = ctx.flows.get(name);
  if (!flow) {
    flow = ctx.github.readFileAt(`${FLOWS_DIR}/${name}.json`, ctx.config.baseBranch).then((text) => (text === null ? null : parseFlow(name, text)));
    ctx.flows.set(name, flow);
  }
  return flow;
}

/** Outcome words of triage that no flow can take: the built-in story and slice, and reject. */
const NOT_A_FLOW_WORD = ["story", "slice", "reject"];

/**
 * The repository's flows triage offers, in name order: every valid flow on the
 * base branch whose name can be a type and that does not set triage to false.
 */
export async function triageFlows(
  ctx: Parameters<typeof repositoryFlow>[0] & { github: { listFilesAt(dir: string, ref: string): Promise<string[]> } },
): Promise<{ name: string; flow: Flow }[]> {
  const names = (await ctx.github.listFilesAt(FLOWS_DIR, ctx.config.baseBranch))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => /^[a-z0-9][a-z0-9_-]*$/.test(name) && !NOT_A_FLOW_WORD.includes(name))
    .sort();
  const loaded = await Promise.all(names.map((name) => repositoryFlow(ctx, name)));
  return loaded.flatMap((l) => (l?.ok && l.flow.triage !== false ? [{ name: l.name, flow: l.flow }] : []));
}

/** Triage's step with an outcome for each offered flow, after story and before reject. */
export function offerFlows(step: Step, flows: { name: string; flow: Flow }[]): Step {
  const { reject, ...rest } = step.outcomes;
  const offered: Record<string, Outcome> = Object.fromEntries(flows.map(({ name, flow }) => [name, { to: flow.start, means: flow.description, flow: name }]));
  return { ...step, outcomes: { ...rest, ...offered, ...(reject ? { reject } : {}) } };
}

/** The state labels of the flow that the issue carries. More than one means a label change failed halfway. */
export function flowStatesOf(issue: Issue, flow: Flow): string[] {
  return Object.keys(flow.states).filter((s) => issue.labels.includes(s));
}

/** The issue's step in its flow; null when it has no single state there. needs-human is resolved the same in every flow. */
export function flowStep(issue: Issue, flow: Flow): Step | null {
  const states = flowStatesOf(issue, flow);
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
  const s = flow.states[state];
  return {
    name: s.name ?? state,
    skill: s.skill,
    attended: s.attended,
    ...(s.enterAs ? { enterAs: s.enterAs } : {}),
    outcomes: s.outcomes,
    ...(s.evidence ? { evidence: true } : {}),
  };
}
