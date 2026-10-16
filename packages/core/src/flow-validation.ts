import { BEHAVIOURS, type Behaviour, type BehaviourName } from "./behaviours.js";
import { BUILT_IN } from "./built-in-flows.js";
import type { Flow, Mode } from "./flow.js";

/**
 * The checks a flow file passes before norn runs it: its shape, its names and
 * that every state can end. What fails is kept as facts for a front end to word.
 */

/** A flow read from its file: valid, or kept with what is wrong with it. */
export type LoadedFlow = { ok: true; name: string; flow: Flow } | { ok: false; name: string; errors: FlowError[] };

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
export const RESERVED_FLOWS = ["reject"];

/** The flags norn sets itself on every issue; no state may take these names either. */
const RESERVED_STATE_NAMES = ["in-progress", "needs-human"];

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
    if ((RESERVED_TARGETS as readonly string[]).includes(name) || RESERVED_STATE_NAMES.includes(name)) errors.push({ kind: "state-reserved", state: name });
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
  for (const n of named) if (!Object.hasOwn(BUILT_IN, n.flow) && !(await exists(n.flow))) errors.push({ kind: "flow-unknown", ...n });
  return errors.length ? { ok: false, name: loaded.name, errors } : loaded;
}
