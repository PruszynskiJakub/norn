import { type Ctx, durationMs } from "@psdd/core";
import type { DashboardLaunch, DashboardOptions } from "@psdd/web";

export const DEFAULT_DASHBOARD_PORT = 4477;
export const DEFAULT_DASHBOARD_INTERVAL_MS = 2 * 60_000;
/** Reading GitHub more often than this competes with the agents for the rate limit. */
export const DASHBOARD_INTERVAL_FLOOR_MS = 30_000;

/** Starts the dashboard: given the options, it answers where it runs. */
export type StartDashboard = (opts: DashboardOptions) => Promise<DashboardLaunch>;

export interface DashboardResult {
  ok: true;
  kind: "dashboard";
  launch: Exclude<DashboardLaunch, { kind: "port-taken" }>;
  /** The port asked for; the launch's differs when it was taken. */
  port: number;
  intervalMs: number;
  /** The interval asked for, when it was below the floor and raised to it; as given, e.g. 10s. */
  raisedFrom: string | null;
}

export type DashboardRefusal = { kind: "port-taken"; port: number } | { kind: "bad-dashboard-flag"; flag: "port" | "interval" };

/** psdd dashboard: works out port and interval from the flags and the local config, then starts it. */
export async function dashboard(
  ctx: Ctx & { dashboard: StartDashboard },
  flags: Record<string, string[]>,
  bools: Set<string>,
): Promise<DashboardResult | { ok: false; refusal: DashboardRefusal }> {
  const portFlag = flags.port?.[0];
  if (portFlag !== undefined && !(/^\d+$/.test(portFlag) && Number(portFlag) > 0 && Number(portFlag) < 65536)) {
    return { ok: false, refusal: { kind: "bad-dashboard-flag", flag: "port" } };
  }
  const intervalFlag = flags.interval?.[0];
  const flagMs = intervalFlag === undefined ? null : durationMs(intervalFlag);
  if (intervalFlag !== undefined && flagMs === null) return { ok: false, refusal: { kind: "bad-dashboard-flag", flag: "interval" } };

  const port = portFlag !== undefined ? Number(portFlag) : (ctx.config.dashboard.port ?? DEFAULT_DASHBOARD_PORT);
  const asked = flagMs ?? ctx.config.dashboard.intervalMs ?? DEFAULT_DASHBOARD_INTERVAL_MS;
  const intervalMs = Math.max(asked, DASHBOARD_INTERVAL_FLOOR_MS);
  const raisedFrom = asked < DASHBOARD_INTERVAL_FLOOR_MS ? (intervalFlag ?? `${asked / 1000}s`) : null;
  const launch = await ctx.dashboard({ root: ctx.workspace.root, port, explicitPort: portFlag !== undefined, intervalMs, open: !bools.has("no-open") });
  if (launch.kind === "port-taken") return { ok: false, refusal: launch };
  return { ok: true, kind: "dashboard", launch, port, intervalMs, raisedFrom };
}
