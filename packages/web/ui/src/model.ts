import type { BoardItem, BoardStory, FeedEvent, Flow, FlowState, LoadedFlow, StateKind } from "@norn/core";
import type { DashboardState } from "../../src/contract.ts";

/** A board item with the top-level issue it belongs to and the flow it runs. */
export interface Item extends BoardItem {
  /** A top-level issue, e.g. a story, rather than one of its slices. */
  isStory: boolean;
  story: number;
  /** Its flow when valid; null when it has none, or it is invalid. */
  flowDef: Flow | null;
  /** Its flow is invalid: norn refuses to move it until the flow is fixed. */
  flowInvalid: boolean;
}

/** Every item on the board, each top-level issue before its slices, with the flows of the read. */
export function allItems(board: BoardStory[], flows: LoadedFlow[]): Item[] {
  const byName = new Map(flows.map((f) => [f.name, f]));
  const flowed = (x: BoardItem) => {
    const f = x.flow === null ? undefined : byName.get(x.flow);
    return { flowDef: f?.ok ? f.flow : null, flowInvalid: f !== undefined && !f.ok };
  };
  const out: Item[] = [];
  for (const s of board) {
    out.push({ ...s, isStory: true, story: s.number, ...flowed(s) });
    for (const x of s.slices) out.push({ ...x, isStory: false, story: s.number, ...flowed(x) });
  }
  return out;
}

/** Where an item stands: its single state label, or how it closed. Null for no label, or more than one. */
export function stateOf(x: BoardItem): string | "merged" | "closed" | null {
  if (x.status !== "open") return x.status;
  return x.states.length === 1 ? x.states[0]! : null;
}

export function isDone(x: BoardItem): boolean {
  return x.status !== "open";
}

/** The colour that an item's dot in the sidebar gets. */
export type Dot = "bad" | "warn" | "done" | "blocked" | "live" | "none";

export function dotOf(x: Item): Dot {
  if (x.needsHuman) return "bad";
  if (atGate(x)) return "warn";
  if (x.holder?.stale) return "warn";
  if (isDone(x)) return "done";
  if (isHeld(x)) return "blocked";
  if (x.holder) return "live";
  return "none";
}

const uses = (s: FlowState | undefined, behaviour: string) => Object.hasOwn(s?.behaviours ?? {}, behaviour);

/** The state of the item's flow it is in; undefined without a single one. */
function current(x: Item): FlowState | undefined {
  const s = stateOf(x);
  return s === null ? undefined : x.flowDef?.states[s];
}

/** The item waits at a human gate of its flow: a person QAs it. */
export function atGate(x: Item): boolean {
  return !isDone(x) && uses(current(x), "humanGate");
}

/** Whether the label is a human gate of the item's flow. */
export function isGateLabel(x: Item, label: string): boolean {
  return uses(x.flowDef?.states[label], "humanGate");
}

/** The item cannot move: its flow holds it until its blockers close, or its flow is invalid. */
export function isHeld(x: Item): boolean {
  return !isDone(x) && (x.flowInvalid || uses(current(x), "syncsBlocked"));
}

/** Its flow creates slices: its progress is its slices', not a pipeline of its own. */
export function isSliced(x: Item): boolean {
  return Object.values(x.flowDef?.states ?? {}).some((s) => uses(s, "slices"));
}

/** Its flow counts fix rounds toward a limit. */
export function countsFixRounds(x: Item): boolean {
  return Object.values(x.flowDef?.states ?? {}).some((s) => uses(s, "countsFixRounds"));
}

/** A state's kind, as norn's stateKindOf has it: a human gate, attended, or run by an agent. */
function kindOf(s: FlowState): StateKind {
  return uses(s, "humanGate") ? "gate" : s.attended ? "attended" : "agent";
}

/** The colour of a state of the item's flow, as a CSS colour: its own, else its kind's. Null for a label that is no state of the flow. */
export function stateColor(x: Item, label: string, defaults: DashboardState["stateLabelDefaults"]): string | null {
  const s = x.flowDef?.states[label];
  return s ? colorOf(s, defaults) : null;
}

/** A state's colour as a CSS colour: its own, else its kind's, from the defaults the server sends, as norn creates labels. */
export function colorOf(s: FlowState, defaults: DashboardState["stateLabelDefaults"]): string {
  return `#${s.color ?? defaults[kindOf(s)].color}`;
}

/** How much a feed event asks for the developer's eye. */
export type Attention = "bad" | "warn" | "ok" | "none";

export function attentionOf(e: FeedEvent, flows: LoadedFlow[]): Attention {
  if (e.kind === "needs-human") return e.action === "raised" ? "bad" : "ok";
  if (e.kind === "claim") return e.action === "stale" ? "warn" : "none";
  if (e.kind === "pr") return e.action === "merged" ? "ok" : "none";
  if (e.kind === "outcome") {
    if (sentBack(e, flows)) return "warn";
    return stepGroupOf(e, flows) === "implement" ? "none" : "ok";
  }
  return "none";
}

type Outcome = Extract<FeedEvent, { kind: "outcome" }>;

/** The valid flow the outcome's issue ran its step in; null for triage, or a flow that is not valid. */
function flowOfOutcome(e: Outcome, flows: LoadedFlow[]): Flow | null {
  const f = e.flow === null ? undefined : flows.find((l) => l.name === e.flow);
  return f?.ok ? f.flow : null;
}

/** The state of its flow the outcome's step was taken in. */
export function stepStateOf(e: Outcome, flows: LoadedFlow[]): FlowState | undefined {
  return e.from === null ? undefined : flowOfOutcome(e, flows)?.states[e.from];
}

/** The states of the flow that count fix rounds: what an outcome into one sends back. */
function fixStates(flow: Flow): string[] {
  return Object.keys(flow.states).filter((s) => uses(flow.states[s], "countsFixRounds"));
}

/** Whether the outcome sends the work back for fixes, as its flow has it, or ends it unplanned, e.g. triage's reject. */
export function sentBack(e: Outcome, flows: LoadedFlow[]): boolean {
  if (e.to === "not-planned") return true;
  const flow = flowOfOutcome(e, flows);
  return flow !== null && e.from !== e.to && fixStates(flow).includes(e.to);
}

/** Whether a person checks the work in the outcome's step: a human gate of its flow. */
export function atGateStep(e: Outcome, flows: LoadedFlow[]): boolean {
  return uses(stepStateOf(e, flows), "humanGate");
}

/** Outcomes, escalations, merges and quiet agents stand out; everything else folds into routine runs. */
export function isSignificant(e: FeedEvent): boolean {
  return e.kind === "outcome" || e.kind === "needs-human" || (e.kind === "pr" && e.action === "merged") || (e.kind === "claim" && e.action === "stale");
}

export type StepGroup = "implement" | "review" | "qa" | "other";

/**
 * The Remarks filter an outcome's step belongs to, from what its state does in its flow: QA when it takes evidence or
 * is a human gate, implementing when it opens the PR or fixes what was sent back (or is the state such a state is
 * taken as), review when one of its outcomes sends the work back for fixes.
 */
export function stepGroupOf(e: Outcome, flows: LoadedFlow[]): StepGroup {
  const flow = flowOfOutcome(e, flows);
  const s = stepStateOf(e, flows);
  if (!flow || !s || e.from === null) return "other";
  if (s.evidence || uses(s, "humanGate")) return "qa";
  const fixes = fixStates(flow);
  const from = e.from;
  if (uses(s, "opensPR") || fixes.includes(from) || fixes.some((f) => flow.states[f].enterAs === from)) return "implement";
  if (Object.values(s.outcomes).some((o) => fixes.includes(o.to))) return "review";
  return "other";
}

/** The feed narrowed to a story's history (every event of it and its slices) or one slice's. */
export function feedFor(feed: FeedEvent[], selected: Item | null): FeedEvent[] {
  if (!selected) return feed;
  return selected.isStory ? feed.filter((e) => e.story === selected.number) : feed.filter((e) => e.issue === selected.number);
}

/** Open items whose agent stopped. */
export function quietItems(items: Item[]): Item[] {
  return items.filter((x) => !isDone(x) && x.holder?.stale);
}

/** Open items one fix round away from needs-human. */
export function nearLimitItems(items: Item[]): Item[] {
  return items.filter((x) => !isDone(x) && !x.needsHuman && x.fixRounds > 0 && x.fixRounds === x.maxFixRounds - 1);
}

/** The latest QA evidence of an item: the board's, else the newest in the feed. */
export function latestEvidenceOf(x: BoardItem, feed: FeedEvent[]) {
  if (x.latestEvidence) return x.latestEvidence;
  for (const e of feed) {
    if (e.issue !== x.number) continue;
    if (e.kind === "qa-evidence") return e.evidence;
    if (e.kind === "outcome" && e.evidence) return e.evidence;
  }
  return null;
}

/** One stop of a pipeline: a state, and the mode it runs in only, if any. */
export interface Stop {
  state: string;
  /** The step's name, e.g. review. */
  name: string;
  when: "afk" | "hil" | null;
}

/** Where a state leads on its first outcome, or where a behaviour moves it, e.g. waitsForSlices; undefined at an end. */
function firstTarget(s: FlowState): string | undefined {
  const outcome = Object.values(s.outcomes)[0];
  if (outcome) return outcome.to;
  for (const params of Object.values(s.behaviours ?? {})) if (typeof params?.to === "string") return params.to;
  return undefined;
}

/**
 * The item's pipeline: the path from its flow's start to closed, following each state's first outcome, through the state
 * a step is taken as. A state for the other mode than the item's is passed through, as norn does.
 */
export function pipelineOf(x: Item): Stop[] {
  const flow = x.flowDef;
  if (!flow) return [];
  const stops: Stop[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = flow.start; at !== undefined && Object.hasOwn(flow.states, at) && !seen.has(at); ) {
    seen.add(at);
    const s: FlowState = flow.states[at];
    if (s.when && x.mode && s.when !== x.mode) {
      at = s.outcomes[s.passThrough ?? ""]?.to;
      continue;
    }
    stops.push({ state: at, name: s.name ?? at, when: s.when ?? null });
    at = s.enterAs && !seen.has(s.enterAs) ? s.enterAs : firstTarget(s);
  }
  return stops;
}

/** How far along its pipeline the item is: the stop it is at; past the last when done; -1 when it is at none. */
export function pipelinePosition(x: Item, stops: Stop[]): number {
  if (isDone(x)) return stops.length;
  const s = stateOf(x);
  const flow = x.flowDef;
  if (s === null || !flow) return -1;
  const at = (state: string) => stops.findIndex((p) => p.state === state);
  if (at(s) >= 0) return at(s);
  // A state off the path, e.g. back for fixes: at the stop it is taken as, else just before the stop it leads back to.
  const enterAs = flow.states[s]?.enterAs;
  if (enterAs && at(enterAs) >= 0) return at(enterAs);
  const seen = new Set<string>();
  for (
    let next = flow.states[s] && firstTarget(flow.states[s]);
    next !== undefined && !seen.has(next);
    next = flow.states[next] && firstTarget(flow.states[next])
  ) {
    seen.add(next);
    if (at(next) >= 0) return Math.max(0, at(next) - 1);
  }
  return -1;
}

/** The names under a pipeline: each step once, where the stops of one step run together. */
export function pipelineNames(stops: Stop[]): string[] {
  return stops.map((p) => p.name).filter((name, i, all) => i === 0 || all[i - 1] !== name);
}

export function mergedSlices(s: BoardStory): number {
  return s.slices.filter((x) => x.status === "merged").length;
}

/** Links into the repository; null when the read model has no repository URL yet. */
export const links = {
  branch: (repoUrl: string | null, branch: string) => (repoUrl ? `${repoUrl}/tree/${branch}` : null),
  commit: (repoUrl: string | null, sha: string) => (repoUrl ? `${repoUrl}/tree/${sha}` : null),
  file: (repoUrl: string | null, sha: string, path: string) => (repoUrl ? `${repoUrl}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}` : null),
};

/** A way from one state to another in a flow's graph: the outcome words that take it, or what moves an issue along it on its own. */
export interface FlowEdge {
  from: string;
  to: string;
  words: string[];
  /** Set when no outcome takes the way: the behaviour that moves the issue on its own, e.g. syncsBlocked, or enterAs. */
  by: string | null;
}

/** A flow laid out in layers: each state at its distance from the start, the ends it reaches in a last layer of their own. */
export interface FlowGraph {
  layers: string[][];
  edges: FlowEdge[];
  /** The ends the flow reaches, e.g. closed, as opposed to its states. */
  ends: Set<string>;
}

/** Where a state's behaviours move an issue on their own: a `to` parameter, or closed for waitsForMerge, which ends the issue once its PR merges. */
function behaviourEdges(state: string, s: FlowState): FlowEdge[] {
  return Object.entries(s.behaviours ?? {}).flatMap(([name, params]) => {
    const to = typeof params?.to === "string" ? params.to : name === "waitsForMerge" ? "closed" : null;
    return to === null ? [] : [{ from: state, to, words: [], by: name }];
  });
}

/**
 * A flow's states and the ways between them, laid out for drawing: states in layers by their distance from the start
 * along any way, the states no way reaches after them, then the ends. Within a layer, states sit under those leading to them.
 */
export function flowGraph(flow: Flow): FlowGraph {
  const edges: FlowEdge[] = [];
  for (const [state, s] of Object.entries(flow.states)) {
    const byTarget = new Map<string, FlowEdge>();
    for (const [word, o] of Object.entries(s.outcomes)) {
      const e = byTarget.get(o.to);
      if (e) e.words.push(word);
      else byTarget.set(o.to, { from: state, to: o.to, words: [word], by: null });
    }
    if (s.enterAs && s.enterAs !== state && !byTarget.has(s.enterAs)) byTarget.set(s.enterAs, { from: state, to: s.enterAs, words: [], by: "enterAs" });
    edges.push(...byTarget.values(), ...behaviourEdges(state, s));
  }
  const isState = (name: string) => Object.hasOwn(flow.states, name);
  const depth = new Map<string, number>();
  const queue = isState(flow.start) ? [flow.start] : [];
  if (queue.length) depth.set(flow.start, 0);
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of edges) {
      if (e.from !== at || !isState(e.to) || depth.has(e.to)) continue;
      depth.set(e.to, depth.get(at)! + 1);
      queue.push(e.to);
    }
  }
  const layers: string[][] = [];
  for (const [state, d] of depth) {
    layers[d] ??= [];
    layers[d].push(state);
  }
  const unreached = Object.keys(flow.states).filter((s) => !depth.has(s));
  if (unreached.length) layers.push(unreached);
  const ends = new Set(edges.map((e) => e.to).filter((to) => !isState(to)));
  if (ends.size) layers.push([...ends]);
  // One pass ordering each layer by where the states leading to it sit, so fewer arrows cross.
  const place = new Map<string, number>();
  for (const layer of layers) {
    const pull = (s: string) => {
      const from = edges.filter((e) => e.to === s && place.has(e.from)).map((e) => place.get(e.from)!);
      return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Number.POSITIVE_INFINITY;
    };
    const order = new Map(layer.map((s, i) => [s, { pull: pull(s), i }]));
    layer.sort((a, b) => order.get(a)!.pull - order.get(b)!.pull || order.get(a)!.i - order.get(b)!.i);
    for (const [i, s] of layer.entries()) place.set(s, i - (layer.length - 1) / 2);
  }
  return { layers, edges, ends };
}
