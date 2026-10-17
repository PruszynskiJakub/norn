import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { type Ctx, loadConfig } from "@norn/core";
import { GhGitHub, ghFailure } from "@norn/github-gh";
import { LocalWorkspace, runCommand } from "@norn/workspace-local";
import { serveDashboard } from "./server.js";
import { uiAssets } from "./ui-assets.js";

/** How the CLI asks for a dashboard. */
export interface DashboardOptions {
  /** The main checkout's root. */
  root: string;
  port: number;
  /** The port was asked for outright, so a taken one fails instead of moving on. */
  explicitPort: boolean;
  intervalMs: number;
  open: boolean;
}

export type DashboardLaunch =
  /** Listening at `url`; `opened` when the browser was asked to open it. */
  { kind: "started"; url: string; port: number; opened: boolean } | { kind: "already-running"; url: string } | { kind: "port-taken"; port: number };

/**
 * Starts the dashboard for the checkout at `root`, reading GitHub as the
 * developer through their own gh. The server keeps the process running until
 * it is stopped with Ctrl-C.
 */
export async function launchDashboard(opts: DashboardOptions): Promise<DashboardLaunch> {
  const workspace = new LocalWorkspace(opts.root, process.env, runCommand);
  const loaded = await loadConfig(workspace);
  // The CLI loaded the same files a moment ago and refused on a problem.
  if (!loaded.ok) throw new Error("norn's configuration does not load");
  const ctx: Ctx = {
    github: new GhGitHub(),
    workspace,
    config: loaded.config,
    now: () => new Date(),
    // The dashboard reads only: it takes no claims and sends no notifications.
    session: "dashboard",
    nonce: () => randomBytes(2).toString("hex"),
    machine: hostname(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    notify: async () => {},
    slugs: new Map(),
  };
  const served = await serveDashboard(
    { ctx, root: opts.root, intervalMs: opts.intervalMs, assets: await uiAssets(), failure: ghFailure },
    { port: opts.port, explicit: opts.explicitPort },
  );
  if (served.kind !== "started") return served;
  const { url, port } = served.dashboard;
  return { kind: "started", url, port, opened: opts.open && openBrowser(url) };
}

/** Asks the OS to open url in the default browser; false when there is no way to. */
function openBrowser(url: string): boolean {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    // A machine without a browser opener is no failure: the URL is printed anyway.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
