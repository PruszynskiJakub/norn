import { type Flow, flowNameOf, flowStatesOf, hasSpec, usedIn, uses } from "./flow.js";
import { flowOf, validFlow } from "./flow-loading.js";
import type { GitHub, Issue } from "./github.js";
import { locate, type Location } from "./location.js";
import type { Event } from "./events.js";
import type { Outcome, Step } from "./machine.js";
import type { Refusal } from "./refusals.js";
import type { WaitItem } from "./waiting.js";
import { sh, specPath } from "./text.js";
import { bestEffort, type Ctx, fixLimitReason, fixRounds, mergeRefusal, oneLine, setState, stateLabels, withShortClaim } from "./transitions.js";

/**
 * Behaviours are norn's built-in mechanics that a state of a flow opts into by
 * name. Each one contributes what it needs to the commands: its lines to the
 * briefing, its say on an outcome done applies, its checks before an issue
 * leaves the state, and its automatic follow-ups. The set is closed; a flow
 * only names them, as `"behaviours": { "opensPR": {} }`, each with its
 * parameters. Each also says what validation asks of a flow that uses it.
 */

/** A behaviour's parameters, as written in the flow; `{}` when it takes none. */
export type BehaviourParams = Record<string, unknown>;

/** What a behaviour sees of a step being briefed in a flow that uses it. */
export interface BriefingInput {
  ctx: Ctx;
  issue: Issue;
  flow: Flow;
  /** The flow's name, the issue's type. */
  flowName: string;
  /** The issue's state after take, e.g. fixing. */
  state: string | null;
  /** The state the issue was in before take moved it, e.g. changes-requested. */
  from: string | null;
  step: Step;
  /** Where the work happens; null for a flow without a workspace. */
  loc: Location | null;
}

/** What a behaviour sees of an outcome done applies in a flow. */
export interface OutcomeInput {
  ctx: Ctx;
  issue: Issue;
  flow: Flow;
  /** The flow's name, the issue's type. */
  flowName: string;
  /** The state the issue leaves; null with none. */
  from: string | null;
  /** The outcome as the flow declares it. */
  outcome: Outcome;
  note?: string;
}

/** What a behaviour sees of an issue in a state of its flow, e.g. one that holds it. */
export interface HeldInput {
  ctx: Ctx;
  issue: Issue;
  flow: Flow;
  /** The flow's name, the issue's type. */
  flowName: string;
  state: string;
}

/** The outcome done applies once behaviours had their say, and the fix-round limit it reached, if any. */
export interface Applied {
  outcome: Outcome;
  fixLimit: number | null;
}

/** A parameter of a behaviour: its JSON type, whether a state must give it, and what it is, for the error. */
export interface BehaviourParam {
  type: "string" | "boolean";
  required: boolean;
  /** What it must be, e.g. "a state of the flow". */
  expected: string;
}

export interface Behaviour {
  /** The parameters it takes, by name; none when missing. The validator and the flow JSON Schema both follow these. */
  params?: Record<string, BehaviourParam>;
  /** Behaviours the same state cannot also have. */
  excludes?: readonly string[];
  /** What the flow must be like for the behaviour to work, e.g. a workspace; the field and what it must be. */
  requires?(flow: Record<string, unknown>): { field: string; expected: string } | null;
  /** The flows its parameters name, e.g. the type slices get; each must exist. */
  flowsNamed?(params: BehaviourParams): string[];
  /** The states its parameters name, which it moves an issue to on its own: each must be a state, and counts as a way on. */
  leadsTo?(params: BehaviourParams): { param: string; to: string }[];
  /** An issue in the state has no step to take: the behaviour moves it on by itself. */
  holds?: boolean;
  /** Why take and done refuse an issue the behaviour holds; `story` is the issue to run norn next on, if any. */
  held?(h: HeldInput, story: number | null): Promise<Refusal>;
  /** What norn next lists for an issue the behaviour holds, if anything. */
  waiting?(h: HeldInput): Promise<WaitItem | null>;
  /** The issue's own branch must be on GitHub in the state, e.g. for its slices to branch off: norn creates it on the way in. */
  needsBranch?: boolean;
  /** Housekeeping norn next does for an issue in the state, e.g. moving it on; best effort. May change `h.issue` to what it left. */
  reconcile?(h: HeldInput): Promise<Event[]>;
  /** Briefing lines, for a step in any state of a flow that uses the behaviour: the behaviour decides which states it speaks for. */
  briefing?(b: BriefingInput): Promise<string[]>;
  /** Checked by done before an issue leaves a state with the behaviour, before anything changes; a refusal stops done. */
  leave?(o: OutcomeInput): Promise<Refusal | null>;
  /** Run by done for an outcome into a state with the behaviour, before it is applied: may change what is applied. */
  enter?(o: OutcomeInput, applied: Applied): Promise<Applied>;
  /** Run once done applied an outcome into or out of a state with the behaviour; best effort, see bestEffort. */
  followUps?(o: OutcomeInput, applied: Applied): Promise<Event[]>;
}

/** The flow's name as a word that starts a sentence, e.g. Slice. */
const named = (flowName: string) => flowName.charAt(0).toUpperCase() + flowName.slice(1);

/** The params of the behaviour in the state, `{}` when it takes none; undefined when the state does not use it. */
function paramsOf(flow: Flow, state: string | null, name: BehaviourName): BehaviourParams | undefined {
  return state === null ? undefined : flow.states[state]?.behaviours?.[name];
}

const writesSpec: Behaviour = {
  params: { readsIssue: { type: "boolean", required: false, expected: "true or false" } },
  /** The spec lives on the issue's own branch. */
  requires: (flow) => (flow.workspace === "own" ? null : { field: "workspace", expected: '"own", for the spec\'s branch' }),
  /** Every step works on the spec; in its state, the step writes it, from the issue's discussion when readsIssue says so, and pushes it. */
  async briefing({ issue, flow, state, loc }) {
    if (!loc) return [];
    const lines = [`Spec to work on: ${specPath(issue.number, loc.slug)}`];
    const params = paramsOf(flow, state, "writesSpec");
    if (params) {
      if (params.readsIssue === true) lines.push(readIssue(issue.number));
      lines.push(`Commit the spec on ${loc.branch} and push it, so the link norn posts resolves.`);
    }
    return lines;
  },
};

/** The type of the slices the flow creates, as its slices behaviour names it; null when it creates none. */
export function sliceType(flow: Flow): string | null {
  for (const state of Object.keys(flow.states)) {
    const type = paramsOf(flow, state, "slices")?.type;
    if (typeof type === "string") return type;
  }
  return null;
}

/** The state of the flow where slices are added; null for none. */
export function slicingState(flow: Flow): string | null {
  return Object.keys(flow.states).find((s) => uses(flow, s, "slices")) ?? null;
}

/** Of a parent's sub-issues, its slices: those of the type its flow's slices behaviour names. Anything else a person attached is not norn's. */
export function slicesAmong<I extends Issue>(subIssues: I[], flow: Flow): I[] {
  const type = sliceType(flow);
  return type === null ? [] : subIssues.filter((i) => i.labels.includes(`type:${type}`));
}

/** The slices of issue `parent`, whose flow is `flow`. */
export async function slicesOf(github: Pick<GitHub, "subIssues">, parent: number, flow: Flow): Promise<Issue[]> {
  return sliceType(flow) === null ? [] : slicesAmong(await github.subIssues(parent), flow);
}

const slices: Behaviour = {
  params: { type: { type: "string", required: true, expected: "a flow's name" } },
  /** The slices get the type it names, which must be a flow. */
  flowsNamed: (p) => (typeof p.type === "string" ? [p.type] : []),
  /** In its state, how to create the slices with norn add-slice and give them bodies. */
  async briefing({ issue, flow, state, loc }) {
    if (!uses(flow, state, "slices")) return [];
    const n = issue.number;
    return [
      "Create the slices in dependency order, blockers first, one command per slice:",
      `  norn add-slice ${n} "title" --mode afk|hil [--blocked-by <slice>]...`,
      "  --mode afk when an agent can verify every criterion, hil when a person must also look at it.",
      "Then give each slice its body: gh issue edit <slice> --body-file <file>",
      ...(loc ? [`Push ${loc.branch} once the slices exist, so slice PRs can target it.`] : []),
    ];
  },
  /** The issue moves on only once it has a slice; resolving needs-human stays put and needs none. */
  async leave({ ctx, issue, flow, from, outcome }) {
    if (from === outcome.to || (await slicesOf(ctx.github, issue.number, flow)).length) return null;
    return { kind: "no-slices", issue: issue.number };
  },
};

/** The states an issue can reach from `start` through outcomes, `start` included. */
function reachable(flow: Flow, start: string): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length) {
    const s = todo.pop()!;
    if (seen.has(s) || !flow.states[s]) continue;
    seen.add(s);
    todo.push(...Object.values(flow.states[s].outcomes).map((o) => o.to));
  }
  return seen;
}

/** Where waitsForSlices moves an issue of the flow once its slices are merged, and the state it waits in; null for none. */
function waitState(flow: Flow): { held: string; to: string } | null {
  const held = Object.keys(flow.states).find((s) => uses(flow, s, "waitsForSlices"));
  return held === undefined ? null : { held, to: paramsOf(flow, held, "waitsForSlices")!.to as string };
}

const waitsForSlices: Behaviour = {
  params: { to: { type: "string", required: true, expected: "a state of the flow" } },
  leadsTo: (p) => (typeof p.to === "string" ? [{ param: "to", to: p.to }] : []),
  /** The slices' PRs go into the issue's own branch, and its own PR into the base branch. */
  requires: (flow) => (flow.workspace === "own" ? null : { field: "workspace", expected: '"own", for the branch its slices merge into' }),
  holds: true,
  needsBranch: true,
  async held({ issue, state }) {
    return { kind: "story-in-implementation", issue: issue.number, state };
  },
  /**
   * Once the slices are merged, the work is on the issue's own PR: the states after the wait show it and its diff, and
   * a state that fixes what review or QA sent back commits straight onto the branch.
   */
  async briefing({ flow, flowName, state, loc }) {
    const wait = waitState(flow);
    if (!loc || !wait || state === null || !reachable(flow, wait.to).has(state)) return [];
    if (uses(flow, state, "countsFixRounds")) return [`Commit the fixes straight onto the ${flowName} branch ${loc.branch} and push them.`];
    return [`${named(flowName)} PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`];
  },
  async reconcile({ ctx, issue }) {
    return bestEffort("move-story-on", issue.number, issue.number, () => moveOnFromSlices(ctx, issue.number));
  },
};

/**
 * Once every slice of the issue is merged, opens its PR into the base branch and moves it on to the state
 * waitsForSlices names. Does nothing for an issue that does not wait for its slices.
 */
export async function moveOnFromSlices(ctx: Ctx, n: number): Promise<Event[]> {
  const { github } = ctx;
  const issue = await github.getIssue(n);
  const loaded = await flowOf(ctx, issue);
  const flow = validFlow(loaded);
  const wait = flow ? waitState(flow) : null;
  if (!flow || !loaded || !wait || issue.state !== "open" || flowStatesOf(issue, flow).join() !== wait.held) return [];
  const slices = await slicesOf(github, n, flow);
  if (!slices.length || slices.some((s) => s.state !== "closed")) return [];
  const loc = await locate(issue, ctx, flow);
  if (!loc) return [];
  const moved = await withShortClaim(ctx, n, async () => {
    const pr =
      (await github.findPullRequest(loc.branch)) ??
      (await github.createPullRequest({
        head: loc.branch,
        base: loc.base,
        title: issue.title,
        body: `Closes #${n}${hasSpec(flow) ? `\n\nSpec: ${specPath(n, loc.slug)}` : ""}`,
      }));
    await setState(ctx, issue, wait.to, `Every slice is merged into ${loc.branch}. ${named(loaded.name)} PR: #${pr.number}.`, flow);
  });
  return moved ? [{ kind: "story-promoted", story: n }] : [];
}

const waitsForMerge: Behaviour = {
  /** It ends the issue on its own, once its PR is merged. */
  leadsTo: () => [{ param: "", to: "closed" }],
  /** The PR comes from the issue's own branch into the base branch. */
  requires: (flow) => (flow.workspace === "own" ? null : { field: "workspace", expected: '"own", for the PR its owner merges' }),
  holds: true,
  async held({ issue, state }) {
    return { kind: "story-in-merge-queue", issue: issue.number, owner: issue.assignees[0] ?? null, state };
  },
  async waiting({ ctx, issue }) {
    return { issue: issue.number, reason: "owner-merge", owner: issue.assignees[0] ?? null, into: ctx.config.baseBranch };
  },
  async reconcile(h) {
    return bestEffort("close-merged-story", h.issue.number, h.issue.number, async () => {
      if (!(await closeMerged(h))) return [];
      h.issue.state = "closed";
      h.issue.labels = h.issue.labels.filter((l) => !Object.hasOwn(h.flow.states, l));
      return [{ kind: "story-closed", story: h.issue.number }];
    });
  },
};

/**
 * Closes an issue waiting for its PR to be merged once it is. GitHub closes it
 * through `Closes #N` only for PRs into the default branch, so a baseBranch like
 * develop would leave it open for good. Returns whether the issue was closed.
 */
async function closeMerged({ ctx, issue, flow, flowName, state }: HeldInput): Promise<boolean> {
  if (issue.state !== "open") return false;
  const loc = await locate(issue, ctx, flow);
  const pr = loc ? await ctx.github.findPullRequest(loc.branch) : null;
  if (pr?.state !== "merged") return false;
  return withShortClaim(ctx, issue.number, async () => {
    await ctx.github.comment(issue.number, `norn: ${state} → closed (automatic)\n\nThe ${flowName} PR #${pr.number} is merged into ${pr.base}.`);
    await ctx.github.closeIssue(issue.number, "completed");
    await ctx.github.removeLabels(issue.number, ["in-progress", ...stateLabels(issue, undefined, flow)]);
  });
}

const opensPR: Behaviour = {
  /** The PR comes from the issue's own branch, into the base branch or the parent's. */
  requires: (flow) => (flow.workspace === "own" || flow.workspace === "parent" ? null : { field: "workspace", expected: '"own" or "parent", for its PR' }),
  /**
   * In its state, how to open or update the PR; in the others, the PR and its diff: a PR into the base branch once it
   * exists, one into the parent's branch always, as its branch and base are known.
   */
  async briefing({ ctx, issue, flow, flowName, state, loc }) {
    if (!loc) return [];
    const diff = `Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`;
    const parent = flow.workspace === "parent";
    if (uses(flow, state, "opensPR")) {
      const body = parent ? `Part of #${loc.story.number}. ${named(flowName)} #${issue.number}.` : `Closes #${issue.number}.`;
      return [
        `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
        // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
        `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue.title)} --body ${sh(body)}`,
        ...(parent ? [] : [diff]),
      ];
    }
    // Where the PR gets merged, mergesSlice says what to do with it instead.
    if (uses(flow, state, "mergesSlice")) return [];
    if (parent) return [`${named(flowName)} PR: ${loc.branch} into ${loc.base}. ${diff}`];
    const pr = await ctx.github.findPullRequest(loc.branch);
    return pr ? [`PR #${pr.number}: ${loc.branch} into ${pr.base}. ${diff}`] : [];
  },
};

/** How to read issue n with its comments. */
export function readIssue(n: number): string {
  return `Read the issue: gh issue view ${n} --comments`;
}

/** How QA evidence reaches the issue. */
export const EVIDENCE_FILES =
  "Keep screenshots, logs and command output in a directory outside the repository and finish with --evidence <dir>: norn pushes the files and embeds them in the comment. Do not commit them.";

/** How a person QAs issue n with the user, running the app from `branch`, or where they are without one. */
export function humanQaLines(n: number, branch: string | null): string[] {
  return [
    `Run the app${branch ? ` from ${branch}` : ""} on this machine and walk the user through what is left, plus anything in the evidence they question.`,
    "Tie each remark the user brings to a criterion; a remark on a criterion fails it. For a remark outside the criteria, the user decides:",
    `  follow up (the default): gh issue create --title "<remark>" --body "From QA of #${n}: <remark>" (it goes through triage)`,
    "  pull it in: it fails this item, like a criterion",
    "  drop it: say so in the note",
    `Every failure needs a repro. ${EVIDENCE_FILES}`,
  ];
}

/**
 * Why a person QAs an issue at the gate `state` of the flow `name`: what the outcomes into it notify, when they say;
 * else its mode, for a gate that runs in one mode only; else its type.
 */
export function gateOf(flow: Flow, state: string, name: string): string {
  const said = Object.values(flow.states).flatMap((s) => Object.values(s.outcomes).filter((o) => o.to === state && o.notify));
  if (said.length) return said[0].notify!;
  const when = flow.states[state]?.when;
  return when ? `mode:${when}` : `type:${name}`;
}

const humanGate: Behaviour = {
  /** At the gate, how a person QAs with the user and how remarks and evidence reach the issue. */
  async briefing({ issue, flow, state, loc }) {
    if (!uses(flow, state, "humanGate")) return [];
    return [
      `Start from the agent's QA comment on #${issue.number}: its evidence, and what it left for a person. ${readIssue(issue.number)}`,
      ...humanQaLines(issue.number, loc?.branch ?? null),
    ];
  },
  /** Reaching the gate puts the issue in a person's hands: they are notified, and the agent stops. */
  async enter({ flow, flowName, from, outcome }, applied) {
    // Staying at the gate, e.g. needs-human resolved there, is no new hand-over.
    if (from === outcome.to || applied.outcome.notify) return applied;
    return { ...applied, outcome: { ...applied.outcome, notify: gateOf(flow, outcome.to, flowName) } };
  },
};

/** The states of the flow that count fix rounds. */
export function fixStatesOf(flow: Flow): string[] {
  return Object.keys(flow.states).filter((s) => uses(flow, s, "countsFixRounds"));
}

const countsFixRounds: Behaviour = {
  /**
   * Rework is a step taken from a state that counts fix rounds, or one taken
   * again in the state such a state enters as, once a round has been counted.
   */
  async briefing({ ctx, issue, flow, state, from }) {
    const fixStates = fixStatesOf(flow);
    const entered = fixStates.some((s) => flow.states[s].enterAs === state);
    const rework = (from !== null && fixStates.includes(from)) || (entered && fixRounds(await ctx.github.listComments(issue.number), fixStates) > 0);
    return rework ? [`This is rework: the latest review or QA comment on #${issue.number} lists what to fix. ${readIssue(issue.number)}`] : [];
  },
  /** A round starts when an outcome sends the issue into the state from another; past the limit, a person decides instead. */
  async enter({ ctx, issue, flow, from, outcome, note }, applied) {
    if (from === outcome.to) return applied;
    const rounds = fixRounds(await ctx.github.listComments(issue.number), fixStatesOf(flow)) + 1;
    if (rounds <= ctx.config.maxFixRounds) return applied;
    const fixLimit = ctx.config.maxFixRounds;
    return { outcome: { ...applied.outcome, needsHuman: `${note ? `escalated: "${oneLine(note)}" ` : ""}${fixLimitReason(fixLimit)}` }, fixLimit };
  },
};

const mergesSlice: Behaviour = {
  /** The PR it merges goes into the parent's branch. */
  requires: (flow) => (flow.workspace === "parent" ? null : { field: "workspace", expected: '"parent", for the PR into the parent\'s branch' }),
  /** In its state, how to bring the branch up to date and merge its PR. */
  async briefing({ flow, state, loc }) {
    if (!loc || !uses(flow, state, "mergesSlice")) return [];
    return [
      `Merge origin/${loc.base} into ${loc.branch}, resolving conflicts if needed, and push.`,
      `Then merge the PR: gh pr merge ${sh(loc.branch)} --merge`,
    ];
  },
  /** The issue moves on only once its PR is merged into the parent's branch; resolving needs-human stays put and needs none. */
  async leave({ ctx, issue, flow, from, outcome }) {
    return from === outcome.to ? null : mergeRefusal(ctx, issue, flow);
  },
  /**
   * Once merged and closed, its worktree waits for norn tidy, and the parent moves on: the issues the merge unblocked
   * are released, and a parent waiting for its slices moves on once every slice is merged.
   */
  async followUps({ ctx, issue, flow, outcome }) {
    if (outcome.to !== "closed") return [];
    const parent = await ctx.github.parentOf(issue.number);
    if (!parent) return [];
    const events: Event[] = [];
    const loc = await locate(issue, ctx, flow);
    if (loc && (await ctx.workspace.worktreeExists(loc.worktree))) events.push({ kind: "worktree-left-for-tidy", worktree: loc.worktree });
    events.push(...(await bestEffort("unblock-slices", parent, parent, () => releaseBlocked(ctx, parent))));
    events.push(...(await bestEffort("move-story-on", parent, parent, () => moveOnFromSlices(ctx, parent))));
    return events;
  },
};

const syncsBlocked: Behaviour = {
  params: { to: { type: "string", required: true, expected: "a state of the flow" } },
  leadsTo: (p) => (typeof p.to === "string" ? [{ param: "to", to: p.to }] : []),
  holds: true,
  async held({ ctx, issue }, story) {
    return { kind: "blocked", issue: issue.number, blockers: await openBlockers(ctx, issue.number), story };
  },
  async waiting({ ctx, issue }) {
    return { issue: issue.number, reason: "blocked", blockers: await openBlockers(ctx, issue.number) };
  },
};

async function openBlockers(ctx: Ctx, n: number): Promise<number[]> {
  return (await ctx.github.blockedBy(n)).filter((b) => b.state === "open").map((b) => b.number);
}

/** Every behaviour norn knows, by name, in the order their briefing lines appear. A name outside it fails validation, e.g. one from a newer norn. */
export const BEHAVIOURS = {
  writesSpec,
  countsFixRounds,
  opensPR,
  waitsForSlices,
  humanGate,
  mergesSlice,
  syncsBlocked,
  slices,
  waitsForMerge,
} satisfies Record<string, Behaviour>;

export type BehaviourName = keyof typeof BEHAVIOURS;

/** The behaviours a flow uses anywhere, in registry order. */
function inFlow(flow: Flow): Behaviour[] {
  return (Object.entries(BEHAVIOURS) as [BehaviourName, Behaviour][]).filter(([name]) => usedIn(flow, name)).map(([, b]) => b);
}

/** The briefing lines every behaviour of the flow contributes to the step. */
export async function behaviourLines(b: BriefingInput): Promise<string[]> {
  const lines: string[] = [];
  for (const behaviour of inFlow(b.flow)) if (behaviour.briefing) lines.push(...(await behaviour.briefing(b)));
  return lines;
}

/** The behaviours of one state of the flow, in registry order. */
function inState(flow: Flow, state: string | null): Behaviour[] {
  return (Object.entries(BEHAVIOURS) as [BehaviourName, Behaviour][]).filter(([name]) => uses(flow, state, name)).map(([, b]) => b);
}

/** Why the behaviours of the state the issue leaves stop the outcome; null when none does. */
export async function leaveRefusal(o: OutcomeInput): Promise<Refusal | null> {
  for (const behaviour of inState(o.flow, o.from)) {
    const refusal = await behaviour.leave?.(o);
    if (refusal) return refusal;
  }
  return null;
}

/** The outcome as the behaviours of the state it enters change it. */
export async function entering(o: OutcomeInput): Promise<Applied> {
  let applied: Applied = { outcome: o.outcome, fixLimit: null };
  for (const behaviour of inState(o.flow, o.outcome.to)) if (behaviour.enter) applied = await behaviour.enter(o, applied);
  return applied;
}

/** The follow-ups of the behaviours of the states the outcome left and entered, each behaviour once. */
export async function behaviourFollowUps(o: OutcomeInput, applied: Applied): Promise<Event[]> {
  const behaviours = new Set([...inState(o.flow, o.from), ...inState(o.flow, o.outcome.to)]);
  const events: Event[] = [];
  for (const behaviour of behaviours) if (behaviour.followUps) events.push(...(await behaviour.followUps(o, applied)));
  return events;
}

/** Whether an issue in the state has no step to take, because a behaviour of the state moves it on by itself. */
export function holds(flow: Flow, state: string): boolean {
  return inState(flow, state).some((b) => b.holds);
}

/** Why take and done refuse an issue a behaviour of its state holds; `story` is the issue to run norn next on, if any. */
export async function heldRefusal(h: HeldInput, story: number | null): Promise<Refusal> {
  const behaviour = inState(h.flow, h.state).find((b) => b.held);
  return behaviour ? behaviour.held!(h, story) : { kind: "no-step", issue: h.issue.number, state: h.state, story };
}

/** What norn next lists for an issue a behaviour of its state holds; null for nothing. */
export async function heldWaiting(h: HeldInput): Promise<WaitItem | null> {
  for (const behaviour of inState(h.flow, h.state)) {
    const item = await behaviour.waiting?.(h);
    if (item) return item;
  }
  return null;
}

/** Whether the issue's own branch must be on GitHub once it is in the state. */
export function needsBranch(flow: Flow, state: string): boolean {
  return flow.workspace === "own" && inState(flow, state).some((b) => b.needsBranch);
}

/** The housekeeping the behaviours of the issue's state do for norn next. */
export async function reconcileState(h: HeldInput): Promise<Event[]> {
  const events: Event[] = [];
  for (const behaviour of inState(h.flow, h.state)) if (behaviour.reconcile) events.push(...(await behaviour.reconcile(h)));
  return events;
}

/** An issue in a state of its flow, as the hooks above see it; null without a single state. */
export function heldInput(ctx: Ctx, issue: Issue, flow: Flow): HeldInput | null {
  const states = flowStatesOf(issue, flow);
  return states.length === 1 ? { ctx, issue, flow, flowName: flowNameOf(issue) ?? "", state: states[0] } : null;
}

/** The flow's state that holds issues until their blockers close, and the state syncsBlocked releases them to; null for none. */
export function blockedStates(flow: Flow): { held: string; release: string } | null {
  const held = Object.keys(flow.states).find((s) => uses(flow, s, "syncsBlocked"));
  return held === undefined ? null : { held, release: flow.states[held].behaviours!.syncsBlocked!.to as string };
}

/** The state an issue of the flow starts in: held while it has open blockers, when the flow holds blocked issues. */
export function startState(flow: Flow, blocked: boolean): string {
  const states = blockedStates(flow);
  return blocked && states ? states.held : flow.start;
}

/**
 * Brings the open sub-issues of a parent in line with their native blocked-by
 * relations, for every flow with syncsBlocked: an issue whose blockers are all
 * closed is released to the state the behaviour names, and one released whose
 * blockers reopened is held again. Returns what changed.
 */
export async function releaseBlocked(ctx: Ctx, parent: number): Promise<Event[]> {
  const events: Event[] = [];
  for (const issue of await ctx.github.subIssues(parent)) {
    if (issue.state !== "open") continue;
    const flow = validFlow(await flowOf(ctx, issue));
    const states = flow ? blockedStates(flow) : null;
    if (!flow || !states) continue;
    const current = flowStatesOf(issue, flow);
    const state = current.length === 1 ? current[0] : null;
    if (state !== states.held && state !== states.release) continue;
    const open = (await ctx.github.blockedBy(issue.number)).filter((b) => b.state === "open");
    const want = open.length ? states.held : states.release;
    if (want === state) continue;
    const why = open.length ? `Blocked by ${open.map((b) => `#${b.number}`).join(", ")}.` : "All blockers are closed.";
    if (await withShortClaim(ctx, issue.number, () => setState(ctx, issue, want, why, flow))) {
      events.push({ kind: "slice-state-changed", issue: issue.number, state: want });
    }
  }
  return events;
}
