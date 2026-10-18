import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { AgentDriver, AgentEnd } from "@norn/cli";

/**
 * A scripted agent as a plain process: `command` runs with `sh -c` in the
 * worktree, as the run's session, its output in the attempt's log. Only for
 * tests that need a real process to exit, crash or hang; norn itself starts
 * every agent in a herdr pane.
 */
export function processDriver(command: (prompt: string, worktree: string) => string, env: Record<string, string> = {}): AgentDriver {
  return {
    async start({ prompt, worktree, session, env: paneEnv, log }) {
      const out = createWriteStream(log, { flags: "a" });
      const child = spawn("sh", ["-c", command(prompt, worktree)], {
        cwd: worktree,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, ...env, ...paneEnv, NORN_SESSION: session },
      });
      let activityAt = Date.now();
      const onData = (d: Buffer) => {
        activityAt = Date.now();
        out.write(d);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const ended = new Promise<AgentEnd>((resolve) => {
        child.on("error", (e) => resolve({ kind: "not-started", detail: e.message }));
        child.on("close", (code, signal) => resolve({ kind: "exited", code, signal }));
      }).finally(() => out.end());
      return {
        pane: null,
        ended: () => ended,
        look: async () => ({ activityAt, blocked: false }),
        // A process's turn is its life: once it exits there is nothing to prompt.
        nudge: async () => false,
        async stop() {
          killGroup(child, "SIGTERM");
          setTimeout(() => killGroup(child, "SIGKILL"), 2000).unref();
          await ended;
        },
      };
    },
  };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
