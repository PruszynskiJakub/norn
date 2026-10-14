import type { Issue } from "./github.js";
import { locate, workInLines, type Location } from "./location.js";
import { FIX_STATES, kindOf, type State, type Step } from "./machine.js";
import { sh, specPath, wrap } from "./text.js";
import { fixRounds, type Ctx } from "./transitions.js";

export function noun(issue: Issue) {
  const kind = kindOf(issue);
  return kind === "new" ? "issue" : kind;
}

/**
 * Briefing in fixed order: where you are, what to do, how to finish, what not to do.
 * `from` is the state the issue was in before take moved it, e.g. changes-requested.
 */
export async function briefing(issue: Issue, step: Step, ctx: Ctx, from: State | null): Promise<string[]> {
  const n = issue.number;
  let where = `You now hold ${noun(issue)} #${n} "${issue.title}". Its step is ${step.name}.`;
  if (step.attended) where += " This step is attended: the user takes part, and you do not decide on your own.";
  const many = Object.keys(step.outcomes).length > 1;
  const when = step.attended ? `When the user agrees ${step.name} is finished` : `When ${step.name} is finished`;
  const loc = await locate(issue, ctx);
  const workIn = loc ? [...(await workInLines(loc, ctx.workspace, ctx.github, ctx.config.provider)), ""] : [];
  // take relabels a slice in rework to implementation; `from` and the history say whether this is rework.
  const rework =
    step.skill === "implement" &&
    ((from !== null && FIX_STATES.includes(from)) || fixRounds(await ctx.github.listComments(n)) > 0);
  return [
    wrap(where),
    "",
    ...workIn,
    `Invoke the skill: ${step.skill}`,
    ...processLines(issue, step, loc, rework),
    "",
    `${when}, run${many ? " one of" : ""}:`,
    ...finishCommands(n, step),
    "",
    `On a long step, run psdd take ${n} again now and then: it keeps your claim fresh.`,
    `If you have to stop, run: psdd release ${n}`,
    `If something is wrong and a person is needed, run: psdd escalate ${n} "reason"`,
    "",
    "Do not change labels yourself. Only psdd changes them.",
  ];
}

export function finishCommands(n: number, step: Step): string[] {
  const words = Object.keys(step.outcomes);
  if (words.length === 1 && words[0] === "") return [`  psdd done ${n}`];
  const cmds = words.map((w) => {
    const o = step.outcomes[w];
    return `psdd done ${n} ${w}${o.note ? ` "${o.note}"` : ""}`;
  });
  const width = Math.max(...cmds.map((c) => c.length)) + 3;
  return cmds.map((c, i) => `  ${c.padEnd(width)}(${step.outcomes[words[i]].means})`);
}

/**
 * Everything about the process around the skill: what to read, where its work
 * goes, and the commands for it. The skills themselves know none of this.
 */
function processLines(issue: Issue, step: Step, loc: Location | null, isRework: boolean): string[] {
  const n = issue.number;
  const readIssue = `Read the issue: gh issue view ${n} --comments`;
  if (step.skill === "triage") {
    return [readIssue, `On accept, post what triage established on the issue first: gh issue comment ${n}`];
  }
  if (!loc) return [];
  const story = loc.story;
  const spec = specPath(story.number, loc.slug);
  const pushSpec = `Commit the spec on ${loc.branch} and push it, so the link psdd posts resolves.`;
  const rework = isRework
    ? [`This is rework: the latest review or QA comment on #${n} lists what to fix. ${readIssue}`]
    : [];
  if (step.skill === "resolve") {
    const lines = [`The latest needs-human comment gives the reason. ${readIssue}`, `Record the outcome on the issue: gh issue comment ${n}`];
    if (kindOf(issue) === "story") lines.push(`Spec changes go in ${spec}; commit and push them on ${loc.branch}.`);
    return lines;
  }
  if (kindOf(issue) === "story") {
    const lines = [`Spec to work on: ${spec}`];
    if (step.skill === "refine" || step.skill === "clarify") lines.push(readIssue, pushSpec);
    if (step.skill === "plan") lines.push(pushSpec);
    if (step.skill === "slice") {
      lines.push(
        "Create the slices in dependency order, blockers first, one command per slice:",
        `  psdd add-slice ${n} "title" --mode afk|hil [--blocked-by <slice>]...`,
        "  --mode afk when tests verify the slice, hil when a person must look at it.",
        "Then give each slice its body: gh issue edit <slice> --body-file <file>",
        `Push ${loc.branch} once the slices exist, so slice PRs can target it.`,
      );
    }
    if (step.skill === "implement") lines.push(...rework, `Commit the fixes straight onto the story branch ${loc.branch} and push them.`);
    if (step.skill === "review" || step.skill === "qa") lines.push(`Story PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`);
    return lines;
  }
  const lines = [`Spec: ${spec} (story #${story.number})`, readIssue];
  if (step.skill === "implement") {
    lines.push(
      ...rework,
      `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
      // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
      `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue.title)} --body ${sh(`Part of #${story.number}. Slice #${n}.`)}`,
    );
  } else if (step.skill === "merge") {
    lines.push(
      `Merge origin/${loc.base} into ${loc.branch}, resolving conflicts if needed, and push.`,
      `Then merge the PR: gh pr merge ${sh(loc.branch)} --merge`,
    );
  } else {
    lines.push(`Slice PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`);
  }
  return lines;
}
