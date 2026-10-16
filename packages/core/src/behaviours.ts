import type { BehaviourName, Flow } from "./flow.js";
import type { Issue } from "./github.js";
import type { Location } from "./location.js";
import type { Step } from "./machine.js";
import { sh } from "./text.js";
import type { Ctx } from "./transitions.js";

/**
 * Behaviours are norn's built-in mechanics that a state of a flow opts into by
 * name. Each one contributes what it needs to the commands: its lines to the
 * briefing, its say on an outcome done applies, its checks before an issue
 * leaves the state, and its automatic follow-ups. The set is closed; a flow
 * only names them.
 */

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

export interface Behaviour {
  /** Briefing lines, for a step in any state of a flow that uses the behaviour: the behaviour decides which states it speaks for. */
  briefing?(b: BriefingInput): Promise<string[]>;
}

/** Whether the state of the flow opts into the behaviour. */
export function uses(flow: Flow, state: string | null, name: BehaviourName): boolean {
  return state !== null && (flow.states[state]?.behaviours ?? []).includes(name);
}

/** Whether any state of the flow opts into the behaviour. */
export function usedIn(flow: Flow, name: BehaviourName): boolean {
  return Object.keys(flow.states).some((s) => uses(flow, s, name));
}

const opensPR: Behaviour = {
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

/** Every behaviour norn knows, in the order their briefing lines appear. */
const REGISTRY: Record<BehaviourName, Behaviour> = {
  opensPR,
  countsFixRounds: {},
  humanGate: {},
};

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
