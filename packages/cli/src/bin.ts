#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { run } from "./cli.js";
import { ghFailureMessage, renderNotification } from "./render-text.js";
import { sessionId } from "./env.js";
import { GhError, GhGitHub } from "@norn/github-gh";
import { installSkills } from "./install-skills.js";
import { LocalWorkspace, makeNotifier, RootError, runCommand } from "@norn/workspace-local";
import { launchDashboard } from "@norn/web";

try {
  const root = await LocalWorkspace.findRoot(process.cwd());
  const show = makeNotifier();
  const res = await run(process.argv.slice(2), {
    github: new GhGitHub(),
    workspace: new LocalWorkspace(root, process.env, runCommand, process.cwd()),
    now: () => new Date(),
    session: sessionId(process.env, hostname(), root),
    nonce: () => randomBytes(2).toString("hex"),
    notify: (channel, notification) => show(channel, renderNotification(notification)),
    cwd: root,
    installSkills,
    dashboard: launchDashboard,
  });
  process.stdout.write(`${res.stdout}\n`);
  process.exitCode = res.exitCode;
} catch (e) {
  if (e instanceof GhError) {
    process.stdout.write(`${ghFailureMessage(process.argv.slice(2), e.message)}\n`);
    process.exitCode = 1;
  } else if (e instanceof RootError) {
    process.stdout.write(`${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
}
