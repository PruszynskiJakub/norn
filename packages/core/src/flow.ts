import type { Issue } from "./github.js";
import { BEHAVIOURS, type Behaviour, type BehaviourName, type BehaviourParams, holds, uses } from "./behaviours.js";
import { BUILT_IN } from "./built-in-flows.js";
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
  workspace: "none" | "own" | "parent";
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

/** How an issue is worked, from its mode:afk or mode:hil label: unattended, or with a person in the loop. */
export type Mode = "afk" | "hil";

/** A flow read from its file: valid, or kept with what is wrong with it. */
export type LoadedFlow = { ok: true; name: string; flow: Flow } | { ok: false; name: string; errors: FlowError[] };

/** Where a flow in effect comes from: norn's own, the repository's file in place of norn's of that name, or a flow only the repository has. */
export type FlowSource = "built-in" | "overridden" | "repository";

/** A flow in effect in the repository, with where it comes from. */
export type SourcedFlow = LoadedFlow & { source: FlowSource };

/** What is wrong with a flow, as facts for a front end to word. */
export type FlowError =
  /** The file is not JSON; `detail` is the parser's message. */
  | { kind: "not-json"; detail: string }
  /** A field is missing or has the wrong type; `path` is e.g. "states.fixing.outcomes.fixed.to". */
  | { kind: "field-invalid"; path: string; expected: string }
  /** A field the format does not have, e.g. a misspelt one, which norn would otherwise ignore. */
  | { kind: "field-unknown"; path: string }
  | { kind: "start-unknown"; start: string }
  | { kind: "target-unknown"; state: string; word: string; to: string }
  /** `renamed` moves the old state `from` to `to`, which is not a state of the flow. */
  | { kind: "renamed-unknown"; from: string; to: string }
  /** A state takes a name norn keeps for itself, e.g. closed. */
  | { kind: "state-reserved"; state: string }
  /** A state with when has no passThrough (word null), or it names a word that is not one of the state's outcomes. */
  | { kind: "pass-through-invalid"; state: string; word: string | null }
  /**
   * No path of outcomes leads from the state to closed or not-planned, so an issue there could never end. With `mode`, the
   * path is cut only in that mode, where the states for the other mode are passed through.
   */
  | { kind: "end-unreachable"; state: string; mode?: Mode }
  /** A behaviour this norn does not have, e.g. one of a newer norn. */
  | { kind: "behaviour-unknown"; state: string; behaviour: string }
  /** Two behaviours of one state that cannot go together. */
  | { kind: "behaviours-conflict"; state: string; behaviours: [string, string] }
  /** A behaviour names a flow the repository does not have. */
  | { kind: "flow-unknown"; state: string; behaviour: string; flow: string }
  /** A behaviour of the state needs the flow to be otherwise, e.g. opensPR a workspace of its own. */
  | { kind: "behaviour-needs"; state: string; behaviour: string; field: string; expected: string }
  /** The flow's name is one norn keeps for itself, e.g. reject, triage's outcome. */
  | { kind: "flow-reserved"; flow: string };

/** The fields of a flow file, of a state and of an outcome; $schema lets an editor find the flow JSON Schema. */
const FLOW_FIELDS = ["$schema", "description", "start", "workspace", "triage", "states", "renamed"];
const STATE_FIELDS = ["skill", "attended", "name", "enterAs", "description", "color", "evidence", "when", "passThrough", "behaviours", "outcomes"];
const OUTCOME_FIELDS = ["to", "means", "meansSkipped", "note", "needsHuman", "notify"];

/** Ends every flow can lead to; no state may take these names. */
export const RESERVED_TARGETS = ["closed", "not-planned"] as const;

/** Names no flow may take: triage's outcome that closes an issue as not planned. */
const RESERVED_FLOWS = ["reject"];

/** Flows norn ships, which exist in every repository. */
const BUILT_IN_FLOWS = Object.keys(BUILT_IN);

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
  const errors = [...(RESERVED_FLOWS.includes(name) ? [{ kind: "flow-reserved", flow: name } as const] : []), ...validateFlow(data)];
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
  const unknown = (at: string, value: Record<string, unknown>, fields: string[]) => {
    for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push({ kind: "field-unknown", path: at ? `${at}.${key}` : key });
  };
  unknown("", data, FLOW_FIELDS);
  if (typeof data.description !== "string") field("description", "a string");
  if (typeof data.start !== "string") field("start", "a string");
  if (data.workspace !== "none" && data.workspace !== "own" && data.workspace !== "parent") field("workspace", '"none", "own" or "parent"');
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
    unknown(at, state, STATE_FIELDS);
    if (typeof state.skill !== "string") field(`${at}.skill`, "a string");
    if (typeof state.attended !== "boolean") field(`${at}.attended`, "true or false");
    for (const key of ["name", "description", "color"]) if (state[key] !== undefined && typeof state[key] !== "string") field(`${at}.${key}`, "a string");
    if (typeof state.color === "string" && !/^[0-9a-fA-F]{6}$/.test(state.color)) field(`${at}.color`, "a hex colour without the #, e.g. 1d76db");
    if (state.evidence !== undefined && typeof state.evidence !== "boolean") field(`${at}.evidence`, "true or false");
    if (state.behaviours !== undefined) checkBehaviours(data, name, state.behaviours, errors);
    if (state.enterAs !== undefined && (typeof state.enterAs !== "string" || !Object.hasOwn(states, state.enterAs))) {
      field(`${at}.enterAs`, "a state of the flow");
    }
    if (!isObject(state.outcomes)) {
      field(`${at}.outcomes`, "an object");
      continue;
    }
    if (state.when !== undefined && state.when !== "afk" && state.when !== "hil") field(`${at}.when`, '"afk" or "hil"');
    if (state.passThrough !== undefined && typeof state.passThrough !== "string") field(`${at}.passThrough`, "an outcome word");
    else if (state.when !== undefined && (state.passThrough === undefined || !Object.hasOwn(state.outcomes, state.passThrough))) {
      errors.push({ kind: "pass-through-invalid", state: name, word: state.passThrough ?? null });
    }
    for (const [word, outcome] of Object.entries(state.outcomes)) {
      const o = `${at}.outcomes.${word}`;
      if (!isObject(outcome)) {
        field(o, "an object");
        continue;
      }
      unknown(o, outcome, OUTCOME_FIELDS);
      if (typeof outcome.means !== "string") field(`${o}.means`, "a string");
      for (const key of ["note", "needsHuman", "meansSkipped"])
        if (outcome[key] !== undefined && typeof outcome[key] !== "string") field(`${o}.${key}`, "a string");
      if (outcome.notify !== undefined && outcome.notify !== "story" && outcome.notify !== "mode:hil") field(`${o}.notify`, '"story" or "mode:hil"');
      if (typeof outcome.to !== "string") field(`${o}.to`, "a string");
      else if (!Object.hasOwn(states, outcome.to) && !(RESERVED_TARGETS as readonly string[]).includes(outcome.to)) {
        errors.push({ kind: "target-unknown", state: name, word, to: outcome.to });
      }
    }
  }
  if (typeof data.start === "string" && !Object.hasOwn(states, data.start)) errors.push({ kind: "start-unknown", start: data.start });
  if (data.renamed !== undefined) {
    if (!isObject(data.renamed)) field("renamed", "an object");
    else
      for (const [from, to] of Object.entries(data.renamed)) {
        if (typeof to !== "string") field(`renamed.${from}`, "a string");
        else if (!Object.hasOwn(states, to)) errors.push({ kind: "renamed-unknown", from, to });
      }
  }
  const passThroughsValid = !errors.some(
    (e) => e.kind === "pass-through-invalid" || (e.kind === "field-invalid" && /\.(when|passThrough|outcomes)/.test(e.path)),
  );
  errors.push(...endUnreachable(states, passThroughsValid));
  return errors;
}

const isBehaviour = (name: string): name is BehaviourName => Object.hasOwn(BEHAVIOURS, name);

/** Each behaviour must be known, with valid parameters, and allowed beside the state's others. */
function checkBehaviours(flow: Record<string, unknown>, state: string, behaviours: unknown, errors: FlowError[]) {
  const at = `states.${state}.behaviours`;
  if (!isObject(behaviours)) {
    errors.push({ kind: "field-invalid", path: at, expected: "an object of behaviour names" });
    return;
  }
  const known: BehaviourName[] = [];
  for (const [behaviour, params] of Object.entries(behaviours)) {
    if (!isBehaviour(behaviour)) {
      errors.push({ kind: "behaviour-unknown", state, behaviour });
      continue;
    }
    known.push(behaviour);
    const rule: Behaviour = BEHAVIOURS[behaviour];
    if (!isObject(params)) errors.push({ kind: "field-invalid", path: `${at}.${behaviour}`, expected: "an object of parameters, {} for none" });
    else {
      const declared = rule.params ?? {};
      for (const [name, p] of Object.entries(declared)) {
        const value = params[name];
        if ((value === undefined && p.required) || (value !== undefined && typeof value !== p.type))
          errors.push({ kind: "field-invalid", path: `${at}.${behaviour}.${name}`, expected: p.expected });
      }
      for (const name of Object.keys(params)) if (!Object.hasOwn(declared, name)) errors.push({ kind: "field-unknown", path: `${at}.${behaviour}.${name}` });
      const states = isObject(flow.states) ? flow.states : {};
      for (const l of rule.leadsTo?.(params) ?? []) {
        if (!Object.hasOwn(states, l.to) && !(RESERVED_TARGETS as readonly string[]).includes(l.to))
          errors.push({ kind: "field-invalid", path: `${at}.${behaviour}.${l.param}`, expected: "a state of the flow" });
      }
    }
    const needs = rule.requires?.(flow);
    if (needs) errors.push({ kind: "behaviour-needs", state, behaviour, ...needs });
  }
  known.forEach((a, i) => {
    for (const b of known.slice(i + 1)) {
      const [ra, rb]: Behaviour[] = [BEHAVIOURS[a], BEHAVIOURS[b]];
      if (ra.excludes?.includes(b) || rb.excludes?.includes(a)) errors.push({ kind: "behaviours-conflict", state, behaviours: [a, b] });
    }
  });
}

/** The states that cannot end, then those that cannot end in one mode only, each state reported once. */
function endUnreachable(states: Record<string, unknown>, passThroughsValid: boolean): FlowError[] {
  const errors: FlowError[] = statesThatCannotEnd(states).map((state) => ({ kind: "end-unreachable", state }));
  const conditional = Object.values(states).some((s) => isObject(s) && s.when !== undefined);
  if (!conditional || !passThroughsValid) return errors;
  for (const mode of ["afk", "hil"] as const) {
    for (const state of statesThatCannotEnd(states, mode)) {
      if (!errors.some((e) => e.kind === "end-unreachable" && e.state === state)) errors.push({ kind: "end-unreachable", state, mode });
    }
  }
  return errors;
}

/**
 * The states from which no path of outcomes reaches closed or not-planned, in file order. In a mode, an outcome into a
 * state for the other mode leads where that state's pass-through leads, and only the states that run in the mode count.
 */
function statesThatCannotEnd(states: Record<string, unknown>, mode?: Mode): string[] {
  const skips = (to: string) => {
    const s = states[to];
    return mode !== undefined && isObject(s) && s.when !== undefined && s.when !== mode;
  };
  // Where an outcome lands in the mode; null when its pass-throughs go round in a loop.
  const land = (to: string): string | null => {
    const seen: string[] = [];
    while (skips(to)) {
      if (seen.includes(to)) return null;
      seen.push(to);
      const s = states[to] as Record<string, unknown>;
      const o = (s.outcomes as Record<string, Record<string, unknown>>)[s.passThrough as string];
      to = o.to as string;
    }
    return to;
  };
  const targets = (state: unknown): string[] =>
    isObject(state) && isObject(state.outcomes)
      ? [...Object.values(state.outcomes).flatMap((o) => (isObject(o) && typeof o.to === "string" ? [o.to] : [])), ...behaviourTargets(state)].flatMap((t) => {
          const to = land(t);
          return to === null ? [] : [to];
        })
      : [];
  // An unknown target is reported on its own, so it does not count against the states before it.
  const ends = new Set<string>([
    ...RESERVED_TARGETS,
    ...Object.values(states)
      .flatMap(targets)
      .filter((to) => !Object.hasOwn(states, to)),
  ]);
  // Walk back from the ends: a state ends once one of its outcomes leads to a state that ends.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, state] of Object.entries(states)) {
      if (!ends.has(name) && targets(state).some((to) => ends.has(to))) {
        ends.add(name);
        grew = true;
      }
    }
  }
  return Object.keys(states).filter((name) => !ends.has(name) && !skips(name));
}

/** The states a state's behaviours move an issue to on their own, e.g. where syncsBlocked releases it. */
function behaviourTargets(state: Record<string, unknown>): string[] {
  if (!isObject(state.behaviours)) return [];
  return Object.entries(state.behaviours).flatMap(([name, params]) =>
    isBehaviour(name) && isObject(params) ? ((BEHAVIOURS[name] as Behaviour).leadsTo?.(params) ?? []).map((l) => l.to) : [],
  );
}

/** The flow named by the issue's `type:<name>` label; null for none. */
export function flowNameOf(issue: Issue): string | null {
  for (const label of issue.labels) {
    const m = /^type:([a-z0-9][a-z0-9_-]*)$/.exec(label);
    if (m) return m[1];
  }
  return null;
}

/** A built-in flow by name, checked like any other; null when norn has none of that name. */
export function builtInFlow(name: string): LoadedFlow | null {
  const flow = BUILT_IN[name];
  if (!flow) return null;
  const errors = validateFlow(flow);
  return errors.length ? { ok: false, name, errors } : { ok: true, name, flow };
}

/**
 * The flow `name`: the repository's, or else the built-in one; null when there is none. A repository flow
 * replaces the built-in flow of its name wholesale, with nothing merged from it.
 */
export async function loadFlow(ctx: Parameters<typeof repositoryFlow>[0], name: string): Promise<LoadedFlow | null> {
  return (await repositoryFlow(ctx, name)) ?? builtInFlow(name);
}

/** The flow the issue runs, from its type; null when its type names none, e.g. a new issue. */
export function flowOf(ctx: Parameters<typeof repositoryFlow>[0], issue: Issue): Promise<LoadedFlow | null> {
  const name = flowNameOf(issue);
  return name === null ? Promise.resolve(null) : loadFlow(ctx, name);
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
    flow = ctx.github
      .readFileAt(`${FLOWS_DIR}/${name}.json`, ctx.config.baseBranch)
      .then((text) =>
        text === null
          ? null
          : checkFlowsNamed(
              parseFlow(name, text),
              async (other) => (await ctx.github.readFileAt(`${FLOWS_DIR}/${other}.json`, ctx.config.baseBranch)) !== null,
            ),
      );
    ctx.flows.set(name, flow);
  }
  return flow;
}

/**
 * A valid flow whose behaviours name flows that do not exist is kept with those errors. `exists` says whether a flow
 * that is not built in exists, e.g. on the base branch.
 */
export async function checkFlowsNamed(loaded: LoadedFlow, exists: (flow: string) => Promise<boolean>): Promise<LoadedFlow> {
  if (!loaded.ok) return loaded;
  const named = Object.entries(loaded.flow.states).flatMap(([state, s]) =>
    Object.entries(s.behaviours ?? {}).flatMap(([behaviour, params]) => {
      const rule: Behaviour = BEHAVIOURS[behaviour as BehaviourName];
      return (rule.flowsNamed?.(params ?? {}) ?? []).map((flow) => ({ state, behaviour, flow }));
    }),
  );
  const errors: FlowError[] = [];
  for (const n of named) if (!BUILT_IN_FLOWS.includes(n.flow) && !(await exists(n.flow))) errors.push({ kind: "flow-unknown", ...n });
  return errors.length ? { ok: false, name: loaded.name, errors } : loaded;
}

/** A flow file's name is a type name. */
const FLOW_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The flow names of the files in a list of a flows directory, sorted; files that cannot name a type are left out. */
export function flowFileNames(files: string[]): string[] {
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => FLOW_NAME.test(name))
    .sort();
}

/**
 * Every flow of the repository, valid or kept with its errors: the built-in
 * ones in their order, then the repository's other files in name order. A
 * repository flow is read from the base branch, and its name must be a type;
 * one named like a built-in flow takes that flow's place. Each says where it comes from.
 */
export async function repositoryFlows(
  ctx: Parameters<typeof repositoryFlow>[0] & { github: { listFilesAt(dir: string, ref: string): Promise<string[]> } },
): Promise<SourcedFlow[]> {
  const names = flowFileNames(await ctx.github.listFilesAt(FLOWS_DIR, ctx.config.baseBranch)).filter((name) => !BUILT_IN_FLOWS.includes(name));
  const loaded = await Promise.all(
    [...BUILT_IN_FLOWS, ...names].map(async (name): Promise<SourcedFlow | null> => {
      const own = await repositoryFlow(ctx, name);
      if (own) return { ...own, source: BUILT_IN_FLOWS.includes(name) ? "overridden" : "repository" };
      const builtIn = builtInFlow(name);
      return builtIn && { ...builtIn, source: "built-in" };
    }),
  );
  return loaded.filter((l) => l !== null);
}

/** The flows triage offers: the repository's flows that are valid, not named like triage's reject, and not setting triage to false. */
export async function triageFlows(ctx: Parameters<typeof repositoryFlows>[0]): Promise<{ name: string; flow: Flow }[]> {
  return (await repositoryFlows(ctx)).flatMap((l) =>
    l.ok && !RESERVED_FLOWS.includes(l.name) && l.flow.triage !== false ? [{ name: l.name, flow: l.flow }] : [],
  );
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
