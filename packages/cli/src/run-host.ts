import { spawn } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { SUPERVISE } from "./cli.js";
import { herdrCli } from "./herdr.js";
import { type RunHost, supervisorEnv } from "./supervise.js";

/** This machine as norn run and norn deliver use it: the herdr CLI, a shell, and detached supervisor processes. */
export function localRunHost(root: string, env: Record<string, string | undefined>): RunHost {
  return {
    herdr: herdrCli(env),
    shell: (command, cwd) =>
      new Promise((resolve) => {
        const child = spawn("sh", ["-c", command], { cwd, env, stdio: "ignore" });
        child.on("error", () => resolve(127));
        child.on("close", (code) => resolve(code ?? 1));
      }),
    async startSupervisor(s) {
      const out = openSync(s.log, "a");
      // Detached, in a process group of its own, so it outlives the norn that started it.
      const child = spawn(process.execPath, [process.argv[1], SUPERVISE, String(s.issue), String(s.story), s.session, s.agent, s.worktree], {
        cwd: root,
        detached: true,
        stdio: ["ignore", out, out],
        env: supervisorEnv(env),
      });
      closeSync(out);
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => resolve(child.pid ?? 0));
        child.once("error", reject);
      });
      child.unref();
      return pid;
    },
    print: (line) => process.stdout.write(`${line}\n`),
    // The file norn runs from, executable on its own: the agents of its runs use this norn, whatever norn is on their PATH.
    norn: realpathSync(process.argv[1]),
  };
}
