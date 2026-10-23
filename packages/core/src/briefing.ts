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
  /** How long a claim lasts after the last take before another session can take it over, see claims.staleAfter. */
  staleAfterMs: number;
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
    staleAfterMs: ctx.config.staleAfterMs,
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
  return [readIssueLine(n), `Unless you reject it, post what triage established on the issue before norn done: gh issue comment ${n} --body-file <file>`];
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
  // Without the branch its workspace names, norn has nothing to say about the work; a parent missing is a person's to fix.
  if (flow.workspace !== "none" && !loc)
    return flow.workspace === "parent"
      ? [
          `#${n} is not a sub-issue of another issue, so it has no parent branch, spec or PR to work on. Do not start, and do not finish with norn done: run norn escalate ${n} "<reason>"`,
        ]
      : [];
  // An issue with a spec of its own works from the spec; the states that write it say when to read the issue.
  const ownSpec = loc && hasSpec(flow) ? specPath(n, loc.slug) : null;
  if (step.skill === "norn-resolve") {
    const lines = [
      `The latest needs-human comment gives the reason. ${readIssue}`,
      `Record the outcome on the issue: gh issue comment ${n} --body-file <file>`,
    ];
    if (loc && ownSpec) lines.push(`Spec changes go in ${ownSpec}; commit and push them on ${loc.branch}.`);
    // A slice follows its parent's spec, which lives on the parent's branch, not the slice's.
    else if (loc && flow.workspace === "parent")
      lines.push(`Spec: ${specPath(loc.story.number, loc.slug)} (${noun(loc.story)} #${loc.story.number}). Spec changes go on ${loc.base}, not ${loc.branch}.`);
    return lines;
  }
  const state = flowStatesOf(issue, flow)[0] ?? null;
  // Work in the parent's branch follows the parent's spec.
  const spec = loc && flow.workspace === "parent" ? [`Spec: ${specPath(loc.story.number, loc.slug)} (${noun(loc.story)} #${loc.story.number})`] : [];
  const behaviours = await behaviourLines({ ...inFlowOf(ctx, issue, named), state, from, step, loc });
  // A behaviour may say when to read the issue, e.g. for rework; then once is enough.
  const read = ownSpec || behaviours.some((l) => l.includes(readIssue)) ? [] : [readIssue];
  const lines = [...spec, ...read, ...behaviours];
  // An agent's step with evidence is QA: its note is the evidence pack.
  if (state !== null && flow.states[state].evidence && !uses(flow, state, "humanGate"))
    lines.push(...agentQaLines(n, noun(issue), gateAhead(flow, issue, state), flow.workspace === "parent"));
  return lines;
}

/**
 * How an agent's QA reaches issue n: the note is the evidence pack; what is left goes to the person after, or escalates
 * without one. A slice's verifier says why a person must look at it.
 */
function agentQaLines(n: number, noun: string, personAfter: boolean, slice: boolean): string[] {
  return [
    "Your note is the evidence pack: one line per criterion with what you ran, what you saw and its evidence.",
    EVIDENCE_FILES,
    ...(personAfter
      ? [
          `A person QAs this after you. List in the note what only a person can check${slice ? " (the slice's verifier reason)" : ""},`,
          "with what you could prepare: how to run it, a URL, screenshots up to where you had to stop.",
          "Those items do not fail the step on their own: pass when everything you could check passed, fail when anything did not.",
        ]
      : [`No person checks this ${noun} after you. A criterion you cannot check is never passed: run norn escalate ${n} "<reason>".`]),
  ];
}
