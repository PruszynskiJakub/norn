import type { GitHub, Issue } from "./github.js";
import { kindOf, type Step } from "./machine.js";
import { sliceBranch, specPath, storyBranch, wrap } from "./text.js";

export function noun(issue: Issue) {
  const kind = kindOf(issue);
  return kind === "new" ? "issue" : kind;
}

/** Briefing in fixed order: where you are, what to do, how to finish, what not to do. */
export async function briefing(issue: Issue, step: Step, github: GitHub): Promise<string[]> {
  const n = issue.number;
  let where = `You now hold ${noun(issue)} #${n} "${issue.title}". Its step is ${step.name}.`;
  if (step.attended) where += " This step is attended: the user takes part, and you do not decide on your own.";
  const many = Object.keys(step.outcomes).length > 1;
  const when = step.attended ? `When the user agrees ${step.name} is finished` : `When ${step.name} is finished`;
  return [
    wrap(where),
    "",
    `Invoke the skill: ${step.skill}`,
    ...(await workContext(issue, step, github)),
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

/** Where the work happens: spec, branches, PRs. */
async function workContext(issue: Issue, step: Step, github: GitHub): Promise<string[]> {
  const n = issue.number;
  if (kindOf(issue) === "story") {
    const lines = [`Spec to work on: ${specPath(n, issue.title)}`];
    const branch = storyBranch(n, issue.title);
    if (step.skill === "tdd") lines.push(`Commit the fixes straight onto the story branch ${branch}.`);
    if (step.skill === "review" || step.skill === "qa") lines.push(`Story PR: ${branch} into main.`);
    return lines;
  }
  if (kindOf(issue) === "slice") {
    const parentNumber = await github.parentOf(n);
    if (!parentNumber) return [];
    const parent = await github.getIssue(parentNumber);
    const story = storyBranch(parent.number, parent.title);
    const slice = sliceBranch(n, issue.title);
    const lines = [`Spec: ${specPath(parent.number, parent.title)} (story #${parent.number})`];
    if (step.skill === "tdd") {
      lines.push(`Work on branch ${slice}, made from ${story}.`, `Open one PR from ${slice} into ${story}.`);
    } else if (step.skill === "merge") {
      lines.push(`Merge the PR from ${slice} into ${story}, resolving conflicts if needed.`);
    } else {
      lines.push(`Slice PR: ${slice} into ${story}.`);
    }
    return lines;
  }
  return [];
}
