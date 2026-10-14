import type { Issue } from "./github.js";
import { locate, workInLines, type Location } from "./location.js";
import { kindOf, type Step } from "./machine.js";
import { specPath, wrap } from "./text.js";
import type { Ctx } from "./transitions.js";

export function noun(issue: Issue) {
  const kind = kindOf(issue);
  return kind === "new" ? "issue" : kind;
}

/** Briefing in fixed order: where you are, what to do, how to finish, what not to do. */
export async function briefing(issue: Issue, step: Step, ctx: Ctx): Promise<string[]> {
  const n = issue.number;
  let where = `You now hold ${noun(issue)} #${n} "${issue.title}". Its step is ${step.name}.`;
  if (step.attended) where += " This step is attended: the user takes part, and you do not decide on your own.";
  const many = Object.keys(step.outcomes).length > 1;
  const when = step.attended ? `When the user agrees ${step.name} is finished` : `When ${step.name} is finished`;
  const loc = await locate(issue, ctx.github, ctx.config.baseBranch);
  const workIn = loc ? [...(await workInLines(loc, ctx.workspace, ctx.config.provider)), ""] : [];
  return [
    wrap(where),
    "",
    ...workIn,
    `Invoke the skill: ${step.skill}`,
    ...(loc ? workContext(issue, step, loc) : []),
    "",
    `${when}, run${many ? " one of" : ""}:`,
    ...finishCommands(n, step),
    "",
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

/** Spec and PR lines for the step. */
function workContext(issue: Issue, step: Step, loc: Location): string[] {
  const story = loc.story;
  if (kindOf(issue) === "story") {
    const lines = [`Spec to work on: ${specPath(story.number, story.title)}`];
    if (step.skill === "tdd") lines.push(`Commit the fixes straight onto the story branch ${loc.branch}.`);
    if (step.skill === "review" || step.skill === "qa") lines.push(`Story PR: ${loc.branch} into ${loc.base}.`);
    return lines;
  }
  const lines = [`Spec: ${specPath(story.number, story.title)} (story #${story.number})`];
  if (step.skill === "tdd") lines.push(`Open one PR from ${loc.branch} into ${loc.base}.`);
  else if (step.skill === "merge") lines.push(`Merge the PR from ${loc.branch} into ${loc.base}, resolving conflicts if needed.`);
  else lines.push(`Slice PR: ${loc.branch} into ${loc.base}.`);
  return lines;
}
