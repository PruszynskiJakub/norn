#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { run } from "./cli.js";
import { sessionId } from "./env.js";
import { GhError, GhGitHub } from "./gh.js";
import { installSkills } from "./install-skills.js";

const cwd = process.cwd();

try {
  const res = await run(process.argv.slice(2), {
    github: new GhGitHub(),
    now: () => new Date(),
    session: sessionId(process.env, hostname(), cwd),
    headSha: async () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    cwd,
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
