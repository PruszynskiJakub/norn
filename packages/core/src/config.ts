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
  /** The developer's own dashboard settings; null where they set none. */
  dashboard: { port: number | null; intervalMs: number | null };
}

const PROVIDERS = ["auto", "herdr", "claude-code", "git"] as const;
const NOTIFICATIONS = ["auto", "herdr", "os", "none"];
const ENV_FOR: Record<Provider, string | null> = { herdr: "HERDR_ENV", "claude-code": "CLAUDECODE", git: null };
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_STALE_AFTER_MS = 10 * UNITS.m;

function toMs(duration: string) {
  return Number(duration.slice(0, -1)) * UNITS[duration.slice(-1)];
}

/** A duration such as 30s, 2m or 1h in milliseconds; null when it is not one. */
export function durationMs(duration: string): number | null {
  return /^\d+[smhd]$/.test(duration) ? toMs(duration) : null;
}

interface Raw {
  baseBranch?: string;
  worktrees?: { provider?: string };
  claims?: { staleAfter?: string };
  deliver?: { maxParallel?: number; maxFixRounds?: number };
  notifications?: string;
  dashboard?: { port?: number; interval?: string };
}

/** A setting psdd cannot use, so it refuses until the file is fixed. */
export type ConfigProblem =
  | { kind: "not-an-object"; file: string }
  | { kind: "invalid-json"; file: string; detail: string }
  | { kind: "unknown-setting"; file: string; key: string }
  | { kind: "bad-base-branch"; file: string }
  | { kind: "bad-provider"; file: string; allowed: readonly string[] }
  | { kind: "bad-stale-after"; file: string }
  | { kind: "notifications-in-team-file"; file: string; local: string }
  | { kind: "bad-notifications"; file: string; allowed: readonly string[] }
  | { kind: "bad-deliver-number"; file: string; key: string }
  | { kind: "dashboard-in-team-file"; file: string; local: string }
  | { kind: "bad-dashboard-setting"; file: string; key: "port" | "interval" };

/** A setting psdd ignores or clamps, and says so. */
export type ConfigWarning =
  | { kind: "stale-after-clamped"; file: string; value: string; minimum: string }
  | { kind: "team-setting-in-local-file"; file: string; setting: string; team: string };

/**
 * Checks one file's settings. Problems make psdd refuse; warnings are
 * printed and the setting is ignored or clamped.
 */
function check(file: string, raw: unknown): { problems: ConfigProblem[]; warnings: ConfigWarning[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problems: [{ kind: "not-an-object", file }], warnings: [] };
  const problems: ConfigProblem[] = [];
  const warnings: ConfigWarning[] = [];
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!["baseBranch", "worktrees", "claims", "deliver", "notifications", "dashboard"].includes(key)) problems.push({ kind: "unknown-setting", file, key });
  }
  if ("baseBranch" in r && (typeof r.baseBranch !== "string" || !r.baseBranch)) problems.push({ kind: "bad-base-branch", file });
  const provider = (r.worktrees as Raw["worktrees"])?.provider;
  if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
    problems.push({ kind: "bad-provider", file, allowed: PROVIDERS });
  }
  const stale = (r.claims as Raw["claims"])?.staleAfter;
  if (stale !== undefined && !/^\d+[smhd]$/.test(String(stale))) {
    problems.push({ kind: "bad-stale-after", file });
  } else if (file === TEAM_CONFIG && stale !== undefined && toMs(stale) < MIN_STALE_AFTER_MS) {
    warnings.push({ kind: "stale-after-clamped", file, value: stale, minimum: "10m" });
  }
  // These bind every developer's sessions alike, so one person's local file must not change them.
  if (file === LOCAL_CONFIG) {
    if (stale !== undefined) warnings.push({ kind: "team-setting-in-local-file", file, setting: "claims.staleAfter", team: TEAM_CONFIG });
    if ((r.deliver as Raw["deliver"])?.maxFixRounds !== undefined) {
      warnings.push({ kind: "team-setting-in-local-file", file, setting: "deliver.maxFixRounds", team: TEAM_CONFIG });
    }
  }
  if ("notifications" in r) {
    if (file === TEAM_CONFIG) problems.push({ kind: "notifications-in-team-file", file, local: LOCAL_CONFIG });
    else if (!NOTIFICATIONS.includes(r.notifications as string)) problems.push({ kind: "bad-notifications", file, allowed: NOTIFICATIONS });
  }
  if ("dashboard" in r) {
    // Each developer runs their own dashboard; a port in the team file would clash between them.
    if (file === TEAM_CONFIG) problems.push({ kind: "dashboard-in-team-file", file, local: LOCAL_CONFIG });
    else {
      const d = (r.dashboard ?? {}) as Record<string, unknown>;
      if (typeof d !== "object" || Array.isArray(d)) problems.push({ kind: "bad-dashboard-setting", file, key: "port" });
      else {
        if (d.port !== undefined && !(Number.isInteger(d.port) && (d.port as number) > 0 && (d.port as number) < 65536)) {
          problems.push({ kind: "bad-dashboard-setting", file, key: "port" });
        }
        if (d.interval !== undefined && (typeof d.interval !== "string" || durationMs(d.interval) === null)) {
          problems.push({ kind: "bad-dashboard-setting", file, key: "interval" });
        }
      }
    }
  }
  const deliver = (r.deliver ?? {}) as Record<string, unknown>;
  for (const key of ["maxParallel", "maxFixRounds"]) {
    const v = deliver[key];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) > 0)) problems.push({ kind: "bad-deliver-number", file, key });
  }
  return { problems, warnings };
}

async function read(workspace: Workspace, file: string): Promise<{ raw: Raw; problems: ConfigProblem[]; warnings: ConfigWarning[] }> {
  const text = await workspace.readFile(file);
  if (text === null) return { raw: {}, problems: [], warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: {}, problems: [{ kind: "invalid-json", file, detail: (e as Error).message }], warnings: [] };
  }
  const { problems, warnings } = check(file, raw);
  return { raw: problems.length ? {} : (raw as Raw), problems, warnings };
}

export type Loaded = { ok: true; config: Config; warnings: ConfigWarning[] } | { ok: false; refusal: { kind: "config-invalid"; problems: ConfigProblem[] } };

/** Team file, then the developer's local file on top. */
export async function loadConfig(workspace: Workspace): Promise<Loaded> {
  const team = await read(workspace, TEAM_CONFIG);
  const local = await read(workspace, LOCAL_CONFIG);
  const problems = [...team.problems, ...local.problems];
  if (problems.length) return { ok: false, refusal: { kind: "config-invalid", problems } };

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
      staleAfterMs: Math.max(toMs(merged.staleAfter), MIN_STALE_AFTER_MS),
      maxParallel: local.raw.deliver?.maxParallel ?? team.raw.deliver?.maxParallel ?? DEFAULT_TEAM_CONFIG.deliver.maxParallel,
      notifications: channel,
      maxFixRounds: team.raw.deliver?.maxFixRounds ?? DEFAULT_TEAM_CONFIG.deliver.maxFixRounds,
      dashboard: {
        port: local.raw.dashboard?.port ?? null,
        intervalMs: local.raw.dashboard?.interval === undefined ? null : durationMs(local.raw.dashboard.interval),
      },
    },
    warnings: [...team.warnings, ...local.warnings],
  };
}

/** The safety check: a provider named outright must match the environment. */
export function providerRefusal(
  config: Config,
  env: Record<string, string | undefined>,
): { kind: "provider-mismatch"; provider: Provider; variable: string } | null {
  const variable = ENV_FOR[config.provider];
  if (!variable || env[variable] === "1") return null;
  return { kind: "provider-mismatch", provider: config.provider, variable };
}
