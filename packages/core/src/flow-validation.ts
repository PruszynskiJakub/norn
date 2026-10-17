import { BEHAVIOURS, type Behaviour, type BehaviourName } from "./behaviours.js";
import { BUILT_IN } from "./built-in-flows.js";
import { type Flow, type Mode, WORKSPACE_MODES, type WorkspaceMode } from "./flow.js";

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
  /** A field is missing or has the wrong type. */
  | { kind: "field-invalid"; at: FieldAt; expected: Expected }
  /** A field the format does not have, e.g. a misspelt one, which norn would otherwise ignore. */
  | { kind: "field-unknown"; at: FieldAt }
  | { kind: "start-unknown"; start: string }
  | { kind: "target-unknown"; state: string; word: string; to: string }
  /** The outcome notifies a person that their step is waiting, but `to` is an agent's: neither attended nor a human gate. */
  | { kind: "notify-agent-state"; state: string; word: string; to: string }
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
  /** A behaviour this norn does not have: misspelt, with `like` the known one it is closest to, or one of a newer norn. */
  | { kind: "behaviour-unknown"; state: string; behaviour: string; like: BehaviourName | null }
  /** Two behaviours of one state that cannot go together. */
  | { kind: "behaviours-conflict"; state: string; behaviours: [string, string] }
  /** A behaviour names a flow the repository does not have. */
  | { kind: "flow-unknown"; state: string; behaviour: string; flow: string }
  /** A behaviour of the state works only in the workspaces `workspace` lists, e.g. opensPR in own or parent, for its PR. */
  | { kind: "behaviour-needs"; state: string; behaviour: BehaviourName; workspace: readonly WorkspaceMode[] }
  /** The flow's name is one norn keeps for itself, e.g. reject, triage's outcome. */
  | { kind: "flow-reserved"; flow: string };

/**
 * Where a field is in a flow file: a top-level field (null for the file itself), a field of a state or of one of its
 * outcomes (null for the state or outcome itself), a state's behaviours, a parameter of one of them (null for the
 * behaviour's parameters as a whole), or an entry of renamed.
 */
export type FieldAt =
  | { in: "flow"; field: string | null }
  | { in: "state"; state: string; field: string | null }
  | { in: "outcome"; state: string; word: string; field: string | null }
  | { in: "behaviour"; state: string; behaviour: string; param: string | null }
  | { in: "renamed"; from: string };

/**
 * What a field must be, as a fact for a front end to word: a JSON type, a name the flow defines (one of its states, an
 * outcome word of the state, a flow of the repository), a hex colour, an object of behaviours or of a behaviour's
 * parameters, or one of a few values.
 */
export type Expected =
  | { kind: "string" | "boolean" | "object" | "hex-colour" | "state" | "outcome-word" | "flow-name" | "behaviours" | "params" }
  | { kind: "one-of"; values: readonly string[] };

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

/**
 * Reads a flow file and checks it; an invalid flow is kept with every error found, the flows it names included.
 * `exists` says whether a flow that is not built in exists, e.g. on the base branch.
 */
export async function readFlow(name: string, text: string, exists: (flow: string) => Promise<boolean>): Promise<LoadedFlow> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, name, errors: [{ kind: "not-json", detail: (e as Error).message }] };
  }
  const errors = [
    ...(RESERVED_FLOWS.includes(name) ? [{ kind: "flow-reserved", flow: name } as const] : []),
    ...validateFlow(data),
    ...(await flowsUnknown(data, exists)),
  ];
  return errors.length ? { ok: false, name, errors } : { ok: true, name, flow: data as Flow };
}

const STRING: Expected = { kind: "string" };
const BOOLEAN: Expected = { kind: "boolean" };
const OBJECT: Expected = { kind: "object" };
const STATE: Expected = { kind: "state" };
const MODES: readonly Mode[] = ["afk", "hil"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a state, as written, is an agent's step: not attended, and no human gate. */
const isAgentState = (state: unknown) =>
  isObject(state) && state.attended === false && !(isObject(state.behaviours) && Object.hasOwn(state.behaviours, "humanGate"));

/** The core checks: the shape, the start exists, every target exists or is an end, and no reserved names. */
export function validateFlow(data: unknown): FlowError[] {
  const errors: FlowError[] = [];
  const field = (at: FieldAt, expected: Expected) => errors.push({ kind: "field-invalid", at, expected });
  const top = (field: string | null): FieldAt => ({ in: "flow", field });
  if (!isObject(data)) {
    field(top(null), OBJECT);
    return errors;
  }
  const unknown = (where: (field: string) => FieldAt, value: Record<string, unknown>, fields: string[]) => {
    for (const key of Object.keys(value)) if (!fields.includes(key)) errors.push({ kind: "field-unknown", at: where(key) });
  };
  unknown(top, data, FLOW_FIELDS);
  if (typeof data.description !== "string") field(top("description"), STRING);
  if (typeof data.start !== "string") field(top("start"), STRING);
  if (!(WORKSPACE_MODES as readonly unknown[]).includes(data.workspace)) field(top("workspace"), { kind: "one-of", values: WORKSPACE_MODES });
  if (data.triage !== undefined && typeof data.triage !== "boolean") field(top("triage"), BOOLEAN);
  if (!isObject(data.states)) {
    field(top("states"), OBJECT);
    return errors;
  }
  const states = data.states;
  for (const [name, state] of Object.entries(states)) {
    const at = (field: string | null): FieldAt => ({ in: "state", state: name, field });
    if ((RESERVED_TARGETS as readonly string[]).includes(name) || RESERVED_STATE_NAMES.includes(name)) errors.push({ kind: "state-reserved", state: name });
    if (!isObject(state)) {
      field(at(null), OBJECT);
      continue;
    }
    unknown(at, state, STATE_FIELDS);
    if (typeof state.skill !== "string") field(at("skill"), STRING);
    if (typeof state.attended !== "boolean") field(at("attended"), BOOLEAN);
    for (const key of ["name", "description", "color"]) if (state[key] !== undefined && typeof state[key] !== "string") field(at(key), STRING);
    if (typeof state.color === "string" && !/^[0-9a-fA-F]{6}$/.test(state.color)) field(at("color"), { kind: "hex-colour" });
    if (state.evidence !== undefined && typeof state.evidence !== "boolean") field(at("evidence"), BOOLEAN);
    if (state.behaviours !== undefined) checkBehaviours(data, name, state.behaviours, errors);
    if (state.enterAs !== undefined && (typeof state.enterAs !== "string" || !Object.hasOwn(states, state.enterAs))) {
      field(at("enterAs"), STATE);
    }
    if (!isObject(state.outcomes)) {
      field(at("outcomes"), OBJECT);
      continue;
    }
    if (state.when !== undefined && state.when !== "afk" && state.when !== "hil") field(at("when"), { kind: "one-of", values: MODES });
    if (state.passThrough !== undefined && typeof state.passThrough !== "string") field(at("passThrough"), { kind: "outcome-word" });
    else if (state.when !== undefined && (state.passThrough === undefined || !Object.hasOwn(state.outcomes, state.passThrough))) {
      errors.push({ kind: "pass-through-invalid", state: name, word: state.passThrough ?? null });
    }
    for (const [word, outcome] of Object.entries(state.outcomes)) {
      const o = (field: string | null): FieldAt => ({ in: "outcome", state: name, word, field });
      if (!isObject(outcome)) {
        field(o(null), OBJECT);
        continue;
      }
      unknown(o, outcome, OUTCOME_FIELDS);
      if (typeof outcome.means !== "string") field(o("means"), STRING);
      for (const key of ["note", "needsHuman", "meansSkipped"]) if (outcome[key] !== undefined && typeof outcome[key] !== "string") field(o(key), STRING);
      if (outcome.notify !== undefined && typeof outcome.notify !== "boolean") field(o("notify"), BOOLEAN);
      if (typeof outcome.to !== "string") field(o("to"), STRING);
      else if (!Object.hasOwn(states, outcome.to) && !(RESERVED_TARGETS as readonly string[]).includes(outcome.to)) {
        errors.push({ kind: "target-unknown", state: name, word, to: outcome.to });
      } else if (outcome.notify === true && isAgentState(states[outcome.to])) {
        // The person would be told to act while norn next offers the same step to an agent.
        errors.push({ kind: "notify-agent-state", state: name, word, to: outcome.to });
      }
    }
  }
  if (typeof data.start === "string" && !Object.hasOwn(states, data.start)) errors.push({ kind: "start-unknown", start: data.start });
  if (data.renamed !== undefined) {
    if (!isObject(data.renamed)) field(top("renamed"), OBJECT);
    else
      for (const [from, to] of Object.entries(data.renamed)) {
        if (typeof to !== "string") field({ in: "renamed", from }, STRING);
        else if (!Object.hasOwn(states, to)) errors.push({ kind: "renamed-unknown", from, to });
      }
  }
  // Reachability follows pass-throughs and outcomes, so it needs them well formed.
  const passThroughsValid = !errors.some(
    (e) =>
      e.kind === "pass-through-invalid" ||
      (e.kind === "field-invalid" && (e.at.in === "outcome" || (e.at.in === "state" && ["when", "passThrough", "outcomes"].includes(e.at.field ?? "")))),
  );
  errors.push(...endUnreachable(states, passThroughsValid));
  return errors;
}

const isBehaviour = (name: string): name is BehaviourName => Object.hasOwn(BEHAVIOURS, name);

/** Each behaviour must be known, with valid parameters, and allowed beside the state's others. */
function checkBehaviours(flow: Record<string, unknown>, state: string, behaviours: unknown, errors: FlowError[]) {
  if (!isObject(behaviours)) {
    errors.push({ kind: "field-invalid", at: { in: "state", state, field: "behaviours" }, expected: { kind: "behaviours" } });
    return;
  }
  const known: BehaviourName[] = [];
  for (const [behaviour, params] of Object.entries(behaviours)) {
    if (!isBehaviour(behaviour)) {
      errors.push({ kind: "behaviour-unknown", state, behaviour, like: closestBehaviour(behaviour) });
      continue;
    }
    known.push(behaviour);
    const rule: Behaviour = BEHAVIOURS[behaviour];
    const at = (param: string | null): FieldAt => ({ in: "behaviour", state, behaviour, param });
    if (!isObject(params)) errors.push({ kind: "field-invalid", at: at(null), expected: { kind: "params" } });
    else {
      const declared = rule.params ?? {};
      for (const [name, p] of Object.entries(declared)) {
        const value = params[name];
        if ((value === undefined && p.required) || (value !== undefined && typeof value !== p.type))
          errors.push({ kind: "field-invalid", at: at(name), expected: p.expected });
      }
      for (const name of Object.keys(params)) if (!Object.hasOwn(declared, name)) errors.push({ kind: "field-unknown", at: at(name) });
      const states = isObject(flow.states) ? flow.states : {};
      for (const l of rule.leadsTo?.(params) ?? []) {
        if (l.param !== null && !Object.hasOwn(states, l.to) && !(RESERVED_TARGETS as readonly string[]).includes(l.to))
          errors.push({ kind: "field-invalid", at: at(l.param), expected: STATE });
      }
    }
    if (rule.workspaces && !(rule.workspaces as readonly unknown[]).includes(flow.workspace))
      errors.push({ kind: "behaviour-needs", state, behaviour, workspace: rule.workspaces });
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
 * The flows the behaviours of a flow file name that do not exist, read from the file as written, so they are reported
 * beside its other errors. `exists` says whether a flow that is not built in exists, e.g. on the base branch.
 */
async function flowsUnknown(data: unknown, exists: (flow: string) => Promise<boolean>): Promise<FlowError[]> {
  if (!isObject(data) || !isObject(data.states)) return [];
  const named = Object.entries(data.states).flatMap(([state, s]) =>
    isObject(s) && isObject(s.behaviours)
      ? Object.entries(s.behaviours).flatMap(([behaviour, params]) =>
          isBehaviour(behaviour) && isObject(params)
            ? ((BEHAVIOURS[behaviour] as Behaviour).flowsNamed?.(params) ?? []).map((flow) => ({ state, behaviour, flow }))
            : [],
        )
      : [],
  );
  const errors: FlowError[] = [];
  for (const n of named) if (!Object.hasOwn(BUILT_IN, n.flow) && !(await exists(n.flow))) errors.push({ kind: "flow-unknown", ...n });
  return errors;
}

/** The known behaviour a name not known is a misspelling of: the same but for case, or a letter or two off; null for none. */
function closestBehaviour(name: string): BehaviourName | null {
  let best: { name: BehaviourName; distance: number } | null = null;
  for (const known of Object.keys(BEHAVIOURS) as BehaviourName[]) {
    const distance = editDistance(name.toLowerCase(), known.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: known, distance };
  }
  return best?.name ?? null;
}

/** How many letters to insert, delete or change to turn a into b. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
