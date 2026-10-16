import { parseArgs } from "./args.js";
import { briefing, finishCommands } from "./briefing.js";
import { acquire } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { FIX_STATES, ambiguousStates, kindOf, slicesOf, stateOf, stepFor, type State } from "./machine.js";
import { computeNext, notAStory, notifyWaiting, renderNext } from "./next.js";
import { init } from "./init.js";
import { locate } from "./location.js";
import { notifyNeedsHuman } from "./notify.js";
import { loadConfig, providerRefusal, type Config } from "./config.js";
import { status } from "./status.js";
import { qaBranch, renderTidy, tidy } from "./tidy.js";
import { storySlug, type Slugs } from "./slug.js";
import { hhmm, sh, specPath } from "./text.js";
import {
  applyOutcome,
  ensureStoryBranch,
  fixLimitReason,
  fixRounds,
  followUps,
  needsHumanLine,
  oneLine,
  sliceMergeRefusal,
  stateLabels,
  type Ctx,
  type Evidence,
} from "./transitions.js";

export type Deps = Omit<Ctx, "config" | "slugs"> & {
  cwd: string;
  /** Installs the psdd skills into <cwd>/skills/. */
  installSkills: (cwd: string) => Promise<string[]>;
};

/** Deps plus the loaded configuration, as every command after loading sees them. */
type Env = Deps & Ctx;

export interface Result {
  stdout: string;
  exitCode: number;
  /** Facts behind the prose, printed instead of it with --json. */
  data?: Record<string, unknown>;
  /** Configuration problems psdd worked around; printed once, before the answer. */
  warnings?: string[];
}

const ok = (lines: string[], data?: Record<string, unknown>): Result => ({ exitCode: 0, stdout: lines.join("\n"), data });
const refuse = (lines: string[]): Result => ({ exitCode: 1, stdout: lines.join("\n") });

export async function run(argv: string[], deps: Deps): Promise<Result> {
  const { bools } = parseArgs(argv);
  const res = await dispatch(argv, deps);
  const warnings = res.warnings ?? [];
  if (!bools.has("json")) {
    const head = warnings.length ? ["psdd warning:", ...warnings.map((w) => `  ${w}`), ""] : [];
    return { exitCode: res.exitCode, stdout: [...head, res.stdout].join("\n") };
  }
  const body = res.exitCode === 0 ? { ok: true, ...res.data, message: res.stdout } : { ok: false, refusal: res.stdout };
  return { exitCode: res.exitCode, stdout: JSON.stringify(warnings.length ? { ...body, warnings } : body, null, 2) };
}

export const USAGE = [
  "psdd runs work through the SDD process. Commands on an issue take its number explicitly.",
  "",
  "  psdd init                          Set up this project: skills, .agents/specs/, labels",
  "  psdd next <story>                  What can be done on the story now",
  "  psdd take <issue> [--takeover]     Claim the issue and get the briefing for its step;",
  "                                     --takeover takes it from a stopped session of yours",
  '  psdd done <issue> [outcome] ["note"] [--evidence <dir>]',
  "                                     Finish the step; psdd makes the transition.",
  "                                     --evidence attaches the QA files in <dir>",
  '  psdd add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  '  psdd escalate <issue> "reason"     Set needs-human and release the claim',
  "  psdd release <issue>               Give up the claim without a transition",
  "  psdd status <story>                Read-only overview of the story and its slices",
  "  psdd tidy [--dry-run]              Remove what belongs to closed issues",
  "",
  "Add --json for machine-readable output.",
].join("\n");

const NEEDS_NUMBER: Record<string, string> = {
  next: "psdd next <story>",
  take: "psdd take <issue>",
  done: 'psdd done <issue> [outcome] ["note"] [--evidence <dir>]',
  "add-slice": 'psdd add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  escalate: 'psdd escalate <issue> "reason"',
  release: "psdd release <issue>",
  status: "psdd status <story>",
};

/**
 * What to print when a gh call fails partway through a command. Earlier calls
 * may already have changed GitHub, so it never claims nothing was done.
 */
export function ghFailureMessage(argv: string[], error: string): string {
  const { positionals } = parseArgs(argv);
  const [cmd, n] = positionals;
  const lines = ["GitHub refused a call. Some changes from this command may already be applied.", error];
  if (cmd && n && /^\d+$/.test(n)) {
    lines.push(
      `See where things stand with: psdd status ${n} (for a slice, psdd status <its story> shows the whole story)`,
      `Check gh auth status and that you are inside the repository, then retry: psdd ${argv.map(sh).join(" ")}`,
    );
  } else {
    lines.push("Check gh auth status and that you are inside the repository, then retry the command.");
  }
  return lines.join("\n");
}

/** Commands that name or touch worktrees, and so need the provider to match the environment. */
const USES_WORKTREES = new Set(["take", "next", "done", "tidy"]);

/** Commands that take no issue number. */
const NO_NUMBER = new Set(["init", "tidy"]);

async function dispatch(argv: string[], input: Deps): Promise<Result> {
  const { positionals, flags, bools } = parseArgs(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || !(cmd in NEEDS_NUMBER || NO_NUMBER.has(cmd))) return { exitCode: 2, stdout: USAGE };
  if (cmd in NEEDS_NUMBER && !/^\d+$/.test(rest[0] ?? "")) {
    return { exitCode: 2, stdout: `Give the issue number explicitly:\n  ${NEEDS_NUMBER[cmd]}` };
  }
  if (cmd === "init") {
    const r = await init(input);
    return r.ok ? ok(r.lines) : refuse(r.lines);
  }
  const loaded = await loadConfig(input.workspace);
  if (!loaded.ok) return refuse(loaded.lines);
  return { ...(await withConfig(cmd, rest, flags, bools, input, loaded.config)), warnings: loaded.warnings };
}

async function withConfig(cmd: string, rest: string[], flags: Record<string, string[]>, bools: Set<string>, input: Deps, config: Config): Promise<Result> {
  const loaded = { config };
  const deps = { ...input, config: loaded.config, slugs: new Map() as Slugs };
  if (USES_WORKTREES.has(cmd)) {
    const r = providerRefusal(deps.config, deps.workspace.env);
    if (r) return refuse(r);
  }
  switch (cmd) {
    case "status": {
      const { lines, data } = await status(deps, Number(rest[0]), deps.now(), deps.config.staleAfterMs);
      return ok(lines, data);
    }
    case "take":
      return take(Number(rest[0]), bools.has("takeover"), deps);
    case "done":
      return done(Number(rest[0]), rest[1], rest[2], flags.evidence?.[0], deps);
    case "tidy": {
      const report = await tidy(deps, bools.has("dry-run"));
      return ok([renderTidy(report)], { ...report });
    }
    case "escalate":
      return escalate(Number(rest[0]), rest[1], deps);
    case "release":
      return release(Number(rest[0]), deps);
    case "next": {
      const n = Number(rest[0]);
      const r = await notAStory(deps.github, n);
      if (r) return refuse(r);
      const report = await computeNext(deps, n);
      if (report.nothingLeft && !report.closed) await notifyWaiting(deps, report);
      return ok([renderNext(report)], { ...report });
    }
    case "add-slice":
      return addSlice(Number(rest[0]), rest[1], flags["blocked-by"] ?? [], flags.mode?.[0], deps);
  }
  return { exitCode: 2, stdout: USAGE };
}

/** Why an issue has no step to take, as an instruction. */
async function noStepRefusal(issue: Issue, github: GitHub): Promise<string[]> {
  const n = issue.number;
  if (issue.state === "closed") return [`#${n} is closed. There is nothing to do on it.`];
  const state = stateOf(issue);
  const story = kindOf(issue) === "slice" ? await github.parentOf(n) : n;
  const pick = story ? `Run psdd next ${story} and pick a different item.` : "Pick a different item.";
  const ambiguous = ambiguousStates(issue);
  if (ambiguous) return [`#${n} ${ambiguous}.`, pick];
  if (kindOf(issue) === "story" && state === "implementation") {
    return [
      `Story #${n} is in implementation. Its label follows its slices; there is no step to take on the story itself.`,
      `Run psdd next ${n} to see its slices.`,
    ];
  }
  if (kindOf(issue) === "story" && state === "merge-queue") {
    const owner = issue.assignees[0] ? `@${issue.assignees[0]}` : "unassigned";
    return [
      `Story #${n} is in merge-queue. Only the story owner (${owner}) merges the story PR;`,
      `once it is merged, psdd next ${n} closes the story if GitHub has not. Do not merge it yourself.`,
    ];
  }
  if (state === "blocked") {
    const open = (await github.blockedBy(n)).filter((b) => b.state === "open");
    return [`#${n} is blocked by ${open.map((b) => `#${b.number}`).join(", ") || "other issues"}. Do not work on it yet.`, pick];
  }
  return [`#${n} (${state ?? "no state"}) has no step psdd can brief.`, pick];
}

async function take(n: number, takeover: boolean, deps: Env): Promise<Result> {
  const { github } = deps;
  const before = await github.getIssue(n);
  if (!stepFor(before) || before.state === "closed") return refuse(await noStepRefusal(before, github));

  const user = await github.currentUser();
  const record = { holder: user, session: deps.session, since: deps.now().toISOString() };
  const claim = await acquire(github, n, record, deps.now(), deps.config.staleAfterMs, { takeover });
  if (!claim.ok) {
    const what = `${kindOf(before) === "slice" ? "Slice " : ""}#${n}`;
    const since = claim.held ? hhmm(claim.held.since) : "unknown";
    if (claim.held?.holder === user) {
      return refuse([
        `${what} is held by another session of yours (since ${since}).`,
        `If that session has stopped, take it over here: psdd take ${n} --takeover`,
        "If it is still running, do not work on it.",
      ]);
    }
    if (takeover && claim.held) {
      return refuse([
        `${what} is held by @${claim.held.holder} (since ${since}). --takeover only takes over your own sessions.`,
        `Ask them to release it, or wait until the claim goes stale.`,
      ]);
    }
    const story = kindOf(before) === "slice" ? await github.parentOf(n) : null;
    return refuse([
      `${what} is already held by another session (since ${since}).`,
      `Do not work on it.${story ? ` Run psdd next ${story} and pick a different item.` : ""}`,
    ]);
  }
  // Re-read under the claim: labels may have moved between the first read and the claim.
  const issue = await github.getIssue(n);
  const step = stepFor(issue);
  if (!step) {
    await github.deleteClaim(n);
    return refuse(await noStepRefusal(issue, github));
  }
  const state = stateOf(issue);
  // The new state goes on before the old one comes off, so a failure in between never leaves the issue without a state.
  if (step.enterAs && step.enterAs !== state) {
    const old = stateLabels(issue, step.enterAs);
    await github.addLabels(n, [step.enterAs, "in-progress"]);
    await github.removeLabels(n, old);
    issue.labels = [...issue.labels.filter((l) => !(old as string[]).includes(l)), step.enterAs];
  } else {
    await github.addLabels(n, ["in-progress"]);
  }
  let staleNote: string | null = null;
  if (claim.tookOver) {
    // The holder may only be slow, and its worktree holds its commits: keep it, never remove it here.
    const loc = await locate(issue, deps);
    const kept = loc && (await deps.workspace.worktreeExists(loc.worktree));
    const was = claim.ownTakeover
      ? `You took #${n} over from another session of yours (since ${hhmm(claim.tookOver.since)})`
      : `The previous holder's claim was stale (since ${hhmm(claim.tookOver.since)})`;
    staleNote = `${was}${kept ? `; its worktree is kept with what it left. Check git status there before you start.` : "."}`;
  }
  const lines = await briefing(issue, step, deps, state);
  if (staleNote) lines.splice(lines.indexOf(""), 0, "", staleNote);
  if (claim.reacquired) lines.unshift(`You already held #${n}; the claim is refreshed. Here is its briefing again.`, "");
  return ok(lines, {
    issue: n,
    state: stateOf(issue),
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    outcomes: Object.keys(step.outcomes).filter(Boolean),
  });
}

/** Refuses unless this session holds the claim on n. */
async function checkHeld(n: number, deps: Env): Promise<Result | null> {
  const claim = await deps.github.readClaim(n);
  if (!claim) return refuse([`You do not hold #${n}. Claim it first with: psdd take ${n}`]);
  if (claim.session !== deps.session) {
    return refuse([`#${n} is held by another session (since ${hhmm(claim.since)}). Do not work on it or finish it.`]);
  }
  return null;
}

async function done(n: number, word: string | undefined, note: string | undefined, evidenceDir: string | undefined, deps: Env): Promise<Result> {
  const { github } = deps;
  const notHeld = await checkHeld(n, deps);
  if (notHeld) return notHeld;
  const issue = await github.getIssue(n);
  const step = stepFor(issue);
  if (!step) return refuse(await noStepRefusal(issue, github));
  const outcome = step.outcomes[word ?? ""];
  if (!outcome) {
    const head = word ? `"${word}" is not an outcome of ${step.name}.` : `${step.name} can end more than one way. Say which.`;
    return refuse([head, "Finish with one of:", ...finishCommands(n, step)]);
  }
  if (outcome.note && !note) {
    return refuse([`This outcome needs a ${outcome.note}. Run:`, `  psdd done ${n} ${word} "${outcome.note}"${step.evidence ? " [--evidence <dir>]" : ""}`]);
  }
  if (evidenceDir !== undefined && !step.evidence) {
    return refuse([`--evidence is for QA steps; ${step.name} takes none. Finish without it:`, ...finishCommands(n, step)]);
  }
  if (kindOf(issue) === "story" && stateOf(issue) === "needs-slicing" && (await slicesOf(github, n)).length === 0) {
    return refuse([
      `Story #${n} has no slices yet. Create them first, one per slice, with:`,
      `  psdd add-slice ${n} "title" --mode afk|hil [--blocked-by <issue>]`,
    ]);
  }
  if (step.skill === "merge") {
    const r = await sliceMergeRefusal(deps, issue);
    if (r) return refuse(r);
  }
  const preLines: string[] = [];
  if (kindOf(issue) === "story" && outcome.to === "implementation") {
    const branch = await ensureStoryBranch(deps, issue);
    if (!branch.ok) return refuse(branch.lines);
    if (branch.created) preLines.push(`Created the story branch ${branch.branch}.`);
  }

  let evidence: Evidence | undefined;
  if (evidenceDir !== undefined) {
    const files = await deps.workspace.readEvidence(evidenceDir);
    if (!files) return refuse([`${evidenceDir} is not a directory. Put the evidence files in a directory and pass its path to --evidence.`]);
    if (!files.length) return refuse([`${evidenceDir} is empty. Put the evidence files in it, or finish without --evidence.`]);
    const big = files.filter((f) => f.content.length > MAX_EVIDENCE_BYTES);
    if (big.length) {
      return refuse([
        `These files are over ${MAX_EVIDENCE_BYTES / 1024 / 1024} MB, too big to push as evidence: ${big.map((f) => f.path).join(", ")}.`,
        "Trim them, e.g. cut a log to the part that shows the result, and run the command again.",
      ]);
    }
    // Pushed before the transition, so the comment can embed the files at their commit.
    const branch = qaBranch(n);
    const sha = await github.pushFiles(branch, files, `QA evidence for #${n} (${step.name}, ${word})`);
    evidence = { branch, sha, files: files.map((f) => f.path) };
  }

  let applied = outcome;
  const limitLines: string[] = [];
  // A round starts when review or QA sends the issue back; resolving needs-human stays put and is no round.
  if (FIX_STATES.includes(outcome.to as State) && stateOf(issue) !== outcome.to) {
    const rounds = fixRounds(await github.listComments(n)) + 1;
    if (rounds > deps.config.maxFixRounds) {
      const max = deps.config.maxFixRounds;
      applied = { ...outcome, needsHuman: `${note ? `escalated: "${oneLine(note)}" ` : ""}${fixLimitReason(max)}` };
      limitLines.push(`#${n} has reached ${max} fix rounds, so it now needs a human instead of another round of implement.`);
    }
  }
  try {
    await applyOutcome(deps, issue, applied, word ?? "", note, evidence);
  } finally {
    await github.deleteClaim(n);
  }
  const extra = [...limitLines, ...preLines, ...(await followUps(deps, issue, applied))];
  if (kindOf(issue) === "story" && outcome.to === "implementation") {
    extra.push(`To run the story unattended until it needs a human, the user can start the deliver skill: deliver ${n}`);
  }
  const where = outcome.to === "closed" ? "closed" : outcome.to === "not-planned" ? "closed as not planned" : `in ${outcome.to}`;
  if (evidence)
    extra.unshift(
      `Pushed ${evidence.files.length} evidence file${evidence.files.length === 1 ? "" : "s"} to ${evidence.branch} and embedded them in the comment.`,
    );
  if (outcome.notify && !applied.needsHuman) extra.push(`A person does the next step, so do not take #${n} again. psdd has notified the user.`);
  return ok([`#${n} is now ${where}. The claim is released.`, ...extra], { issue: n, from: stateOf(issue), to: outcome.to, ...(evidence ? { evidence } : {}) });
}

/** GitHub's API takes blobs up to 100 MB; evidence is screenshots, logs and output, far smaller. */
const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;

async function escalate(n: number, reason: string | undefined, deps: Env): Promise<Result> {
  if (!reason) return refuse(["Say why a human is needed. Run:", `  psdd escalate ${n} "reason"`]);
  const notHeld = await checkHeld(n, deps);
  if (notHeld) return notHeld;
  const { github } = deps;
  await github.addLabels(n, ["needs-human"]);
  await github.removeLabels(n, ["in-progress"]);
  const why = `escalated: "${oneLine(reason)}"`;
  // The full reason keeps its line breaks in its own paragraph; the marker line stays single-line.
  await github.comment(n, [needsHumanLine(why), ...(reason.includes("\n") ? ["", reason] : [])].join("\n"));
  await notifyNeedsHuman(deps, n, why);
  await github.deleteClaim(n);
  return ok([`#${n} now needs a human. The claim is released.`, "Do not work on it further. A person picks it up with the resolve skill."]);
}

async function release(n: number, deps: Env): Promise<Result> {
  const notHeld = await checkHeld(n, deps);
  if (notHeld) return notHeld;
  await deps.github.removeLabels(n, ["in-progress"]);
  await deps.github.deleteClaim(n);
  return ok([`Released #${n}. Its state is unchanged. Do not work on it further.`]);
}

async function addSlice(story: number, title: string | undefined, blockedBy: string[], mode: string | undefined, deps: Env): Promise<Result> {
  const { github } = deps;
  const usage = `  psdd add-slice ${story} "title" --mode afk|hil [--blocked-by <issue>]...`;
  if (!title || (mode !== "afk" && mode !== "hil")) {
    return refuse(["add-slice needs a title and a mode. Run:", usage]);
  }
  const notHeld = await checkHeld(story, deps);
  if (notHeld) return notHeld;
  const parent = await github.getIssue(story);
  if (stateOf(parent) !== "needs-slicing") {
    return refuse([`Story #${story} is in ${stateOf(parent) ?? "no state"}, not needs-slicing. Slices are only added while slicing.`]);
  }
  const blockers = await Promise.all(blockedBy.map((b) => github.getIssue(Number(b))));
  const open = blockers.filter((b) => b.state === "open");
  const slice = await github.createIssue({
    title,
    body: `Slice of #${story}. Spec: ${specPath(story, await storySlug(deps, parent))}`,
    labels: ["type:slice", `mode:${mode}`, open.length ? "blocked" : "ready-for-agent"],
    assignees: parent.assignees,
  });
  await github.addSubIssue(story, slice.number);
  for (const b of blockers) await github.addBlockedBy(slice.number, b.number);
  const status = open.length ? `blocked by ${open.map((b) => `#${b.number}`).join(", ")}` : "ready-for-agent";
  return ok([`Created slice #${slice.number} "${title}" (mode:${mode}, ${status}).`]);
}
