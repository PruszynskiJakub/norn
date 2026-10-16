import type { Flow } from "./flow.js";
import type { Issue } from "./github.js";
import { locate, workIn, type Location, type WorkIn } from "./location.js";
import { FIX_STATES, kindOf, type State, type Step } from "./machine.js";
import { sh, specPath } from "./text.js";
import { fixRounds, type Ctx } from "./transitions.js";

export function noun(issue: Issue): "issue" | "story" | "slice" {
  const kind = kindOf(issue);
  return kind === "new" ? "issue" : kind;
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
  noun: "issue" | "story" | "slice";
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
 * `flow` is the issue's repository flow, when it runs one.
 */
export async function briefing(issue: Issue, step: Step, ctx: Ctx, from: string | null, flow: Flow | null = null): Promise<Briefing> {
  const n = issue.number;
  const loc = await locate(issue, ctx, flow);
  // take relabels a slice in rework to implementation; `from` and the history say whether this is rework.
  const rework =
    !flow && step.skill === "norn-implement" && ((from !== null && FIX_STATES.includes(from as State)) || fixRounds(await ctx.github.listComments(n)) > 0);
  return {
    issue: n,
    noun: noun(issue),
    title: issue.title,
    step: { name: step.name, skill: step.skill, attended: step.attended },
    workIn: loc ? await workIn(loc, ctx.workspace, ctx.github, ctx.config.provider) : null,
    instructions: flow ? flowLines(issue, step, loc) : processLines(issue, step, loc, rework),
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

/**
 * Everything about the process around the skill: what to read, where its work
 * goes, and the commands for it. The skills themselves know none of this.
 */
function processLines(issue: Issue, step: Step, loc: Location | null, isRework: boolean): string[] {
  const n = issue.number;
  const readIssue = `Read the issue: gh issue view ${n} --comments`;
  if (step.skill === "norn-triage") {
    return [readIssue, `Unless you reject it, post what triage established on the issue first: gh issue comment ${n}`];
  }
  if (!loc) return [];
  const story = loc.story;
  const spec = specPath(story.number, loc.slug);
  const pushSpec = `Commit the spec on ${loc.branch} and push it, so the link norn posts resolves.`;
  const rework = isRework ? [`This is rework: the latest review or QA comment on #${n} lists what to fix. ${readIssue}`] : [];
  if (step.skill === "norn-resolve") {
    const lines = [`The latest needs-human comment gives the reason. ${readIssue}`, `Record the outcome on the issue: gh issue comment ${n}`];
    if (kindOf(issue) === "story") lines.push(`Spec changes go in ${spec}; commit and push them on ${loc.branch}.`);
    return lines;
  }
  if (kindOf(issue) === "story") {
    const lines = [`Spec to work on: ${spec}`];
    if (step.skill === "norn-refine" || step.skill === "norn-clarify") lines.push(readIssue, pushSpec);
    if (step.skill === "norn-plan") lines.push(pushSpec);
    if (step.skill === "norn-slice") {
      lines.push(
        "Create the slices in dependency order, blockers first, one command per slice:",
        `  norn add-slice ${n} "title" --mode afk|hil [--blocked-by <slice>]...`,
        "  --mode afk when an agent can verify every criterion, hil when a person must also look at it.",
        "Then give each slice its body: gh issue edit <slice> --body-file <file>",
        `Push ${loc.branch} once the slices exist, so slice PRs can target it.`,
      );
    }
    if (step.skill === "norn-implement") lines.push(...rework, `Commit the fixes straight onto the story branch ${loc.branch} and push them.`);
    if (step.skill === "norn-review" || step.skill === "norn-auto-qa" || step.skill === "norn-qa") {
      lines.push(`Story PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`);
    }
    lines.push(...qaLines(issue, step, loc, readIssue));
    return lines;
  }
  const lines = [`Spec: ${spec} (story #${story.number})`, readIssue];
  if (step.skill === "norn-implement") {
    lines.push(
      ...rework,
      `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
      // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
      `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue.title)} --body ${sh(`Part of #${story.number}. Slice #${n}.`)}`,
    );
  } else if (step.skill === "norn-merge") {
    lines.push(
      `Merge origin/${loc.base} into ${loc.branch}, resolving conflicts if needed, and push.`,
      `Then merge the PR: gh pr merge ${sh(loc.branch)} --merge`,
    );
  } else {
    lines.push(`Slice PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`, ...qaLines(issue, step, loc, readIssue));
  }
  return lines;
}

/** The process around a step of a repository flow: the issue, and with its own workspace, the branch and its PR into the base branch. */
function flowLines(issue: Issue, step: Step, loc: Location | null): string[] {
  const n = issue.number;
  const readIssue = `Read the issue: gh issue view ${n} --comments`;
  const resolve = [`The latest needs-human comment gives the reason. ${readIssue}`, `Record the outcome on the issue: gh issue comment ${n}`];
  if (step.skill === "norn-resolve") return resolve;
  if (!loc) return [readIssue];
  return [
    readIssue,
    `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
    // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
    `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue.title)} --body ${sh(`Closes #${n}.`)}`,
    `Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`,
  ];
}

/** How QA's results reach the issue: the note, evidence files, and for a person, remarks. */
function qaLines(issue: Issue, step: Step, loc: Location, readIssue: string): string[] {
  const n = issue.number;
  const files =
    "Keep screenshots, logs and command output in a directory outside the repository and finish with --evidence <dir>: norn pushes the files and embeds them in the comment. Do not commit them.";
  if (step.skill === "norn-auto-qa") {
    const lines = ["Your note is the evidence pack: one line per criterion with what you ran, what you saw and its evidence.", files];
    if (kindOf(issue) === "slice" && issue.labels.includes("mode:afk")) {
      lines.push(`No person checks this slice after you. A criterion you cannot check is never passed: run norn escalate ${n} "reason".`);
    } else {
      lines.push(
        "A person QAs this after you. For what only a person can check (the slice's verifier reason), list it in the note",
        "with what you could prepare: how to run it, a URL, screenshots up to where you had to stop. Then pass.",
      );
    }
    return lines;
  }
  if (step.skill === "norn-qa") {
    return [
      `Start from the agent's QA comment on #${n}: its evidence, and what it left for a person. ${readIssue}`,
      `Run the app from ${loc.branch} on this machine and walk the user through what is left, plus anything in the evidence they question.`,
      "Tie each remark the user brings to a criterion; a remark on a criterion fails it. For a remark outside the criteria, the user decides:",
      `  follow up (the default): gh issue create --title "<remark>" --body "From QA of #${n}: <remark>" (it goes through triage)`,
      "  pull it in: it fails this item, like a criterion",
      "  drop it: say so in the note",
      `Every failure needs a repro. ${files}`,
    ];
  }
  return [];
}
