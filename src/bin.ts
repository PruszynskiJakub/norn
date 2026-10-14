#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { run } from "./cli.js";
import { sessionId } from "./env.js";
import { GhError, GhGitHub } from "./gh.js";
import { installSkills } from "./install-skills.js";
import { LocalWorkspace, runCommand } from "./local-workspace.js";
import { makeNotifier } from "./notifier.js";

try {
  const root = await LocalWorkspace.findRoot(process.cwd());
  const res = await run(process.argv.slice(2), {
    github: new GhGitHub(),
    workspace: new LocalWorkspace(root, process.env, runCommand, process.cwd()),
    now: () => new Date(),
    session: sessionId(process.env, hostname(), process.cwd()),
    notify: makeNotifier(),
    headSha: async () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    cwd: root,
    installSkills,
  });
  process.stdout.write(res.stdout + "\n");
  process.exitCode = res.exitCode;
} catch (e) {
  if (e instanceof GhError) {
    process.stdout.write(`GitHub refused the call, so nothing more was done.\n${e.message}\nCheck gh auth status and that you are inside the repository, then retry.\n`);
    process.exitCode = 1;
  } else throw e;
}
