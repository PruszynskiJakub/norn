import { detectProvider } from "./location.js";
import type { Channel } from "./notify.js";
import type { Provider, Workspace } from "./workspace.js";

export const TEAM_CONFIG = ".agents/norn.config.json";
export const LOCAL_CONFIG = ".agents/norn.config.local.json";

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
  /** How long the agent of a claim norn wait watches may sit idle, done, gone or blocked before norn escalates the item for it. */
  stuckAfterMs: number;
  /** Where notifications go; null when turned off. */
  notifications: Channel | null;
  /** The developer's own dashboard settings; null where they set none. */
  dashboard: { port: number | null; intervalMs: number | null };
  /** The norn version that last set the repository up; null when the team file has none. */
  nornVersion: string | null;
  /** Whether the repository has a team file, i.e. norn init has run. */
  teamFile: boolean;
}

const PROVIDERS = ["auto", "herdr", "claude-code", "git"] as const;
const NOTIFICATIONS = ["auto", "herdr", "os", "none"];
const ENV_FOR: Record<Provider, string | null> = { herdr: "HERDR_ENV", "claude-code": "CLAUDECODE", git: null };
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_STALE_AFTER_MS = 10 * UNITS.m;
/** An agent can sit idle a while at the end of a long tool call without being stuck; ten minutes leaves it room. */
const DEFAULT_STUCK_AFTER = "10m";

function toMs(duration: string) {
  return Number(duration.slice(0, -1)) * UNITS[duration.slice(-1)];
}

/** A duration such as 30s, 2m or 1h in milliseconds; null when it is not one. */
export function durationMs(duration: string): number | null {
  return /^\d+[smhd]$/.test(duration) ? toMs(duration) : null;
}

interface Raw {
  nornVersion?: string;
  baseBranch?: string;
  worktrees?: { provider?: string };
  claims?: { staleAfter?: string };
  deliver?: { maxParallel?: number; maxFixRounds?: number; stuckAfter?: string };
  notifications?: string;
  dashboard?: { port?: number; interval?: string };
}

/** A setting norn cannot use, so it refuses until the file is fixed. */
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
  | { kind: "bad-stuck-after"; file: string }
  | { kind: "dashboard-in-team-file"; file: string; local: string }
  | { kind: "bad-dashboard-setting"; file: string; key: "port" | "interval" }
  | { kind: "norn-version-in-local-file"; file: string; team: string }
  | { kind: "bad-norn-version"; file: string };

/** A setting norn ignores or clamps, and says so. */
export type ConfigWarning =
  | { kind: "stale-after-clamped"; file: string; value: string; minimum: string }
  | { kind: "team-setting-in-local-file"; file: string; setting: string; team: string }
  /** The team file has no nornVersion, so norn cannot tell which version set the repository up. */
  | { kind: "norn-version-missing"; file: string }
  /** The running norn differs from nornVersion, compatibly; `running` is newer or older than `repo`. */
  | { kind: "norn-version-differs"; file: string; running: string; repo: string; direction: "newer" | "older" };

/**
 * Checks one file's settings. Problems make norn refuse; warnings are
 * printed and the setting is ignored or clamped.
 */
function check(file: string, raw: unknown): { problems: ConfigProblem[]; warnings: ConfigWarning[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problems: [{ kind: "not-an-object", file }], warnings: [] };
  const problems: ConfigProblem[] = [];
  const warnings: ConfigWarning[] = [];
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!["nornVersion", "baseBranch", "worktrees", "claims", "deliver", "notifications", "dashboard"].includes(key))
      problems.push({ kind: "unknown-setting", file, key });
  }
  if ("nornVersion" in r) {
    // The version belongs to the committed skills and labels, which are the whole team's.
    if (file === LOCAL_CONFIG) problems.push({ kind: "norn-version-in-local-file", file, team: TEAM_CONFIG });
    else if (typeof r.nornVersion !== "string" || !isVersion(r.nornVersion)) problems.push({ kind: "bad-norn-version", file });
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
  if (deliver.stuckAfter !== undefined && (typeof deliver.stuckAfter !== "string" || durationMs(deliver.stuckAfter) === null)) {
    problems.push({ kind: "bad-stuck-after", file });
  }
  return { problems, warnings };
}

async function read(workspace: Workspace, file: string): Promise<{ raw: Raw; exists: boolean; problems: ConfigProblem[]; warnings: ConfigWarning[] }> {
  const text = await workspace.readFile(file);
  if (text === null) return { raw: {}, exists: false, problems: [], warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: {}, exists: true, problems: [{ kind: "invalid-json", file, detail: (e as Error).message }], warnings: [] };
  }
  const { problems, warnings } = check(file, raw);
  return { raw: problems.length ? {} : (raw as Raw), exists: true, problems, warnings };
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
      stuckAfterMs: toMs(local.raw.deliver?.stuckAfter ?? team.raw.deliver?.stuckAfter ?? DEFAULT_STUCK_AFTER),
      dashboard: {
        port: local.raw.dashboard?.port ?? null,
        intervalMs: local.raw.dashboard?.interval === undefined ? null : durationMs(local.raw.dashboard.interval),
      },
      nornVersion: team.raw.nornVersion ?? null,
      teamFile: team.exists,
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

/** Whether `v` is a plain x.y.z version, the only form nornVersion takes. */
export function isVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function parts(v: string): [number, number, number] {
  const [major, minor, patch] = v.split(".").map(Number);
  return [major, minor, patch];
}

/** Orders two x.y.z versions: negative when a is older, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * How the running norn relates to the repository's nornVersion. Compatible
 * means the same major version, or the same minor version while the major is
 * 0, where minor releases may break things.
 */
export type VersionMatch = { kind: "same" } | { kind: "patch" } | { kind: "newer" | "older"; compatible: boolean };

export function versionMatch(running: string, repo: string): VersionMatch {
  const order = compareVersions(running, repo);
  if (order === 0) return { kind: "same" };
  const [rMajor, rMinor] = parts(running);
  const [pMajor, pMinor] = parts(repo);
  if (rMajor === pMajor && rMinor === pMinor) return { kind: "patch" };
  return { kind: order > 0 ? "newer" : "older", compatible: rMajor === pMajor && rMajor !== 0 };
}

/** The running norn cannot work with the repository's nornVersion. */
export interface VersionIncompatible {
  kind: "version-incompatible";
  running: string;
  repo: string;
  /** The running norn against the repository's version. */
  direction: "newer" | "older";
}

/**
 * Checks the running norn against the repository's nornVersion: silent on a
 * patch difference, a warning on a compatible one or a missing field, and a
 * refusal on an incompatible one. A repository without a team file has never
 * run init, so it is not flagged for it.
 */
export function versionCheck(config: Config, running: string): { warnings: ConfigWarning[]; refusal: VersionIncompatible | null } {
  if (config.nornVersion === null) {
    return { warnings: config.teamFile ? [{ kind: "norn-version-missing", file: TEAM_CONFIG }] : [], refusal: null };
  }
  const repo = config.nornVersion;
  const match = versionMatch(running, repo);
  if (match.kind === "same" || match.kind === "patch") return { warnings: [], refusal: null };
  if (!match.compatible) return { warnings: [], refusal: { kind: "version-incompatible", running, repo, direction: match.kind } };
  return { warnings: [{ kind: "norn-version-differs", file: TEAM_CONFIG, running, repo, direction: match.kind }], refusal: null };
}
