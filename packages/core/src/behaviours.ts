import type { Flow } from "./flow.js";
import type { Issue } from "./github.js";
import type { Location } from "./location.js";
import type { Event } from "./events.js";
import type { Outcome, Step } from "./machine.js";
import type { Refusal } from "./refusals.js";
import { sh } from "./text.js";
import { type Ctx, fixLimitReason, fixRounds, oneLine } from "./transitions.js";

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

const opensPR: Behaviour = {
  /** The PR comes from the issue's own branch. */
  requires: (flow) => (flow.workspace === "own" ? null : { field: "workspace", expected: '"own", for its PR' }),
  /** In its state, how to open or update the PR; in the others, once it exists, the PR and its diff. */
  async briefing({ ctx, issue, flow, state, loc }) {
    if (!loc) return [];
    const diff = `Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`;
    if (uses(flow, state, "opensPR")) {
      return [
        `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
        // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
        `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue.title)} --body ${sh(`Closes #${issue.number}.`)}`,
        diff,
      ];
    }
    const pr = await ctx.github.findPullRequest(loc.branch);
    return pr ? [`PR #${pr.number}: ${loc.branch} into ${pr.base}. ${diff}`] : [];
  },
};

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

const humanGate: Behaviour = {
  /** At the gate, how a person QAs with the user and how remarks and evidence reach the issue. */
  async briefing({ issue, flow, state, loc }) {
    if (!uses(flow, state, "humanGate")) return [];
    return [
      `Start from the latest comments on #${issue.number}: the evidence, and what was left for a person.`,
      ...humanQaLines(issue.number, loc?.branch ?? null),
    ];
  },
  /** Reaching the gate puts the issue in a person's hands: they are notified, and the agent stops. */
  async enter({ flowName, from, outcome }, applied) {
    // Staying at the gate, e.g. needs-human resolved there, is no new hand-over.
    return from === outcome.to || applied.outcome.notify ? applied : { ...applied, outcome: { ...applied.outcome, notify: `type:${flowName}` } };
  },
};

/** The states of the flow that count fix rounds. */
function fixStatesOf(flow: Flow): string[] {
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
    return rework ? [`This is rework: the latest comment that sent #${issue.number} back lists what to fix.`] : [];
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

/** Every behaviour norn knows, by name, in the order their briefing lines appear. A name outside it fails validation, e.g. one from a newer norn. */
export const BEHAVIOURS = {
  countsFixRounds,
  opensPR,
  humanGate,
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
