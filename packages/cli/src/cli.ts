import { parseArgs } from "./args.js";
import {
  addSlice,
  type ConfigWarning,
  type Ctx,
  done,
  escalate,
  loadConfig,
  next,
  providerRefusal,
  type Refusal,
  release,
  type Settlement,
  type Slugs,
  status,
  take,
  tidy,
  versionCheck,
} from "@norn/core";
import { dashboard, type StartDashboard } from "./dashboard.js";
import { doctor, doctorFailed } from "./doctor.js";
import { flows } from "./flows.js";
import { init } from "./init.js";
import { deliver } from "./deliver.js";
import { underHerdr } from "./herdr.js";
import { closeRunTabs, leftoverRunTabs } from "./run-tabs.js";
import { renderJson } from "./render-json.js";
import {
  type Answer,
  type CliRefusal,
  NEEDS_NUMBER,
  progressLine,
  renderAnswer,
  renderDeliverEvent,
  renderRefusal,
  renderRunEvent,
  renderWarning,
  runPrompt,
  USAGE,
} from "./render-text.js";
import { type RunHost, startRun, supervise } from "./supervise.js";

export type Deps = Omit<Ctx, "config" | "slugs"> & {
  cwd: string;
  /** Installs the norn skills into <cwd>/skills/. */
  installSkills: (cwd: string) => Promise<string[]>;
  /** Starts the dashboard server; the CLI only works out how. */
  dashboard: StartDashboard;
  /** The running norn's version, e.g. 0.7.0. */
  version: string;
  /** The skills bundled with the running norn, which norn doctor compares the installed ones with. */
  bundledSkills: string;
  /** Why norn is not in a checkout it can work in; null when it is. Only doctor runs without one. */
  checkoutProblem: string | null;
  /** What norn run and norn deliver start and watch agents with. */
  runs: RunHost;
};

/** A run's supervisor finished: how its run ended. */
export interface RunOver {
  ok: true;
  kind: "run-over";
  issue: number;
  settled: Exclude<Settlement, { kind: "retry" }>;
}

export interface Result {
  stdout: string;
  exitCode: number;
}

type Refused = { ok: false; refusal: Refusal | CliRefusal };

/** What a command answered, and the configuration warnings to print before it. */
interface Reply {
  answer: Answer | Refused;
  warnings: ConfigWarning[];
}

export async function run(argv: string[], deps: Deps): Promise<Result> {
  const { bools } = parseArgs(argv);
  if (bools.has("version")) return { exitCode: 0, stdout: deps.version };
  // Help is asked for, so it is an answer, not a usage error, and no command runs, e.g. the dashboard.
  if (bools.has("help")) return { exitCode: 0, stdout: USAGE };
  const { answer, warnings } = await dispatch(argv, deps);
  const usage = ["usage", "needs-number", "bad-dashboard-flag", "flows-usage"];
  // doctor answers even when a check fails, but exits 1 so CI notices.
  const exitCode = answer.ok ? (answer.kind === "doctor" && doctorFailed(answer) ? 1 : 0) : usage.includes(answer.refusal.kind) ? 2 : 1;
  const head = warnings.length ? ["norn warning:", ...warnings.map((w) => `  ${renderWarning(w)}`), ""] : [];
  const body = answer.ok ? renderAnswer(answer) : renderRefusal(answer.refusal);
  if (bools.has("json")) return { exitCode, stdout: renderJson(answer, warnings) };
  return { exitCode, stdout: [...head, ...body].join("\n") };
}

/** The hidden command a run's supervisor process runs: __supervise <issue> <story> <session> <agent> <worktree>. */
export const SUPERVISE = "__supervise";

/** Commands that name or touch worktrees, and so need the provider to match the environment. */
const USES_WORKTREES = new Set(["take", "next", "done", "tidy", "run", "deliver"]);

/** Commands that start agents in herdr panes, so they run only inside herdr. */
const NEEDS_HERDR = new Set(["run", "deliver", SUPERVISE]);

/** Commands that take no issue number. */
const NO_NUMBER = new Set(["init", "tidy", "dashboard", "doctor", "flows"]);

const refused = (refusal: Refusal | CliRefusal): Refused => ({ ok: false, refusal });

async function dispatch(argv: string[], input: Deps): Promise<Reply> {
  const { positionals, flags, bools } = parseArgs(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || !(cmd in NEEDS_NUMBER || NO_NUMBER.has(cmd) || cmd === SUPERVISE)) return { answer: refused({ kind: "usage" }), warnings: [] };
  if (cmd in NEEDS_NUMBER && !/^\d+$/.test(rest[0] ?? "")) return { answer: refused({ kind: "needs-number", command: cmd }), warnings: [] };
  if (cmd === "init") return { answer: await init(input), warnings: [] };
  // doctor reports a bad config, version or provider as checks, so none of them stops it.
  if (cmd === "doctor") return { answer: await doctor(input), warnings: [] };
  // export only copies a built-in flow into the project, so it needs neither the config nor GitHub.
  if (cmd === "flows") return { answer: flows(input.cwd, rest), warnings: [] };
  const loaded = await loadConfig(input.workspace);
  if (!loaded.ok) return { answer: loaded, warnings: [] };
  const version = versionCheck(loaded.config, input.version);
  const warnings = [...loaded.warnings, ...version.warnings];
  if (version.refusal) return { answer: refused(version.refusal), warnings };
  const ctx: Ctx = { ...input, config: loaded.config, slugs: new Map() as Slugs };
  if (NEEDS_HERDR.has(cmd) && !underHerdr(ctx.workspace.env)) return { answer: refused({ kind: "needs-herdr", command: cmd }), warnings };
  const provider = USES_WORKTREES.has(cmd) ? providerRefusal(ctx.config, ctx.workspace.env) : null;
  const answer = provider
    ? refused(provider)
    : cmd === "dashboard"
      ? await dashboard({ ...ctx, dashboard: input.dashboard }, flags, bools)
      : ((await runCommand(cmd, rest, flags, { ...ctx, runs: input.runs })) ?? (await command(cmd, rest, flags, bools, ctx)));
  // Under herdr, tidy closes the tabs runs left behind too.
  if (answer.ok && answer.kind === "tidy" && underHerdr(ctx.workspace.env)) {
    const left = await leftoverRunTabs(ctx, input.runs.herdr);
    return { answer: { ...answer, runTabs: answer.dryRun ? left : await closeRunTabs(input.runs.herdr, left) }, warnings };
  }
  return { answer, warnings };
}

/** The commands that start and watch agents; null for any other. */
async function runCommand(cmd: string, rest: string[], flags: Record<string, string[]>, ctx: Ctx & { runs: RunHost }): Promise<Answer | Refused | null> {
  const n = Number(rest[0]);
  const { print } = ctx.runs;
  switch (cmd) {
    case "run":
      return startRun(ctx, n, { agent: flags.agent?.[0] });
    case "deliver":
      return deliver(ctx, n, { print: (e) => print(progressLine(new Date(), renderDeliverEvent(e))) });
    case SUPERVISE: {
      const [, story, session, agent, worktree] = rest;
      const start = { issue: n, story: Number(story), session, agent, worktree, log: "" };
      const settled = await supervise({ ...ctx, session }, start, {
        env: ctx.workspace.env,
        prompt: (issue, worktree, previous) => runPrompt(issue, worktree, previous, ctx.runs.norn),
        log: (e) => print(progressLine(new Date(), `#${n} ${renderRunEvent(e)}`)),
      });
      return { ok: true, kind: "run-over", issue: n, settled };
    }
  }
  return null;
}

async function command(cmd: string, rest: string[], flags: Record<string, string[]>, bools: Set<string>, ctx: Ctx): Promise<Answer | Refused> {
  const n = Number(rest[0]);
  switch (cmd) {
    case "status":
      return status(ctx, n);
    case "take":
      return take(ctx, n, { takeover: bools.has("takeover") });
    case "done":
      return done(ctx, n, { word: rest[1], note: rest[2], evidenceDir: flags.evidence?.[0] });
    case "tidy":
      return tidy(ctx, bools.has("dry-run"));
    case "escalate":
      return escalate(ctx, n, rest[1]);
    case "release":
      return release(ctx, n);
    case "next":
      return next(ctx, n);
    case "add-slice":
      return addSlice(ctx, n, { title: rest[1], mode: flags.mode?.[0], blockedBy: (flags["blocked-by"] ?? []).map(Number) });
  }
  return refused({ kind: "usage" });
}
