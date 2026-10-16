import { parseArgs } from "./args.js";
import {
  type AddSliceResult,
  type Briefing,
  type ConfigProblem,
  type ConfigWarning,
  type DoneResult,
  type EscalateResult,
  type Event,
  type FinishCommand,
  type FlowError,
  type FollowUpTask,
  FOR_HUMAN,
  type Holder,
  type Kept,
  LOCAL_CONFIG,
  type NextReport,
  type NextResult,
  type Notification,
  type Refusal,
  type ReleaseResult,
  type Removal,
  type Row,
  sh,
  type State,
  type StatusResult,
  type TakeResult,
  TEAM_CONFIG,
  type TidyResult,
  type WaitItem,
} from "@norn/core";
import type { DashboardRefusal, DashboardResult } from "./dashboard.js";
import { type CheckFact, type DoctorCheck, type DoctorResult, doctorFailed } from "./doctor.js";
import type { InitResult, InitWouldDowngrade, MissingSkills } from "./init.js";

/**
 * Every sentence norn prints. Each union is switched on exhaustively, so a
 * variant without wording fails the typecheck instead of printing nothing.
 */

/** What a command can answer with. */
export type Answer =
  | TakeResult
  | DoneResult
  | EscalateResult
  | ReleaseResult
  | AddSliceResult
  | NextResult
  | StatusResult
  | TidyResult
  | InitResult
  | DashboardResult
  | DoctorResult;

/** Refusals only the CLI makes: how it was called, and init's skill install. */
export type CliRefusal = { kind: "usage" } | { kind: "needs-number"; command: string } | MissingSkills | InitWouldDowngrade | DashboardRefusal;

export function unreachable(x: never): never {
  throw new Error(`no wording for ${JSON.stringify(x)}`);
}

/** Hard-wraps prose to the given width, keeping existing line breaks. */
export function wrap(text: string, width = 76) {
  return text
    .split("\n")
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(" ")) {
        if (cur && `${cur} ${word}`.length > width) {
          out.push(cur);
          cur = word;
        } else cur = cur ? `${cur} ${word}` : word;
      }
      out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}

/** An ISO timestamp as the time of day norn shows, e.g. 14:02. */
export function hhmm(iso: string) {
  return iso.slice(11, 16);
}

const issues = (ns: number[]) => ns.map((b) => `#${b}`).join(", ");

export const USAGE = [
  "norn runs work through the SDD process. Commands on an issue take its number explicitly.",
  "",
  "  norn init                          Set up this project: skills, .agents/specs/, labels",
  "  norn next <story>                  What can be done on the story now",
  "  norn take <issue> [--takeover]     Claim the issue and get the briefing for its step;",
  "                                     --takeover takes it from a stopped session of yours",
  '  norn done <issue> [outcome] ["note"] [--evidence <dir>]',
  "                                     Finish the step; norn makes the transition.",
  "                                     --evidence attaches the QA files in <dir>",
  '  norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  '  norn escalate <issue> "reason"     Set needs-human and release the claim',
  "  norn release <issue>               Give up the claim without a transition",
  "  norn status <story>                Read-only overview of the story and its slices",
  "  norn tidy [--dry-run]              Remove what belongs to closed issues",
  "  norn dashboard [--port <n>] [--interval <duration>] [--no-open]",
  "                                     Watch your work in the browser; Ctrl-C stops it",
  "  norn doctor                        Check the whole setup and say what to fix",
  "  norn --version                     Print the running norn's version",
  "",
  "Add --json for machine-readable output.",
].join("\n");

/** How to call each command that takes an issue number. */
export const NEEDS_NUMBER: Record<string, string> = {
  next: "norn next <story>",
  take: "norn take <issue>",
  done: 'norn done <issue> [outcome] ["note"] [--evidence <dir>]',
  "add-slice": 'norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  escalate: 'norn escalate <issue> "reason"',
  release: "norn release <issue>",
  status: "norn status <story>",
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
      `See where things stand with: norn status ${n} (for a slice, norn status <its story> shows the whole story)`,
      `Check gh auth status and that you are inside the repository, then retry: norn ${argv.map(sh).join(" ")}`,
    );
  } else {
    lines.push("Check gh auth status and that you are inside the repository, then retry the command.");
  }
  lines.push("Run norn doctor for a full check.");
  return lines.join("\n");
}

// Configuration

/** The command that installs norn at a version. */
export const upgradeNorn = (version: string) => `npm install -D github:PruszynskiJakub/norn#v${version}`;

function problem(p: ConfigProblem): string {
  switch (p.kind) {
    case "not-an-object":
      return `${p.file}: must be a JSON object`;
    case "invalid-json":
      return `${p.file}: not valid JSON (${p.detail})`;
    case "unknown-setting":
      return `${p.file}: unknown setting "${p.key}"`;
    case "bad-base-branch":
      return `${p.file}: baseBranch must be a branch name`;
    case "bad-provider":
      return `${p.file}: worktrees.provider must be one of ${p.allowed.join(", ")}`;
    case "bad-stale-after":
      return `${p.file}: claims.staleAfter must be a duration like 90m or 2h`;
    case "notifications-in-team-file":
      return `${p.file}: notifications is set per developer in ${p.local}`;
    case "bad-notifications":
      return `${p.file}: notifications must be one of ${p.allowed.join(", ")}`;
    case "bad-deliver-number":
      return `${p.file}: deliver.${p.key} must be a whole number above 0`;
    case "dashboard-in-team-file":
      return `${p.file}: dashboard is each developer's own; set it in ${p.local}`;
    case "bad-dashboard-setting":
      return p.key === "port" ? `${p.file}: dashboard.port must be a port number` : `${p.file}: dashboard.interval must be a duration like 30s or 2m`;
    case "norn-version-in-local-file":
      return `${p.file}: nornVersion is the team's; norn init sets it in ${p.team}`;
    case "bad-norn-version":
      return `${p.file}: nornVersion must be a plain version such as 1.2.3`;
    default:
      return unreachable(p);
  }
}

export function renderWarning(w: ConfigWarning): string {
  switch (w.kind) {
    case "stale-after-clamped":
      return `${w.file}: claims.staleAfter ${w.value} is below the ${w.minimum} minimum, so norn uses ${w.minimum}; shorter, and live claims get taken over`;
    case "team-setting-in-local-file":
      return `${w.file}: ${w.setting} is shared by the team, so norn ignores it here; set it in ${w.team}`;
    case "norn-version-missing":
      return `${w.file}: nornVersion is not set; run norn init to record the norn version this repository uses`;
    case "norn-version-differs":
      return `${w.file}: nornVersion is ${w.repo} and your norn is ${w.running}; ${
        w.direction === "newer" ? "run norn init to update the skills and nornVersion for the team" : `upgrade norn with ${upgradeNorn(w.repo)}`
      }`;
    default:
      return unreachable(w);
  }
}

// Refusals

/** The ways to finish a step, aligned, with what each means. */
function finishLines(finish: FinishCommand[]): string[] {
  if (finish.length === 1 && finish[0].word === "") return [`  norn done ${finish[0].issue}`];
  const cmds = finish.map((f) => `norn done ${f.issue} ${f.word}${f.note ? ` "${f.note}"` : ""}${f.evidence ? " [--evidence <dir>]" : ""}`);
  const width = Math.max(...cmds.map((c) => c.length)) + 3;
  return cmds.map((c, i) => `  ${c.padEnd(width)}(${finish[i].means})`);
}

const pick = (story: number | null) => (story ? `Run norn next ${story} and pick a different item.` : "Pick a different item.");

export function renderRefusal(r: Refusal | CliRefusal): string[] {
  switch (r.kind) {
    case "usage":
      return [USAGE];
    case "needs-number":
      return ["Give the issue number explicitly:", `  ${NEEDS_NUMBER[r.command]}`];
    case "port-taken":
      return [`Port ${r.port} is taken. Pick another with --port, or leave it out to use the next free one.`];
    case "bad-dashboard-flag":
      return [r.flag === "port" ? "--port takes a port number, e.g. 4477." : "--interval takes a duration such as 30s, 2m or 1h."];
    case "missing-skills":
      return [`Missing skills: ${r.missing.join(", ")}. The skill install did not provide them into skills/.`, "Fix the install and run norn init again."];
    case "init-would-downgrade":
      return [
        `This repository is set up with norn ${r.repo}, newer than your norn ${r.running}. norn init would roll its skills back.`,
        `Upgrade norn: ${upgradeNorn(r.repo)}, then run norn init again.`,
      ];
    case "version-incompatible":
      return [
        `This repository uses norn ${r.repo}, which your norn ${r.running} cannot work with.`,
        r.direction === "older"
          ? `Upgrade norn: ${upgradeNorn(r.repo)}`
          : `Run norn init to bring the repository to ${r.running} and commit the change, or install norn ${r.repo}.`,
        "Then run norn doctor for a full check of the setup.",
      ];
    case "config-invalid":
      return ["norn cannot read its configuration:", ...r.problems.map((p) => `  ${problem(p)}`), "Fix the file and run the command again."];
    case "provider-mismatch": {
      const start = r.provider === "herdr" ? "Start from a herdr pane" : "Start from a Claude Code session";
      return [`The worktree provider is ${r.provider}, but ${r.variable} is not set.`, `${start}, or switch the provider in ${LOCAL_CONFIG}.`];
    }
    case "closed":
      return [`#${r.issue} is closed. There is nothing to do on it.`];
    case "ambiguous-state":
      return [`#${r.issue} has more than one state label (${r.states.join(", ")}); a person must remove the stale one.`, pick(r.story)];
    case "story-in-implementation":
      return [
        `Story #${r.issue} is in implementation. Its label follows its slices; there is no step to take on the story itself.`,
        `Run norn next ${r.issue} to see its slices.`,
      ];
    case "story-in-merge-queue":
      return [
        `Story #${r.issue} is in merge-queue. Only the story owner (${r.owner ? `@${r.owner}` : "unassigned"}) merges the story PR;`,
        `once it is merged, norn next ${r.issue} closes the story if GitHub has not. Do not merge it yourself.`,
      ];
    case "blocked":
      return [`#${r.issue} is blocked by ${issues(r.blockers) || "other issues"}. Do not work on it yet.`, pick(r.story)];
    case "no-step":
      return [`#${r.issue} (${r.state ?? "no state"}) has no step norn can brief.`, pick(r.story)];
    case "flow-invalid":
      return [
        `#${r.issue} runs the flow ${r.flow}, which is broken, so norn cannot run it:`,
        ...r.errors.map((e) => `  ${flowError(e)}`),
        `Fix .agents/flows/${r.flow}.json on the base branch, then run the command again. Issues of other types are not affected.`,
      ];
    case "held":
      return [
        `${heldWhat(r)} is already held by another session (since ${heldSince(r.since)}).`,
        `Do not work on it.${r.story ? ` Run norn next ${r.story} and pick a different item.` : ""}`,
      ];
    case "held-by-your-session":
      return [
        `${heldWhat(r)} is held by another session of yours (since ${heldSince(r.since)}).`,
        `If that session has stopped, take it over here: norn take ${r.issue} --takeover`,
        "If it is still running, do not work on it.",
      ];
    case "held-by-teammate":
      return [
        `${heldWhat(r)} is held by @${r.holder} (since ${heldSince(r.since)}). --takeover only takes over your own sessions.`,
        "Ask them to release it, or wait until the claim goes stale.",
      ];
    case "not-claimed":
      return [`You do not hold #${r.issue}. Claim it first with: norn take ${r.issue}`];
    case "held-by-other-session":
      return [`#${r.issue} is held by another session (since ${hhmm(r.since)}). Do not work on it or finish it.`];
    case "outcome-missing":
      return [`${r.step} can end more than one way. Say which.`, "Finish with one of:", ...finishLines(r.finish)];
    case "outcome-unknown":
      return [`"${r.word}" is not an outcome of ${r.step}.`, "Finish with one of:", ...finishLines(r.finish)];
    case "note-missing":
      return [`This outcome needs a ${r.note}. Run:`, `  norn done ${r.issue} ${r.word} "${r.note}"${r.evidence ? " [--evidence <dir>]" : ""}`];
    case "evidence-not-allowed":
      return [`--evidence is for QA steps; ${r.step} takes none. Finish without it:`, ...finishLines(r.finish)];
    case "evidence-not-a-directory":
      return [`${r.dir} is not a directory. Put the evidence files in a directory and pass its path to --evidence.`];
    case "evidence-empty":
      return [`${r.dir} is empty. Put the evidence files in it, or finish without --evidence.`];
    case "evidence-too-big":
      return [
        `These files are over ${r.limitBytes / 1024 / 1024} MB, too big to push as evidence: ${r.files.join(", ")}.`,
        "Trim them, e.g. cut a log to the part that shows the result, and run the command again.",
      ];
    case "no-slices":
      return [
        `Story #${r.issue} has no slices yet. Create them first, one per slice, with:`,
        `  norn add-slice ${r.issue} "title" --mode afk|hil [--blocked-by <issue>]`,
      ];
    case "not-in-story":
      return [`#${r.issue} is not a sub-issue of a story.`];
    case "no-slice-pr":
      return [`No PR from ${r.head} was found. Open and merge it before running norn done ${r.issue}.`];
    case "slice-pr-wrong-base":
      return [
        `PR #${r.pr} from ${r.head} targets ${r.base}, not the story branch ${r.storyBranch}.`,
        r.merged
          ? `Its changes are not on ${r.storyBranch}, and a person must sort that out. Run: norn escalate ${r.issue} ${sh(`slice PR #${r.pr} was merged into ${r.base}, not ${r.storyBranch}`)}`
          : `Retarget it with: gh pr edit ${r.pr} --base ${sh(r.storyBranch)}, then merge it and run norn done ${r.issue}.`,
      ];
    case "slice-pr-not-merged":
      return [`PR #${r.pr} from ${r.head} is not merged yet.`, `Merge it into ${r.base} (resolve conflicts if needed), then run norn done ${r.issue}.`];
    case "base-branch-missing":
      return [
        `The story branch ${r.branch} would start from ${r.base}, but ${r.base} does not exist on GitHub.`,
        `Set baseBranch in ${TEAM_CONFIG} to the repository's default branch and run the command again.`,
      ];
    case "reason-missing":
      return ["Say why a human is needed. Run:", `  norn escalate ${r.issue} "reason"`];
    case "add-slice-usage":
      return ["add-slice needs a title and a mode. Run:", `  norn add-slice ${r.story} "title" --mode afk|hil [--blocked-by <issue>]...`];
    case "story-not-slicing":
      return [`Story #${r.story} is in ${r.state ?? "no state"}, not needs-slicing. Slices are only added while slicing.`];
    case "is-a-slice":
      return [`#${r.issue} is a slice${r.story ? ` of story #${r.story}. Run norn next ${r.story}` : ""} instead.`];
    case "not-a-story":
      return [`#${r.issue} is not a story yet. Triage it first with: norn take ${r.issue}`];
    default:
      return unreachable(r);
  }
}

/** One thing wrong with a flow file. */
function flowError(e: FlowError): string {
  switch (e.kind) {
    case "not-json":
      return `It is not valid JSON: ${e.detail}`;
    case "field-invalid":
      return `${e.path || "The file"} must be ${e.expected}.`;
    case "start-unknown":
      return `start names ${e.start}, which is not one of its states.`;
    case "target-unknown":
      return `The outcome ${e.word} of ${e.state} leads to ${e.to}, which is not one of its states, closed or not-planned.`;
    case "state-reserved":
      return `The state ${e.state} takes a name norn keeps for itself.`;
    case "end-unreachable":
      return `From ${e.state}, no outcome ever leads to closed or not-planned.`;
    default:
      return unreachable(e);
  }
}

const heldWhat = (r: { issue: number; slice: boolean }) => `${r.slice ? "Slice " : ""}#${r.issue}`;
const heldSince = (since: string | null) => (since ? hhmm(since) : "unknown");

// Events

const TASKS: Record<Exclude<FollowUpTask, "clear-labels">, string> = {
  "unblock-slices": "unblock the slices waiting on it",
  "move-story-on": "move the story on",
  "close-merged-story": "close the merged story",
};

export function renderEvent(e: Event): string[] {
  switch (e.kind) {
    case "story-branch-created":
      return [`Created the story branch ${e.branch}.`];
    case "story-branch-failed":
      return [`Could not create the story branch: ${e.detail}`];
    case "base-branch-missing":
      return renderRefusal(e);
    case "worktree-left-for-tidy":
      return [`Its worktree ${e.worktree} is removed by the next norn tidy.`];
    case "slice-state-changed":
      return [`#${e.issue} is now ${e.state}.`];
    case "story-promoted":
      return [`Every slice is merged. Story #${e.story} is now in needs-review.`];
    case "story-closed":
      return [`The story PR is merged. Closed story #${e.story}.`];
    case "follow-up-failed": {
      const what = e.what === "clear-labels" ? `clear the labels of #${e.issue}` : TASKS[e.what];
      return [`Could not ${what}: ${e.detail}. norn next ${e.retry} will retry this.`];
    }
    default:
      return unreachable(e);
  }
}

// Results

export function renderAnswer(a: Answer): string[] {
  switch (a.kind) {
    case "taken":
      return renderTake(a);
    case "done":
      return renderDone(a);
    case "escalated":
      return [`#${a.issue} now needs a human. The claim is released.`, "Do not work on it further. A person picks it up with the norn-resolve skill."];
    case "released":
      return [`Released #${a.issue}. Its state is unchanged. Do not work on it further.`];
    case "slice-added": {
      const status = a.blockedBy.length ? `blocked by ${issues(a.blockedBy)}` : "ready-for-agent";
      return [`Created slice #${a.slice} "${a.title}" (mode:${a.mode}, ${status}).`];
    }
    case "next":
      return [renderNext(a.report)];
    case "status":
      return renderStatus(a);
    case "tidy":
      return [renderTidy(a)];
    case "dashboard":
      return renderDashboard(a);
    case "doctor":
      return renderDoctor(a);
    case "initialized":
      return [
        "norn is set up in this project:",
        `  - ${a.skills} skills in skills/, linked into .claude/skills/`,
        ...(a.updated.length ? [`  - updated to this norn version: ${a.updated.join(", ")} (git diff skills/ shows the changes)`] : []),
        ...(a.version ? [`  - nornVersion ${a.version.from ? `${a.version.from} → ${a.version.to}` : `set to ${a.version.to}`} in ${TEAM_CONFIG}`] : []),
        "  - .agents/specs/ for story specs",
        `  - ${TEAM_CONFIG} with the team settings (each developer can override in ${LOCAL_CONFIG})`,
        "  - .agents/worktrees/ and the local config in .gitignore",
        `  - how to work with norn in ${a.instructed.join(" and ")}`,
        `  - ${a.labels} labels on the repository`,
        "",
        `Commit skills/, .claude/skills/, .agents/, .gitignore and ${a.instructed.join(", ")}. Then ask your agent: norn-drive <issue>`,
        "Run norn doctor to check what init cannot set up: gh, your access to the repository, the worktree provider.",
      ];
    default:
      return unreachable(a);
  }
}

// Doctor

const MARK = { ok: "✓", warning: "!", fail: "✗", skipped: "-" } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderDoctor(r: DoctorResult): string[] {
  const out = r.checks.flatMap((c) => {
    const { message, fix } = renderCheck(c);
    return [`${MARK[c.level]} ${c.id}: ${message}`, ...(fix ? [`  fix: ${fix}`] : [])];
  });
  const failed = r.checks.filter((c) => c.level === "fail").length;
  const warned = r.checks.filter((c) => c.level === "warning").length;
  const summary = doctorFailed(r)
    ? `${plural(failed, "check")} failed${warned ? ` and ${warned} warned` : ""}. Run the fixes above, then norn doctor again.`
    : warned
      ? `Nothing failed, but ${plural(warned, "check")} warned. Run the fixes above when you can.`
      : "Everything norn needs is set up.";
  return [...out, "", summary];
}

/** One check's finding and, for a warning or failure, what fixes it. */
export function renderCheck(c: DoctorCheck): { message: string; fix: string | null } {
  const f: CheckFact = c.fact;
  const ok = c.level === "ok";
  switch (f.kind) {
    case "skipped":
      return { message: `skipped, needs ${f.needs}`, fix: null };
    case "gh-error":
      return { message: `gh failed: ${f.detail}`, fix: "gh auth status" };
    case "gh":
      if (f.auth.kind === "missing") return { message: "gh is not installed", fix: "install gh from https://cli.github.com, then run gh auth login" };
      if (f.auth.kind === "logged-out") return { message: `gh is not logged in to ${f.host}`, fix: `gh auth login --hostname ${f.host}` };
      return { message: `logged in to ${f.host}`, fix: null };
    case "not-a-checkout":
      return { message: f.detail, fix: "cd into the repository's checkout and run norn doctor there" };
    case "no-origin":
      return { message: "this checkout has no origin remote", fix: "git remote add origin <the repository's GitHub URL>" };
    case "origin":
      return f.onGitHub
        ? { message: `origin is ${f.origin}`, fix: null }
        : {
            message: `origin ${f.origin} is not on GitHub`,
            fix: `git remote set-url origin <the repository's GitHub URL>${f.host ? `, or for GitHub Enterprise: gh auth login --hostname ${f.host}` : ""}`,
          };
    case "base-branch":
      return f.exists
        ? { message: `${f.branch} exists on GitHub`, fix: null }
        : {
            message: `baseBranch ${f.branch} does not exist on GitHub`,
            fix: `set baseBranch in ${TEAM_CONFIG} to a branch that exists on GitHub${f.defaultBranch ? `, e.g. ${f.defaultBranch}` : ""}`,
          };
    case "permission": {
      const role = f.permission === "none" ? "no" : f.permission;
      return ok
        ? { message: `you have ${role} access to the repository`, fix: null }
        : { message: `you have ${role} access to the repository; norn needs write or higher`, fix: "ask an admin of the repository for write access" };
    }
    case "labels":
      return f.missing.length
        ? { message: `${f.missing.length} of norn's labels are missing: ${f.missing.join(", ")}`, fix: "norn init" }
        : { message: `all ${f.total} of norn's labels exist`, fix: null };
    case "config":
      if (f.problems.length) return { message: f.problems.map(problem).join("; "), fix: "edit the config files as described, then run norn doctor again" };
      if (f.warnings.length) return { message: f.warnings.map(renderWarning).join("; "), fix: "edit the config files as described" };
      return { message: "the team and local config are valid", fix: null };
    case "version": {
      if (f.repo === null || f.match === null) return { message: `norn ${f.running}, repo has no nornVersion`, fix: "norn init" };
      const versions = `norn ${f.running}, repo ${f.repo}`;
      if (f.match.kind === "same" || f.match.kind === "patch") return { message: versions, fix: null };
      const fix = f.match.kind === "newer" ? "norn init" : upgradeNorn(f.repo);
      return { message: f.match.compatible ? versions : `${versions}: not compatible`, fix };
    }
    case "skills": {
      if (f.missing.length || f.unlinked.length) {
        const parts = [
          ...(f.missing.length ? [`missing from skills/: ${f.missing.join(", ")}`] : []),
          ...(f.unlinked.length ? [`not linked from .claude/skills/: ${f.unlinked.join(", ")}`] : []),
        ];
        return { message: parts.join("; "), fix: "norn init" };
      }
      if (f.drifted?.length) return { message: `differ from the skills bundled with this norn: ${f.drifted.join(", ")}`, fix: "norn init" };
      const source = f.drifted === null ? " (from NORN_SKILLS_SOURCE, so not compared with the bundled ones)" : "";
      return { message: `all ${f.total} skills are in skills/ and linked from .claude/skills/${source}`, fix: null };
    }
    case "agent-instructions":
      return f.files.length
        ? { message: `the norn block is in ${f.files.join(" and ")}`, fix: null }
        : { message: "neither AGENTS.md nor CLAUDE.md has the norn block", fix: "norn init" };
    case "provider": {
      if (f.unsetVariable === null) return { message: `${f.provider} matches the environment`, fix: null };
      const start = f.provider === "herdr" ? "start norn from a herdr pane" : "start norn from a Claude Code session";
      return {
        message: `the worktree provider is ${f.provider}, but ${f.unsetVariable} is not set`,
        fix: `${start}, or set worktrees.provider in ${LOCAL_CONFIG}`,
      };
    }
    default:
      return unreachable(f);
  }
}

/** A duration in the largest unit that divides it, e.g. 2m, 45s. */
function duration(ms: number) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function renderDashboard(a: DashboardResult): string[] {
  const raised = a.raisedFrom
    ? [`norn warning: --interval ${a.raisedFrom} is below the 30s floor, so the dashboard reads GitHub every ${duration(a.intervalMs)}.`]
    : [];
  if (a.launch.kind === "already-running") return [...raised, `norn dashboard is already running for this repository at ${a.launch.url}.`];
  const where = `norn dashboard is running at ${a.launch.url} and reads GitHub every ${duration(a.intervalMs)}.`;
  return [
    ...raised,
    a.launch.port === a.port ? where : `Port ${a.port} is taken, so ${where}`,
    `${a.launch.opened ? "Opened it" : "Open it"} in your browser. Stop it with Ctrl-C.`,
  ];
}

/** git checks a branch out in one worktree only, so no create command can work. */
function checkedOutElsewhere(branch: string, path: string) {
  return `Branch ${branch} is checked out at ${path}; work there or switch that checkout to another branch.`;
}

/** Briefing in fixed order: where you are, what to do, how to finish, what not to do. */
export function renderBriefing(b: Briefing): string[] {
  const n = b.issue;
  const { step } = b;
  let where = `You now hold ${b.noun} #${n} "${b.title}". Its step is ${step.name}.`;
  if (step.attended) where += " This step is attended: the user takes part, and you do not decide on your own.";
  const when = step.attended ? `When the user agrees ${step.name} is finished` : `When ${step.name} is finished`;
  const workIn: string[] = [];
  if (b.workIn) {
    const { path, branch, worktree } = b.workIn;
    workIn.push(`Work in: ${path} (branch ${branch})`);
    if (worktree.kind === "checked-out-elsewhere") workIn.push(checkedOutElsewhere(branch, worktree.at));
    else if (worktree.kind === "missing") workIn.push("It does not exist yet. Create it first:", `  ${worktree.create}`);
    else {
      if (worktree.dirty) workIn.push("It has uncommitted changes, e.g. from an earlier session. Check git status there before you start.");
      if (worktree.update) workIn.push("Bring it up to date first:", `  ${worktree.update}`);
    }
    workIn.push("");
  }
  return [
    wrap(where),
    "",
    ...workIn,
    `Invoke the skill: ${step.skill}`,
    ...b.instructions,
    "",
    `${when}, run${b.finish.length > 1 ? " one of" : ""}:`,
    ...finishLines(b.finish),
    "",
    `On a long step, run norn take ${n} again now and then: it keeps your claim fresh.`,
    `If you have to stop, run: norn release ${n}`,
    `If something is wrong and a person is needed, run: norn escalate ${n} "reason"`,
    "",
    "Do not change labels yourself. Only norn changes them.",
  ];
}

function renderTake(t: TakeResult): string[] {
  const n = t.issue;
  const lines = renderBriefing(t.briefing);
  if (t.tookOver) {
    const since = hhmm(t.tookOver.since);
    const was = t.tookOver.own
      ? `You took #${n} over from another session of yours (since ${since})`
      : `The previous holder's claim was stale (since ${since})`;
    const note = `${was}${t.tookOver.worktreeKept ? "; its worktree is kept with what it left. Check git status there before you start." : "."}`;
    lines.splice(lines.indexOf(""), 0, "", note);
  }
  if (t.reacquired) lines.unshift(`You already held #${n}; the claim is refreshed. Here is its briefing again.`, "");
  return lines;
}

function renderDone(d: DoneResult): string[] {
  const n = d.issue;
  const where = d.to === "closed" ? "closed" : d.to === "not-planned" ? "closed as not planned" : `in ${d.to}`;
  const lines = [`#${n} is now ${where}. The claim is released.`];
  if (d.evidence) {
    const count = d.evidence.files.length;
    lines.push(`Pushed ${count} evidence file${count === 1 ? "" : "s"} to ${d.evidence.branch} and embedded them in the comment.`);
  }
  if (d.fixLimit !== null) lines.push(`#${n} has reached ${d.fixLimit} fix rounds, so it now needs a human instead of another round of implement.`);
  if (d.storyBranchCreated) lines.push(...renderEvent({ kind: "story-branch-created", branch: d.storyBranchCreated }));
  lines.push(...d.followUps.flatMap(renderEvent));
  if (d.deliverable) lines.push(`To run the story unattended until it needs a human, the user can start the norn-deliver skill: norn-deliver ${n}`);
  if (d.personNext) lines.push(`A person does the next step, so do not take #${n} again. norn has notified the user.`);
  return lines;
}

// status

/** The state as status shows it; two state labels are shown as both, since norn cannot tell which is real. */
export function rowState(r: Row): string {
  if (r.status !== "open") return r.status;
  if (r.states.length > 1) return `${r.states.join(" + ")} (more than one state label)`;
  return r.states[0] ?? "untriaged";
}

function renderStatus(s: StatusResult): string[] {
  const describe = (r: Row) => {
    const state = rowState(r);
    const parts = [state === "blocked" && r.blockedBy.length ? `blocked by ${issues(r.blockedBy)}` : state];
    if (r.mode && state !== "merged" && state !== "closed") parts.push(`mode:${r.mode}`);
    if (r.needsHuman) parts.push("needs-human");
    if (r.heldSince) parts.push(`held since ${hhmm(r.heldSince)}${r.stale ? " (stale)" : ""}`);
    return parts.join(" · ");
  };
  const { story, slices } = s;
  const lines = [`Story #${story.number} "${story.title}": ${describe(story)} · owner ${story.owner ? `@${story.owner}` : "none"} · branch ${story.branch}`];
  if (slices.length) {
    lines.push(`Slices (${slices.filter((r) => r.status === "merged").length} of ${slices.length} merged):`);
    const names = slices.map((r) => `#${r.number} "${r.title}"`);
    const width = Math.max(...names.map((x) => x.length)) + 3;
    for (const [i, r] of slices.entries()) lines.push(`  ${names[i].padEnd(width)}${describe(r)}`);
  } else lines.push("No slices yet.");
  return lines;
}

// tidy

export function renderRemoval(r: Removal): string {
  switch (r.kind) {
    case "qa-branch":
      return `QA evidence branch ${r.branch} (#${r.issue} is closed)`;
    case "worktree":
      return `worktree ${r.path} (${r.of} #${r.issue} is closed)`;
    case "local-branch":
      return `local branch ${r.branch} (merged into ${r.into})`;
    case "remote-branch":
      return `branch ${r.branch} on GitHub (merged into ${r.into})`;
    case "claim":
      return `claim on #${r.issue} (#${r.issue} is closed)`;
    default:
      return unreachable(r);
  }
}

export function renderKept(k: Kept): string {
  switch (k.kind) {
    case "worktree-in-use":
      return `${k.path}: norn is running inside it. Run norn tidy from another directory to remove it.`;
    case "worktree-dirty":
      return `${k.path}: it has uncommitted changes. Commit and push them, or remove it by hand when done.`;
    case "worktree-unpushed":
      return `${k.path}: branch ${k.branch} has commits that are not on GitHub. Push them, or remove it by hand when done.`;
    case "branch-checked-out":
      return `branch ${k.branch}: it is checked out at ${k.at}. Switch that checkout to another branch to let norn tidy remove it.`;
    case "branch-unpushed":
      return `branch ${k.branch}: it has commits that are not on GitHub. Push them, or delete it by hand.`;
    default:
      return unreachable(k);
  }
}

export function tidyNotes(r: TidyResult): string[] {
  return r.fetchFailed === null ? [] : [`Could not fetch from GitHub, so work pushed since the last fetch counts as unpushed and is kept: ${r.fetchFailed}`];
}

export const renderFailure = (f: TidyResult["failed"][number]) => `${renderRemoval(f.removal)}: ${f.detail}`;

function renderTidy(r: TidyResult): string {
  const notes = tidyNotes(r);
  const out: string[] = [...notes];
  if (r.removed.length) {
    out.push(r.dryRun ? "norn tidy would remove (dry run, nothing was changed):" : "norn tidy removed:", ...r.removed.map((x) => `  - ${renderRemoval(x)}`));
  }
  if (r.kept.length) out.push("Kept, so no work is lost:", ...r.kept.map((x) => `  - ${renderKept(x)}`));
  if (r.failed.length) out.push("Could not remove, the rest still ran:", ...r.failed.map((x) => `  - ${renderFailure(x)}`));
  if (out.length === notes.length) out.push("Nothing to tidy: nothing is left of closed issues.");
  return out.join("\n");
}

// next

const DESCRIBE: Partial<Record<State, string>> = {
  "ready-for-agent": "is ready-for-agent",
  implementation: "is in implementation with no one holding it",
  "needs-review": "needs review",
  "changes-requested": "has changes requested",
  "needs-qa": "needs QA by an agent",
  "qa-failed": "failed QA",
  "merge-queue": "is in merge-queue",
};

/** Which session holds an item, and since when. */
export function holderText(h: Holder) {
  const who = { this: "this session", yours: "another session of yours", other: "another session" }[h.session];
  return `${who} (since ${hhmm(h.since)})`;
}

/** What an item waits on, as said after its number. */
export function waitDetail(w: WaitItem): string {
  switch (w.reason) {
    case "blocked":
      return `is blocked by ${issues(w.blockers)}`;
    case "needs-human":
      return w.why ?? "see its latest comment";
    case "human-qa":
      return `needs human QA (${w.of})`;
    case "held":
      return `is held by ${holderText(w.holder)}`;
    case "owner-merge":
      return `waits for its owner (${w.owner ? `@${w.owner}` : "the story owner"}) to merge the story PR into ${w.into}`;
    case "no-state":
      return "has no state label; a person must set one";
    case "ambiguous-state":
      return `has more than one state label (${w.states.join(", ")}); a person must remove the stale one`;
    default:
      return unreachable(w);
  }
}

const heldByOf = (w: WaitItem) => ("heldBy" in w ? w.heldBy : undefined);

/** How the user does an item for a person now: here, or with an agent in its worktree's pane. */
function humanHandOff(w: WaitItem): string[] {
  if (w.reason !== "needs-human" && w.reason !== "human-qa") return [];
  if (!w.worktree || w.heldBy) return [];
  if (w.here) return ["    You are in its worktree: if the user does it now, take it in this session."];
  if (w.checkedOutAt && w.branch) return [`    ${checkedOutElsewhere(w.branch, w.checkedOutAt)}`];
  return [
    "    If the user does it now, hand it to an agent in its worktree:",
    ...(w.createWorktree ? [`      Create the worktree: ${w.createWorktree}`] : []),
    `      herdr agent start norn-${w.issue} --kind claude --pane <pane of ${w.worktree}>`,
    `      herdr agent prompt norn-${w.issue} "norn-drive ${w.issue}"`,
    `      herdr agent focus norn-${w.issue}`,
  ];
}

/** What waits for a person, and who holds it if a session does. */
function humanDetail(w: WaitItem) {
  const held = heldByOf(w);
  return `${waitDetail(w)}${held ? `, held by ${holderText(held)}` : ""}`;
}

function waitLine(w: WaitItem) {
  // Inside its worktree this session is where the user does it, so it is not told off.
  const dont = "here" in w && w.here ? "" : " Do not take it.";
  if (w.reason === "needs-human") return `  - #${w.issue} needs a human: ${humanDetail(w)}.${dont}`;
  if (w.reason === "human-qa") return `  - #${w.issue} ${humanDetail(w)}.${dont}`;
  return `  - #${w.issue} ${waitDetail(w)}.`;
}

function renderNothingLeft(r: NextReport): string {
  const human = r.waiting.filter((w) => FOR_HUMAN.includes(w.reason));
  const blocked = r.waiting.filter((w) => w.reason === "blocked");
  const out = [...r.notes.flatMap(renderEvent), `Story #${r.story} "${r.title}": nothing left that you can do.`];
  if (human.length) out.push("Waiting for a human:", ...human.flatMap((w) => [`  - #${w.issue} ${humanDetail(w)}.`, ...humanHandOff(w)]));
  if (blocked.length) out.push("Blocked until then:", ...blocked.map(waitLine));
  out.push(`Stop here and report to the user.${r.notified ? " norn has already notified them." : ""}`);
  return out.join("\n");
}

function runningNote(r: NextReport) {
  if (!r.running) return "";
  return ` (${r.running} of your agents ${r.running === 1 ? "is" : "are"} running, the limit is ${r.maxParallel})`;
}

export function renderNext(r: NextReport): string {
  const notes = r.notes.flatMap(renderEvent);
  if (r.closed) {
    return [...notes, `Story #${r.story} "${r.title}" is closed${r.notPlanned ? " as not planned" : ""}. Nothing left that you can do.`].join("\n");
  }
  if (r.nothingLeft) return renderNothingLeft(r);
  const out: string[] = [];
  if (notes.length) out.push(...notes, "");
  let head = `Story #${r.story} "${r.title}" is in ${r.state ?? "no state"}.`;
  if (r.slices.total) head += ` ${r.slices.merged} of ${r.slices.total} slices are merged into ${r.branch}.`;
  out.push(wrap(head), "");

  if (r.start.length === 0) {
    out.push(`Nothing can be started now. Wait for the running items to finish, then run norn next ${r.story} again.`);
  } else if (r.slots === 0 && r.start.every((s) => !s.attended)) {
    const ready = `${r.start.length} item${r.start.length === 1 ? " is" : "s are"} ready`;
    out.push(
      wrap(
        `${ready}, but ${r.running} of your agents are running, the limit of deliver.maxParallel. Wait for one to finish, then run norn next ${r.story} again.`,
      ),
      "",
      ...r.start.map((s) => `  - ${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}" ${DESCRIBE[s.state] ?? `is in ${s.state}`}.`),
    );
  } else {
    // Attended steps are done with the user, not by a fresh agent of their own.
    const attendedOnly = r.start.every((s) => s.attended);
    const count = `You can start ${r.start.length} item${r.start.length === 1 ? "" : "s"} now`;
    const agent = {
      herdr: "each as a new herdr agent in the item's worktree pane:",
      "claude-code": "each in its own fresh subagent, told to work in the item's worktree:",
      git: "each in a new agent session started in the item's worktree:",
    }[r.provider];
    out.push(
      attendedOnly
        ? `${count}, with the user:`
        : r.start.length === 1
          ? `${count}, ${agent.replace(/^each /, "")}`
          : wrap(`${count}. They are independent, so run them in parallel, at most ${r.slots} at a time${runningNote(r)}, ${agent}`),
      "",
    );
    for (const s of r.start) {
      const what = `${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}"`;
      const desc =
        s.kind === "story" && !DESCRIBE[s.state]
          ? `is in ${s.state}: ${s.step}${s.attended ? " (attended: the user takes part)" : ""}.`
          : `${DESCRIBE[s.state] ?? `is in ${s.state}`}${s.attended ? " (attended: the user takes part)" : ""}.`;
      out.push(`  - ${what} ${desc}`);
      if (s.worktree) out.push(`    Worktree: ${s.worktree}`);
      if (s.createWorktree) out.push(`    Create the worktree: ${s.createWorktree}`);
      if (s.checkedOutAt && s.branch) out.push(`    ${checkedOutElsewhere(s.branch, s.checkedOutAt)}`);
      if (r.provider === "herdr" && s.worktree) {
        const start = `herdr agent start norn-${s.issue} --kind claude --pane <pane of ${s.worktree}>`;
        if (!s.attended) {
          const prompt = `Work in ${s.worktree}. Run norn take ${s.issue}, follow its briefing to the end, and finish with the norn command it gives.`;
          out.push(`    Start an agent: ${start}`, `    Then prompt it: herdr agent prompt norn-${s.issue} "${prompt}"`);
        } else if (s.here) out.push("    You are in its worktree: take it in this session.");
        else {
          // An attended step needs the user, so the new agent drives the story from its worktree and this session stops.
          out.push(
            "    Hand the story to an agent in its worktree, which drives it on with the user:",
            `      ${start}`,
            `      herdr agent prompt norn-${s.issue} "norn-drive ${r.story}"`,
            `      herdr agent focus norn-${s.issue}`,
          );
        }
      }
      if (s.session && s.worktree) out.push(`    Start an agent in ${s.worktree} with NORN_SESSION=${s.session} set.`);
      out.push(`    Start it with: ${s.command}`);
    }
  }
  if (r.waiting.length) {
    out.push("", "Waiting, nothing to do for you:");
    for (const w of r.waiting) out.push(waitLine(w), ...humanHandOff(w));
  }
  if (r.start.some((s) => !s.attended)) out.push("", `Each phase gets a new agent. When an item is done, run norn next ${r.story} again.`);
  return out.join("\n");
}

// Notifications

/** A notification's title says who must act on what; its body gives the reason and the link. */
export function renderNotification(n: Notification): { title: string; body: string } {
  switch (n.kind) {
    case "needs-human":
      return { title: `norn: #${n.issue} needs you`, body: `${n.reason}\n${n.url}` };
    case "needs-human-qa":
      return { title: `norn: #${n.issue} needs you`, body: `needs human QA (${n.of})\n${n.url}` };
    case "story-waiting":
      return {
        title: `norn: story #${n.story} is waiting for you`,
        body: n.waiting.map((w) => `#${w.issue} ${waitDetail(w)}`).join("\n") || "Nothing left to do on the story.",
      };
    default:
      return unreachable(n);
  }
}
