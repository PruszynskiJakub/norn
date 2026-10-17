import { behaviourLines, EVIDENCE_FILES, inFlowOf, readIssue as readIssueLine } from "./behaviours.js";
import { flowNameOf, flowStatesOf, gateAhead, hasSpec, type NamedFlow, uses } from "./flow.js";
import type { Issue } from "./github.js";
import { locate, workIn, type Location, type WorkIn } from "./location.js";
import type { Step } from "./machine.js";
import { specPath } from "./text.js";
import type { Ctx } from "./transitions.js";

/** What an issue is called: its type, the name of the flow it runs, e.g. story or bug; an issue before triage gives it one. */
export function noun(issue: Issue): string {
  return flowNameOf(issue) ?? "issue";
}

/** One way to finish a step: `norn done <issue> <word> ["<note>"] [--evidence <dir>]`. */
export interface FinishCommand {
  issue: number;
  /** The outcome word; "" when the step ends only one way. */
  word: string;
  /** What the note names, e.g. "reason", when the outcome needs one. */
  note?: string;
  /** The step can attach evidence files. */
  evidence: boolean;
  /** What the outcome means, e.g. "a story: moves to refinement". */
  means: string;
}

/** Everything a session needs to do an issue's step. */
export interface Briefing {
  issue: number;
  /** What the issue is called, see noun. */
  noun: string;
  title: string;
  step: { name: string; skill: string; attended: boolean };
  /** Where to work; null when the issue has no branch of its own yet, e.g. in triage. */
  workIn: WorkIn | null;
  /** The process around the skill: what to read, where the work goes, the commands for it. Content, not formatting. */
  instructions: string[];
  finish: FinishCommand[];
}

/**
 * `from` is the state the issue was in before take moved it, e.g. changes-requested.
 * `flow` is the issue's flow, when it runs one.
 */
export async function briefing(issue: Issue, step: Step, ctx: Ctx, from: string | null, named: NamedFlow | null): Promise<Briefing> {
  const n = issue.number;
  const flow = named?.flow ?? null;
  const loc = await locate(issue, ctx, flow);
  return {
    issue: n,
    noun: noun(issue),
    title: issue.title,
    step: { name: step.name, skill: step.skill, attended: step.attended },
    workIn: loc ? await workIn(loc, ctx.workspace, ctx.github, ctx.config.provider) : null,
    instructions: named ? await flowLines(issue, step, ctx, from, named, loc) : triageLines(n),
    finish: finishCommands(n, step),
  };
}

export function finishCommands(n: number, step: Step): FinishCommand[] {
  return Object.entries(step.outcomes).map(([word, o]) => ({
    issue: n,
    word,
    ...(o.note ? { note: o.note } : {}),
    evidence: step.evidence ?? false,
    means: o.means,
  }));
}

/** Triage, before the issue has a flow: read it, and record what triage found before choosing its type. */
function triageLines(n: number): string[] {
  return [readIssueLine(n), `Unless you reject it, post what triage established on the issue first: gh issue comment ${n}`];
}

/**
 * Everything about the process around the skill, for a step of a flow: the
 * spec or the issue, then what the behaviours of its flow add, then how QA
 * evidence reaches it. The skills themselves know none of this.
 */
async function flowLines(issue: Issue, step: Step, ctx: Ctx, from: string | null, named: NamedFlow, loc: Location | null): Promise<string[]> {
  const n = issue.number;
  const { flow } = named;
  const readIssue = readIssueLine(n);
  // Without the branch its workspace names, e.g. a parent, norn has nothing to say about the work.
  if (flow.workspace !== "none" && !loc) return [];
  // An issue with a spec of its own works from the spec; the states that write it say when to read the issue.
  const ownSpec = loc && hasSpec(flow) ? specPath(n, loc.slug) : null;
  if (step.skill === "norn-resolve") {
    const lines = [`The latest needs-human comment gives the reason. ${readIssue}`, `Record the outcome on the issue: gh issue comment ${n}`];
    if (loc && ownSpec) lines.push(`Spec changes go in ${ownSpec}; commit and push them on ${loc.branch}.`);
    return lines;
  }
  const state = flowStatesOf(issue, flow)[0] ?? null;
  // Work in the parent's branch follows the parent's spec.
  const spec = loc && flow.workspace === "parent" ? [`Spec: ${specPath(loc.story.number, loc.slug)} (${noun(loc.story)} #${loc.story.number})`] : [];
  const lines = [...spec, ...(ownSpec ? [] : [readIssue]), ...(await behaviourLines({ ...inFlowOf(ctx, issue, named), state, from, step, loc }))];
  // An agent's step with evidence is QA: its note is the evidence pack.
  if (state !== null && flow.states[state].evidence && !uses(flow, state, "humanGate"))
    lines.push(...agentQaLines(n, noun(issue), gateAhead(flow, issue, state)));
  return lines;
}

/** How an agent's QA reaches issue n: the note is the evidence pack; what is left goes to the person after, or escalates without one. */
function agentQaLines(n: number, noun: string, personAfter: boolean): string[] {
  return [
    "Your note is the evidence pack: one line per criterion with what you ran, what you saw and its evidence.",
    EVIDENCE_FILES,
    ...(personAfter
      ? [
          "A person QAs this after you. For what only a person can check (the slice's verifier reason), list it in the note",
          "with what you could prepare: how to run it, a URL, screenshots up to where you had to stop. Then pass.",
        ]
      : [`No person checks this ${noun} after you. A criterion you cannot check is never passed: run norn escalate ${n} "reason".`]),
  ];
}
