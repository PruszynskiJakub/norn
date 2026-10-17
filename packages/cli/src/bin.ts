#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { runsOutsideCheckout } from "./args.js";
import { run } from "./cli.js";
import { ghFailureMessage, renderNotification } from "./render-text.js";
import { sessionId } from "./env.js";
import { GhError, GhGitHub } from "@norn/github-gh";
import { installSkills } from "./install-skills.js";
import { BUNDLED_SKILLS, NORN_VERSION } from "./package.js";
import { LocalWorkspace, makeNotifier, RootError, runCommand } from "@norn/workspace-local";
import { launchDashboard } from "@norn/web";

const argv = process.argv.slice(2);

/**
 * The main checkout's root. Outside one, only doctor, --version and --help run: doctor
 * reports why as its git check, from where norn was started.
 */
async function findRoot(): Promise<{ root: string; checkoutProblem: string | null }> {
  try {
    return { root: await LocalWorkspace.findRoot(process.cwd()), checkoutProblem: null };
  } catch (e) {
    if (e instanceof RootError && runsOutsideCheckout(argv)) return { root: process.cwd(), checkoutProblem: e.message };
    throw e;
  }
}

try {
  const { root, checkoutProblem } = await findRoot();
  const show = makeNotifier();
  const res = await run(argv, {
    github: new GhGitHub(),
    workspace: new LocalWorkspace(root, process.env, runCommand, process.cwd()),
    now: () => new Date(),
    session: sessionId(process.env, hostname(), root),
    nonce: () => randomBytes(2).toString("hex"),
    notify: (channel, notification) => show(channel, renderNotification(notification)),
    cwd: root,
    installSkills,
    dashboard: launchDashboard,
    version: NORN_VERSION,
    bundledSkills: BUNDLED_SKILLS,
    checkoutProblem,
  });
  process.stdout.write(`${res.stdout}\n`);
  process.exitCode = res.exitCode;
} catch (e) {
  if (e instanceof GhError) {
    process.stdout.write(`${ghFailureMessage(argv, e.message)}\n`);
    process.exitCode = 1;
  } else if (e instanceof RootError) {
    process.stdout.write(`${e.message}\n`);
    process.exitCode = 1;
  } else throw e;
}
