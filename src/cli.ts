import { parseArgs } from "./args.js";
import { type ConfigWarning, loadConfig, providerRefusal } from "./config.js";
import { init } from "./init.js";
import { addSlice, done, escalate, next, release, take } from "./operations.js";
import type { Refusal } from "./refusals.js";
import { renderJson } from "./render-json.js";
import { type Answer, type CliRefusal, NEEDS_NUMBER, renderAnswer, renderRefusal, renderWarning } from "./render-text.js";
import type { Slugs } from "./slug.js";
import { status } from "./status.js";
import { tidy } from "./tidy.js";
import type { Ctx } from "./transitions.js";

export type Deps = Omit<Ctx, "config" | "slugs"> & {
  cwd: string;
  /** Installs the psdd skills into <cwd>/skills/. */
  installSkills: (cwd: string) => Promise<string[]>;
};

export interface Result {
  stdout: string;
  exitCode: number;
}

type Refused = { ok: false; refusal: Refusal | CliRefusal };

/** What a command answered, and the configuration warnings to print before it. */
interface Outcome {
  answer: Answer | Refused;
  warnings: ConfigWarning[];
}

export async function run(argv: string[], deps: Deps): Promise<Result> {
  const { bools } = parseArgs(argv);
  const { answer, warnings } = await dispatch(argv, deps);
  const exitCode = answer.ok ? 0 : answer.refusal.kind === "usage" || answer.refusal.kind === "needs-number" ? 2 : 1;
  const head = warnings.length ? ["psdd warning:", ...warnings.map((w) => `  ${renderWarning(w)}`), ""] : [];
  const body = answer.ok ? renderAnswer(answer) : renderRefusal(answer.refusal);
  if (bools.has("json")) return { exitCode, stdout: renderJson(answer, warnings) };
  return { exitCode, stdout: [...head, ...body].join("\n") };
}

/** Commands that name or touch worktrees, and so need the provider to match the environment. */
const USES_WORKTREES = new Set(["take", "next", "done", "tidy"]);

/** Commands that take no issue number. */
const NO_NUMBER = new Set(["init", "tidy"]);

const refused = (refusal: Refusal | CliRefusal): Refused => ({ ok: false, refusal });

async function dispatch(argv: string[], input: Deps): Promise<Outcome> {
  const { positionals, flags, bools } = parseArgs(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || !(cmd in NEEDS_NUMBER || NO_NUMBER.has(cmd))) return { answer: refused({ kind: "usage" }), warnings: [] };
  if (cmd in NEEDS_NUMBER && !/^\d+$/.test(rest[0] ?? "")) return { answer: refused({ kind: "needs-number", command: cmd }), warnings: [] };
  if (cmd === "init") return { answer: await init(input), warnings: [] };
  const loaded = await loadConfig(input.workspace);
  if (!loaded.ok) return { answer: loaded, warnings: [] };
  const ctx: Ctx = { ...input, config: loaded.config, slugs: new Map() as Slugs };
  const provider = USES_WORKTREES.has(cmd) ? providerRefusal(ctx.config, ctx.workspace.env) : null;
  const answer = provider ? refused(provider) : await command(cmd, rest, flags, bools, ctx);
  return { answer, warnings: loaded.warnings };
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
