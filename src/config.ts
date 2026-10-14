import { detectProvider } from "./location.js";
import type { Channel } from "./notify.js";
import type { Provider, Workspace } from "./workspace.js";

export const TEAM_CONFIG = ".agents/psdd.config.json";
export const LOCAL_CONFIG = ".agents/psdd.config.local.json";

export const DEFAULT_TEAM_CONFIG = {
  baseBranch: "main",
  worktrees: { provider: "auto" },
  claims: { staleAfter: "2h" },
  deliver: { maxParallel: 2, maxFixRounds: 3 },
};

export interface Config {
  baseBranch: string;
  /** The provider after resolving auto. */
  provider: Provider;
  staleAfterMs: number;
  maxParallel: number;
  maxFixRounds: number;
  /** Where notifications go; null when turned off. */
  notifications: Channel | null;
}

const PROVIDERS = ["auto", "herdr", "claude-code", "git"] as const;
const NOTIFICATIONS = ["auto", "herdr", "os", "none"];
const ENV_FOR: Record<Provider, string | null> = { herdr: "HERDR_ENV", "claude-code": "CLAUDECODE", git: null };
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_STALE_AFTER_MS = 10 * UNITS.m;

function toMs(duration: string) {
  return Number(duration.slice(0, -1)) * UNITS[duration.slice(-1)];
}

interface Raw {
  baseBranch?: string;
  worktrees?: { provider?: string };
  claims?: { staleAfter?: string };
  deliver?: { maxParallel?: number; maxFixRounds?: number };
  notifications?: string;
}

/** Checks one file's settings; returns problems prefixed with the file. */
function check(file: string, raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${file}: must be a JSON object`];
  const problems: string[] = [];
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!["baseBranch", "worktrees", "claims", "deliver", "notifications"].includes(key)) problems.push(`${file}: unknown setting "${key}"`);
  }
  if ("baseBranch" in r && (typeof r.baseBranch !== "string" || !r.baseBranch)) problems.push(`${file}: baseBranch must be a branch name`);
  const provider = (r.worktrees as Raw["worktrees"])?.provider;
  if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
    problems.push(`${file}: worktrees.provider must be one of ${PROVIDERS.join(", ")}`);
  }
  const stale = (r.claims as Raw["claims"])?.staleAfter;
  if (stale !== undefined && !/^\d+[smhd]$/.test(String(stale))) {
    problems.push(`${file}: claims.staleAfter must be a duration like 90m or 2h`);
  } else if (stale !== undefined && toMs(stale) < MIN_STALE_AFTER_MS) {
    problems.push(`${file}: claims.staleAfter must be at least 10m, or live claims get taken over`);
  }
  // These bind every developer's sessions alike, so one person's local file must not change them.
  if (file === LOCAL_CONFIG) {
    if (stale !== undefined) problems.push(`${file}: claims.staleAfter is shared by the team; set it in ${TEAM_CONFIG}`);
    if ((r.deliver as Raw["deliver"])?.maxFixRounds !== undefined) {
      problems.push(`${file}: deliver.maxFixRounds is shared by the team; set it in ${TEAM_CONFIG}`);
    }
  }
  if ("notifications" in r) {
    if (file === TEAM_CONFIG) problems.push(`${file}: notifications is set per developer in ${LOCAL_CONFIG}`);
    else if (!NOTIFICATIONS.includes(r.notifications as string)) problems.push(`${file}: notifications must be one of ${NOTIFICATIONS.join(", ")}`);
  }
  const deliver = (r.deliver ?? {}) as Record<string, unknown>;
  for (const key of ["maxParallel", "maxFixRounds"]) {
    const v = deliver[key];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) > 0)) problems.push(`${file}: deliver.${key} must be a whole number above 0`);
  }
  return problems;
}

async function read(workspace: Workspace, file: string): Promise<{ raw: Raw; problems: string[] }> {
  const text = await workspace.readFile(file);
  if (text === null) return { raw: {}, problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: {}, problems: [`${file}: not valid JSON (${(e as Error).message})`] };
  }
  const problems = check(file, raw);
  return { raw: problems.length ? {} : (raw as Raw), problems };
}

export type Loaded = { ok: true; config: Config } | { ok: false; lines: string[] };

/** Team file, then the developer's local file on top. */
export async function loadConfig(workspace: Workspace): Promise<Loaded> {
  const team = await read(workspace, TEAM_CONFIG);
  const local = await read(workspace, LOCAL_CONFIG);
  const problems = [...team.problems, ...local.problems];
  if (problems.length) return { ok: false, lines: ["psdd cannot read its configuration:", ...problems.map((p) => `  ${p}`), "Fix the file and run the command again."] };

  const merged = {
    baseBranch: local.raw.baseBranch ?? team.raw.baseBranch ?? DEFAULT_TEAM_CONFIG.baseBranch,
    provider: local.raw.worktrees?.provider ?? team.raw.worktrees?.provider ?? "auto",
    staleAfter: team.raw.claims?.staleAfter ?? DEFAULT_TEAM_CONFIG.claims.staleAfter,
  };
  const notifications = local.raw.notifications ?? "auto";
  const channel: Channel | null =
    notifications === "none" ? null : notifications === "auto" ? (workspace.env.HERDR_ENV === "1" ? "herdr" : "os") : (notifications as Channel);
  const provider = merged.provider === "auto" ? detectProvider(workspace.env) : (merged.provider as Provider);
  return {
    ok: true,
    config: {
      baseBranch: merged.baseBranch,
      provider,
      staleAfterMs: toMs(merged.staleAfter),
      maxParallel: local.raw.deliver?.maxParallel ?? team.raw.deliver?.maxParallel ?? DEFAULT_TEAM_CONFIG.deliver.maxParallel,
      notifications: channel,
      maxFixRounds: team.raw.deliver?.maxFixRounds ?? DEFAULT_TEAM_CONFIG.deliver.maxFixRounds,
    },
  };
}

/** The safety check: a provider named outright must match the environment. */
export function providerRefusal(config: Config, env: Record<string, string | undefined>): string[] | null {
  const variable = ENV_FOR[config.provider];
  if (!variable || env[variable] === "1") return null;
  const start = config.provider === "herdr" ? "Start from a herdr pane" : "Start from a Claude Code session";
  return [
    `The worktree provider is ${config.provider}, but ${variable} is not set.`,
    `${start}, or switch the provider in ${LOCAL_CONFIG}.`,
  ];
}
