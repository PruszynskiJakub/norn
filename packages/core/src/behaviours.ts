import { type Flow, flowOf, flowStatesOf } from "./flow.js";
import type { Issue } from "./github.js";
import { locate, type Location } from "./location.js";
import type { Event } from "./events.js";
import type { Outcome, Step } from "./machine.js";
import type { Refusal } from "./refusals.js";
import { sh } from "./text.js";
import { bestEffort, type Ctx, fixLimitReason, fixRounds, mergeRefusal, oneLine, promoteStory, setState, withShortClaim } from "./transitions.js";

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

/** The outcome done applies once behaviours had their say, and the fix-round limit it reached, if any. */
export interface Applied {
  outcome: Outcome;
  fixLimit: number | null;
}

export interface Behaviour {
  /** What is wrong with its parameters: the parameter's name and what it must be. */
  params?(params: BehaviourParams): { param: string; expected: string }[];
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
  /** Briefing lines, for a step in any state of a flow that uses the behaviour: the behaviour decides which states it speaks for. */
  briefing?(b: BriefingInput): Promise<string[]>;
  /** Checked by done before an issue leaves a state with the behaviour, before anything changes; a refusal stops done. */
  leave?(o: OutcomeInput): Promise<Refusal | null>;
  /** Run by done for an outcome into a state with the behaviour, before it is applied: may change what is applied. */
  enter?(o: OutcomeInput, applied: Applied): Promise<Applied>;
  /** Run once done applied an outcome into or out of a state with the behaviour; best effort, see bestEffort. */
  followUps?(o: OutcomeInput, applied: Applied): Promise<Event[]>;
}

/** Whether the state of the flow opts into the behaviour. */
export function uses(flow: Flow, state: string | null, name: BehaviourName): boolean {
  return state !== null && Object.hasOwn(flow.states[state]?.behaviours ?? {}, name);
}

/** Whether any state of the flow opts into the behaviour. */
export function usedIn(flow: Flow, name: BehaviourName): boolean {
  return Object.keys(flow.states).some((s) => uses(flow, s, name));
}

/** The flow's name as a word that starts a sentence, e.g. Slice. */
const named = (flowName: string) => flowName.charAt(0).toUpperCase() + flowName.slice(1);

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

/** Why a person QAs an issue at the gate `state` of the flow `name`: its mode, for a gate that runs in one mode only, else its type. */
export function gateOf(flow: Flow, state: string, name: string): string {
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
   * are released, and the parent story moves on once every slice is merged.
   */
  async followUps({ ctx, issue, flow, outcome }) {
    if (outcome.to !== "closed") return [];
    const parent = await ctx.github.parentOf(issue.number);
    if (!parent) return [];
    const events: Event[] = [];
    const loc = await locate(issue, ctx, flow);
    if (loc && (await ctx.workspace.worktreeExists(loc.worktree))) events.push({ kind: "worktree-left-for-tidy", worktree: loc.worktree });
    events.push(...(await bestEffort("unblock-slices", parent, parent, () => releaseBlocked(ctx, parent))));
    events.push(...(await bestEffort("move-story-on", parent, parent, () => promoteStory(ctx, parent))));
    return events;
  },
};

const syncsBlocked: Behaviour = {
  params: (p) => (typeof p.to === "string" ? [] : [{ param: "to", expected: "a state of the flow" }]),
  leadsTo: (p) => (typeof p.to === "string" ? [{ param: "to", to: p.to }] : []),
  holds: true,
};

/** Every behaviour norn knows, by name, in the order their briefing lines appear. A name outside it fails validation, e.g. one from a newer norn. */
export const BEHAVIOURS = {
  countsFixRounds,
  opensPR,
  humanGate,
  mergesSlice,
  syncsBlocked,
} satisfies Record<string, Behaviour>;

export type BehaviourName = keyof typeof BEHAVIOURS;

const REGISTRY: Record<BehaviourName, Behaviour> = BEHAVIOURS;

/** The behaviours a flow uses anywhere, in registry order. */
function inFlow(flow: Flow): Behaviour[] {
  return (Object.entries(REGISTRY) as [BehaviourName, Behaviour][]).filter(([name]) => usedIn(flow, name)).map(([, b]) => b);
}

/** The briefing lines every behaviour of the flow contributes to the step. */
export async function behaviourLines(b: BriefingInput): Promise<string[]> {
  const lines: string[] = [];
  for (const behaviour of inFlow(b.flow)) if (behaviour.briefing) lines.push(...(await behaviour.briefing(b)));
  return lines;
}

/** The behaviours of one state of the flow, in registry order. */
function inState(flow: Flow, state: string | null): Behaviour[] {
  return (Object.entries(REGISTRY) as [BehaviourName, Behaviour][]).filter(([name]) => uses(flow, state, name)).map(([, b]) => b);
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
  return (Object.entries(REGISTRY) as [BehaviourName, Behaviour][]).some(([name, b]) => b.holds && uses(flow, state, name));
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
    const loaded = await flowOf(ctx, issue);
    const flow = loaded?.ok ? loaded.flow : null;
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
