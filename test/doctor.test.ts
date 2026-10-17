import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS } from "@norn/cli";
import { setup } from "@norn/testing";

const TEAM = ".agents/norn.config.json";
const LOCAL = ".agents/norn.config.local.json";

function skillDir(root: string, name: string, body = `---\nname: ${name}\n---\n`) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), body);
}

/**
 * A repository norn init has set up: skills installed and linked, the agent
 * instructions written, labels created and the team file in place. norn 1.4.2
 * runs, with skills bundled identical to the installed ones.
 */
async function healthy() {
  const w = setup({ version: "1.4.2" });
  const cwd = mkdtempSync(join(tmpdir(), "norn-doctor-"));
  const bundled = mkdtempSync(join(tmpdir(), "norn-bundled-"));
  for (const name of SKILLS) skillDir(bundled, name);
  const install = async (dir: string) => {
    for (const name of SKILLS) skillDir(join(dir, ".agents", "skills"), name);
    return [];
  };
  const init = await w.withProject(cwd, install)("init");
  expect(init.exitCode).toBe(0);
  w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "1.4.2", baseBranch: "main" }));
  const norn = w.withDeps({ cwd, installSkills: install, bundledSkills: bundled });
  return { w, cwd, bundled, norn };
}

/** A bug flow: reproduce, fix, close. Its skills are the team's own, not norn's. */
function bugFlow(over: Record<string, unknown> = {}) {
  return {
    description: "A defect: reproduce it, fix it, close it.",
    start: "reproducing",
    workspace: "none",
    states: {
      reproducing: { skill: "bug-repro", attended: true, outcomes: { reproduced: { to: "fixing", means: "reproduced" } } },
      fixing: { skill: "bug-fix", attended: false, outcomes: { fixed: { to: "closed", means: "fixed" } } },
    },
    ...over,
  };
}

/** The check lines and their fix lines, without the summary. */
function lines(stdout: string) {
  return stdout.split("\n\n")[0].split("\n");
}

async function json(norn: (...argv: string[]) => Promise<{ stdout: string }>) {
  return JSON.parse((await norn("doctor", "--json")).stdout) as {
    ok: boolean;
    checks: { id: string; level: string; message: string; fix: string | null }[];
  };
}

async function check(norn: (...argv: string[]) => Promise<{ stdout: string }>, id: string) {
  return (await json(norn)).checks.find((c) => c.id === id);
}

describe("norn doctor on a healthy setup", () => {
  test("reports every check as ok and exits 0", async () => {
    const { norn } = await healthy();

    const res = await norn("doctor");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      [
        "✓ gh: logged in to github.com",
        "✓ git: origin is git@github.com:acme/app.git",
        "✓ base-branch: main exists on GitHub",
        "✓ permission: you have write access to the repository",
        "✓ labels: all 19 of norn's labels exist",
        "✓ flows: all 2 flows are valid: story, slice; story makes slices of type slice",
        "✓ config: the team and local config are valid",
        "✓ version: norn 1.4.2, repo 1.4.2",
        "✓ skills: all 16 skills are in .agents/skills/ and linked from .claude/skills/",
        "✓ agent-instructions: the norn block is in AGENTS.md",
        "✓ provider: claude-code matches the environment",
        "",
        "Everything norn needs is set up.",
      ].join("\n"),
    );
  });

  test("--json gives { ok, checks } with an id, level, message and fix per check", async () => {
    const { norn } = await healthy();

    const body = await json(norn);

    expect(body.ok).toBe(true);
    expect(Object.keys(body)).toEqual(["ok", "checks"]);
    expect(body.checks.map((c) => c.id)).toEqual([
      "gh",
      "git",
      "base-branch",
      "permission",
      "labels",
      "flows",
      "config",
      "version",
      "skills",
      "agent-instructions",
      "provider",
    ]);
    expect(body.checks[0]).toEqual({ id: "gh", level: "ok", message: "logged in to github.com", fix: null });
  });

  test("asks gh about the host origin is on", async () => {
    const { w, norn } = await healthy();
    w.workspace.origin = "https://github.example.com/acme/app.git";
    w.github.ghHosts = ["github.example.com"];

    expect(lines((await norn("doctor")).stdout).slice(0, 2)).toEqual([
      "✓ gh: logged in to github.example.com",
      "✓ git: origin is https://github.example.com/acme/app.git",
    ]);
  });

  test("changes nothing", async () => {
    const { w, norn } = await healthy();
    w.github.labelDefs.delete("blocked");
    const before = structuredClone([...w.github.labelDefs]);

    await norn("doctor");

    expect([...w.github.labelDefs]).toEqual(before);
    expect(w.github.claims.size).toBe(0);
  });
});

describe("norn doctor: gh and git", () => {
  test("gh not installed fails, and every GitHub check is skipped as needing it", async () => {
    const { w, norn } = await healthy();
    w.github.ghAuthState = { kind: "missing" };

    const res = await norn("doctor");

    expect(res.exitCode).toBe(1);
    expect(lines(res.stdout).slice(0, 6)).toEqual([
      "✗ gh: gh is not installed",
      "  fix: install gh from https://cli.github.com, then run gh auth login",
      "✓ git: origin is git@github.com:acme/app.git",
      "- base-branch: skipped, needs gh",
      "- permission: skipped, needs gh",
      "- labels: skipped, needs gh",
    ]);
    expect(res.stdout.split("\n").at(-1)).toBe("1 check failed. Run the fixes above, then norn doctor again.");
  });

  test("gh logged out says how to log in to the host", async () => {
    const { w, norn } = await healthy();
    w.github.ghAuthState = { kind: "logged-out" };

    expect(await check(norn, "gh")).toEqual({
      id: "gh",
      level: "fail",
      message: "gh is not logged in to github.com",
      fix: "gh auth login --hostname github.com",
    });
  });

  test("a gh error is a failed check, not a refusal", async () => {
    const { w, norn } = await healthy();
    w.github.ghAuth = async () => {
      throw new Error("gh exploded");
    };

    const res = await norn("doctor");

    expect(res.exitCode).toBe(1);
    expect(lines(res.stdout)[0]).toBe("✗ gh: gh failed: gh exploded");
  });

  test("a checkout without origin fails git, and GitHub checks are skipped as needing it", async () => {
    const { w, norn } = await healthy();
    w.workspace.origin = null;

    const body = await json(norn);

    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.id === "git")).toEqual({
      id: "git",
      level: "fail",
      message: "this checkout has no origin remote",
      fix: "git remote add origin <the repository's GitHub URL>",
    });
    expect(body.checks.find((c) => c.id === "permission")).toEqual({ id: "permission", level: "skipped", message: "skipped, needs git", fix: null });
    expect(body.checks.find((c) => c.id === "config")?.level).toBe("ok");
  });

  test("origin on a host that is not GitHub fails git", async () => {
    const { w, norn } = await healthy();
    w.workspace.origin = "git@gitlab.com:acme/app.git";

    expect(await check(norn, "git")).toMatchObject({ level: "fail", message: "origin git@gitlab.com:acme/app.git is not on GitHub" });
  });

  test("outside a checkout git fails with the reason, and the checks that need a checkout are skipped", async () => {
    const { w, norn } = await healthy();
    const outside = w.withDeps({ checkoutProblem: "Not inside a git repository's checkout: /tmp/x" });
    void norn;

    const res = await outside("doctor");

    expect(res.exitCode).toBe(1);
    expect(lines(res.stdout)).toEqual([
      "✓ gh: logged in to github.com",
      "✗ git: Not inside a git repository's checkout: /tmp/x",
      "  fix: cd into the repository's checkout and run norn doctor there",
      "- base-branch: skipped, needs git",
      "- permission: skipped, needs git",
      "- labels: skipped, needs git",
      "- flows: skipped, needs git",
      "- config: skipped, needs git",
      "- version: skipped, needs git",
      "- skills: skipped, needs git",
      "- agent-instructions: skipped, needs git",
      "- provider: skipped, needs git",
    ]);
  });
});

describe("norn doctor: the repository on GitHub", () => {
  test("a baseBranch missing on GitHub fails", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "1.4.2", baseBranch: "develop" }));

    expect(await check(norn, "base-branch")).toEqual({
      id: "base-branch",
      level: "fail",
      message: "baseBranch develop does not exist on GitHub",
      fix: `set baseBranch in ${TEAM} to a branch that exists on GitHub, e.g. main`,
    });
  });

  test.each(["admin", "maintain", "write"] as const)("%s access is enough", async (permission) => {
    const { w, norn } = await healthy();
    w.github.permissionLevel = permission;
    expect(await check(norn, "permission")).toMatchObject({ level: "ok", message: `you have ${permission} access to the repository` });
  });

  test.each(["triage", "read", "none"] as const)("%s access fails: norn needs write", async (permission) => {
    const { w, norn } = await healthy();
    w.github.permissionLevel = permission;
    expect(await check(norn, "permission")).toEqual({
      id: "permission",
      level: "fail",
      message: `you have ${permission === "none" ? "no" : permission} access to the repository; norn needs write or higher`,
      fix: "ask an admin of the repository for write access",
    });
  });

  test("missing labels fail, named, with norn init as the fix", async () => {
    const { w, norn } = await healthy();
    w.github.labelDefs.delete("blocked");
    w.github.labelDefs.delete("mode:hil");

    expect(await check(norn, "labels")).toEqual({
      id: "labels",
      level: "fail",
      message: "2 of norn's labels are missing: blocked, mode:hil",
      fix: "norn init",
    });
  });
});

describe("norn doctor: labels from the flows", () => {
  test("the labels of a repository flow on the base branch are norn's labels too", async () => {
    const { w, norn } = await healthy();
    w.github.seedFlow("bug", bugFlow());

    expect(await check(norn, "labels")).toEqual({
      id: "labels",
      level: "fail",
      message: "3 of norn's labels are missing: reproducing, fixing, type:bug",
      fix: "norn init",
    });
  });

  test("labels no flow uses warn, and stay on the repository", async () => {
    const { w, norn } = await healthy();
    w.github.seedFlow("slice", { ...bugFlow(), workspace: "parent", triage: false });
    await w.github.ensureLabels(["reproducing", "fixing", "type:chore", "bug"].map((name) => ({ name, color: "ededed", description: "" })));

    expect(await check(norn, "labels")).toEqual({
      id: "labels",
      level: "warning",
      message: "all 19 of norn's labels exist; no flow uses blocked, ready-for-agent, type:chore",
      fix: "delete these labels on GitHub once no issue needs them; norn never deletes a label",
    });
    expect(w.github.labelDefs.has("blocked")).toBe(true);
  });

  test("a label norn made for a state a flow has since removed counts as one no flow uses; a team's own label does not", async () => {
    const { w, norn } = await healthy();
    const triaging = { skill: "bug-triage", attended: true, outcomes: { triaged: { to: "reproducing", means: "triaged" } } };
    w.github.seedFlow("bug", bugFlow({ start: "triaging", states: { ...bugFlow().states, triaging } }));
    // Triage puts a new issue into the flow's start, creating its label as norn does.
    w.github.seedIssue({ number: 7, title: "Crash" });
    await w.norn("take", "7");
    await w.norn("done", "7", "bug");
    w.github.seedFlow("bug", bugFlow());
    await w.github.ensureLabels(["reproducing", "fixing"].map((name) => ({ name, color: "ededed", description: "" })));
    await w.github.ensureLabels([{ name: "frontend", color: "ededed", description: "The web app" }]);

    const labels = await check(norn, "labels");

    expect(labels).toMatchObject({ level: "warning" });
    expect(labels?.message).toContain("no flow uses triaging");
    expect(labels?.message).not.toContain("frontend");
  });

  test("a label a local flow edit uses is not one no flow uses, as the flows check reads that edit too", async () => {
    const { w, cwd, norn } = await healthy();
    w.github.seedFlow("bug", bugFlow());
    for (const name of ["bug-repro", "bug-fix"]) skillDir(join(cwd, "skills"), name);
    await w.github.ensureLabels(
      ["reproducing", "fixing", "type:bug", "triaging"].map((name) => ({ name, color: "ededed", description: "Made by norn (norn)" })),
    );
    const triaging = { skill: "bug-repro", attended: true, outcomes: { triaged: { to: "reproducing", means: "triaged" } } };
    localFlow(cwd, "bug", bugFlow({ start: "triaging", states: { ...bugFlow().states, triaging } }));

    const labels = await check(norn, "labels");

    expect(labels?.message).not.toContain("triaging");
  });

  test("norn marks the description of every label it creates as norn's", async () => {
    const { w } = await healthy();

    expect([...w.github.labelDefs.values()].every((l) => l.description.endsWith(" (norn)"))).toBe(true);
  });

  test("a label a flow renamed counts as one no flow uses", async () => {
    const { w, norn } = await healthy();
    w.github.seedFlow("bug", bugFlow({ renamed: { triaging: "reproducing" } }));
    await w.github.ensureLabels(["reproducing", "fixing", "type:bug", "triaging"].map((name) => ({ name, color: "ededed", description: "" })));

    expect(await check(norn, "labels")).toMatchObject({ level: "warning", message: "all 22 of norn's labels exist; no flow uses triaging" });
  });
});

/** Writes a flow into the checkout's working copy, as a team lead editing it before the PR. */
function localFlow(cwd: string, name: string, flow: unknown) {
  mkdirSync(join(cwd, ".agents", "flows"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "flows", `${name}.json`), typeof flow === "string" ? flow : JSON.stringify(flow, null, 2));
}

/** A healthy setup with the bug flow merged, its skills installed and its labels created. */
async function withBugFlow(over: Record<string, unknown> = {}) {
  const h = await healthy();
  h.w.github.seedFlow("bug", bugFlow(over));
  for (const name of ["bug-repro", "bug-fix"]) skillDir(join(h.cwd, "skills"), name);
  await h.w.github.ensureLabels(["reproducing", "fixing", "type:bug"].map((name) => ({ name, color: "ededed", description: "" })));
  return h;
}

describe("norn doctor: flows", () => {
  test("the flows in effect are valid, and the skills they name installed", async () => {
    const { norn } = await withBugFlow();

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "ok",
      message: "all 3 flows are valid: story, slice, bug; story makes slices of type slice",
      fix: null,
    });
  });

  test("the labels a local flow edit needs that the repository lacks warn, with how they get made", async () => {
    const { cwd, norn } = await withBugFlow();
    const triaging = { skill: "bug-repro", attended: true, outcomes: { triaged: { to: "reproducing", means: "triaged" } } };
    localFlow(cwd, "bug", bugFlow({ start: "triaging", states: { ...bugFlow().states, triaging } }));

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "warning",
      message: "Labels the local flows need are not on GitHub yet: triaging (bug in this checkout).",
      fix: "norn creates each one when an issue first gets it; to create them up front, run norn init once the change is merged",
    });
  });

  test("an invalid flow on the base branch fails, with every problem and the file to fix", async () => {
    const { w, norn } = await withBugFlow();
    w.github.seedFlow("bug", bugFlow({ start: "nowhere", workspace: "elsewhere" }));

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "fail",
      message: [
        "2 problems:",
        '    - .agents/flows/bug.json on main: The field workspace must be "none", "own" or "parent".',
        "    - .agents/flows/bug.json on main: start names nowhere, which is not one of its states.",
      ].join("\n"),
      fix: "fix .agents/flows/bug.json and merge it into main",
    });
  });

  test("a flow file whose name cannot name a type fails, on the base branch and in the checkout, instead of being skipped", async () => {
    const { w, cwd, norn } = await withBugFlow();
    w.github.seedFile(".agents/flows/Bug-Fix.json", JSON.stringify(bugFlow()));
    localFlow(cwd, "Chore", bugFlow());

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "fail",
      message: [
        "2 problems:",
        "    - .agents/flows/Bug-Fix.json on main: its name cannot name a type, so norn reads no flow from it. A flow's name is lowercase letters, digits, - and _.",
        "    - .agents/flows/Chore.json in this checkout: its name cannot name a type, so norn reads no flow from it. A flow's name is lowercase letters, digits, - and _.",
      ].join("\n"),
      fix: "rename .agents/flows/Bug-Fix.json, e.g. to .agents/flows/bug-fix.json; rename .agents/flows/Chore.json, e.g. to .agents/flows/chore.json",
    });
  });

  test("every problem of a flow is reported at once, the flows its behaviours name included, a misspelt behaviour with its likely name", async () => {
    const { cwd, norn } = await withBugFlow();
    localFlow(cwd, "epic", {
      ...bugFlow({ workspace: "own" }),
      states: {
        reproducing: {
          skill: "bug-repro",
          attended: true,
          behaviours: { slices: { type: "tsk" }, syncBlocked: { to: "fixing" }, waitsForSlices: { to: "nowhere" } },
          outcomes: { done: { to: "closed", means: "done" } },
        },
      },
    });

    const message = (await check(norn, "flows"))?.message ?? "";

    expect(message.split("\n")).toEqual([
      "3 problems:",
      "    - .agents/flows/epic.json in this checkout: The state reproducing uses the behaviour syncBlocked, which norn does not have; did you mean syncsBlocked?",
      "    - .agents/flows/epic.json in this checkout: The parameter to of the behaviour waitsForSlices of the state reproducing must be a state of the flow.",
      "    - .agents/flows/epic.json in this checkout: The behaviour slices of reproducing names the flow tsk, which the repository does not have.",
    ]);
  });

  test("an invalid flow in the working copy fails before it is merged", async () => {
    const { cwd, norn } = await withBugFlow();
    localFlow(cwd, "chore", "{ not json");

    const found = await check(norn, "flows");

    expect(found?.level).toBe("fail");
    expect(found?.message).toMatch(/^\.agents\/flows\/chore\.json in this checkout: It is not valid JSON: /);
    expect(found?.fix).toBe("fix .agents/flows/chore.json, then run norn doctor again");
  });

  test("a working copy the same as the base branch is reported once", async () => {
    const { w, cwd, norn } = await withBugFlow();
    const broken = bugFlow({ start: "nowhere" });
    w.github.seedFlow("bug", broken);
    localFlow(cwd, "bug", broken);

    expect((await check(norn, "flows"))?.message).toBe(".agents/flows/bug.json on main: start names nowhere, which is not one of its states.");
  });

  test("a local flow naming a slice type only the working copy has is valid", async () => {
    const { w, cwd, norn } = await withBugFlow();
    await w.github.ensureLabels(["type:task", "type:epic"].map((name) => ({ name, color: "ededed", description: "" })));
    localFlow(cwd, "task", { ...bugFlow(), workspace: "parent", triage: false });
    localFlow(cwd, "epic", {
      ...bugFlow({ workspace: "own" }),
      states: {
        reproducing: { skill: "bug-repro", attended: true, behaviours: { slices: { type: "task" } }, outcomes: { done: { to: "closed", means: "done" } } },
      },
    });

    const found = await check(norn, "flows");

    expect(found?.level).toBe("ok");
    expect(found?.message).toContain("; epic in this checkout makes slices of type task");
  });

  test("a skill a flow names that is not installed fails", async () => {
    const { cwd, norn } = await withBugFlow();
    rmSync(join(cwd, "skills", "bug-fix"), { recursive: true });
    localFlow(cwd, "chore", {
      ...bugFlow(),
      states: { tidying: { skill: "chore-do", attended: false, outcomes: { done: { to: "closed", means: "done" } } } },
      start: "tidying",
    });

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "fail",
      message: [
        "2 problems:",
        "    - Skills the flows name are not installed: bug-fix (bug, fixing), chore-do (chore in this checkout, tidying).",
        "    - Labels the local flows need are not on GitHub yet: tidying (chore in this checkout), type:chore (chore in this checkout).",
      ].join("\n"),
      fix: "add the skills to .claude/skills/, or to skills/ or .agents/skills/ linked from .claude/skills/; norn creates each one when an issue first gets it; to create them up front, run norn init once the change is merged",
    });
  });

  test("lists the open issues the working copy would orphan, as a warning", async () => {
    const { w, cwd, norn } = await withBugFlow();
    w.github.seedIssue({ number: 12, title: "Crash", labels: ["type:bug", "fixing"] });
    w.github.seedIssue({ number: 13, title: "Hang", labels: ["type:bug", "reproducing"] });
    w.github.seedIssue({ number: 14, title: "Old", labels: ["type:bug", "fixing"], state: "closed" });
    localFlow(cwd, "bug", {
      ...bugFlow(),
      states: { reproducing: { skill: "bug-repro", attended: true, outcomes: { fixed: { to: "closed", means: "fixed" } } } },
    });

    expect(await check(norn, "flows")).toEqual({
      id: "flows",
      level: "warning",
      message: "The local .agents/flows/bug.json would orphan #12 (fixing): its state is gone, so it would go to needs-human.",
      fix: "name the new state of each removed one in renamed in .agents/flows/bug.json, or move these issues on first",
    });
  });

  test("a removed state the working copy renames orphans nothing", async () => {
    const { w, cwd, norn } = await withBugFlow();
    w.github.seedIssue({ number: 12, title: "Crash", labels: ["type:bug", "fixing"] });
    await w.github.ensureLabels([{ name: "repairing", color: "ededed", description: "" }]);
    localFlow(cwd, "bug", {
      ...bugFlow(),
      renamed: { fixing: "repairing" },
      states: {
        reproducing: { skill: "bug-repro", attended: true, outcomes: { reproduced: { to: "repairing", means: "reproduced" } } },
        repairing: { skill: "bug-fix", attended: false, outcomes: { fixed: { to: "closed", means: "fixed" } } },
      },
    });

    expect(await check(norn, "flows")).toMatchObject({ level: "ok" });
  });

  test("a local flow replacing a built-in one is compared with the built-in", async () => {
    const { w, cwd, norn } = await withBugFlow();
    w.github.seedIssue({ number: 21, title: "A slice", labels: ["type:slice", "blocked"] });
    localFlow(cwd, "slice", { ...bugFlow(), workspace: "parent", triage: false });

    expect((await check(norn, "flows"))?.message).toBe(
      "The local .agents/flows/slice.json would orphan #21 (blocked): its state is gone, so it would go to needs-human.",
    );
  });

  test("changes nothing", async () => {
    const { w, cwd, norn } = await withBugFlow();
    w.github.seedIssue({ number: 12, title: "Crash", labels: ["type:bug", "fixing"] });
    localFlow(cwd, "bug", {
      ...bugFlow(),
      states: { reproducing: { skill: "bug-repro", attended: true, outcomes: { fixed: { to: "closed", means: "fixed" } } } },
    });
    const before = structuredClone([...w.github.issues]);

    await norn("doctor");

    expect([...w.github.issues]).toEqual(before);
    expect(w.github.claims.size).toBe(0);
  });
});

describe("norn doctor: config and version", () => {
  test("config problems fail the config check, and the checks that need a config are skipped", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(LOCAL, JSON.stringify({ nornVersion: "1.4.2", notifications: "loud" }));

    const res = await norn("doctor");

    expect(res.exitCode).toBe(1);
    const out = lines(res.stdout);
    expect(out).toContain(
      `✗ config: ${LOCAL}: nornVersion is the team's; norn init sets it in ${TEAM}; ${LOCAL}: notifications must be one of auto, herdr, os, none`,
    );
    expect(out).toContain("  fix: edit the config files as described, then run norn doctor again");
    expect(out).toContain("- base-branch: skipped, needs config");
    expect(out).toContain("- version: skipped, needs config");
    expect(out).toContain("- provider: skipped, needs config");
  });

  test("config warnings warn, and only warnings exit 0", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(LOCAL, JSON.stringify({ claims: { staleAfter: "1h" } }));

    const res = await norn("doctor");

    expect(res.exitCode).toBe(0);
    expect(lines(res.stdout)).toContain(`! config: ${LOCAL}: claims.staleAfter is shared by the team, so norn ignores it here; set it in ${TEAM}`);
    expect(res.stdout.split("\n").at(-1)).toBe("Nothing failed, but 1 check warned. Run the fixes above when you can.");
    expect((await json(norn)).ok).toBe(true);
  });

  test("a missing nornVersion warns", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(TEAM, JSON.stringify({ baseBranch: "main" }));
    expect(await check(norn, "version")).toEqual({ id: "version", level: "warning", message: "norn 1.4.2, repo has no nornVersion", fix: "norn init" });
  });

  test("a compatible difference warns, with the fix for its direction", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "1.2.0" }));
    expect(await check(norn, "version")).toEqual({ id: "version", level: "warning", message: "norn 1.4.2, repo 1.2.0", fix: "norn init" });

    w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "1.5.0" }));
    expect(await check(norn, "version")).toEqual({
      id: "version",
      level: "warning",
      message: "norn 1.4.2, repo 1.5.0",
      fix: "npm install -D github:PruszynskiJakub/norn#v1.5.0",
    });
  });

  test("an incompatible version fails, and doctor still runs every check", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "2.0.0" }));

    const body = await json(norn);

    expect(body.ok).toBe(false);
    expect(body.checks.find((c) => c.id === "version")).toEqual({
      id: "version",
      level: "fail",
      message: "norn 1.4.2, repo 2.0.0: not compatible",
      fix: "npm install -D github:PruszynskiJakub/norn#v2.0.0",
    });
    expect(body.checks.filter((c) => c.level === "fail")).toHaveLength(1);
  });

  test("a patch difference is ok", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(TEAM, JSON.stringify({ nornVersion: "1.4.0" }));
    expect(await check(norn, "version")).toMatchObject({ level: "ok", message: "norn 1.4.2, repo 1.4.0" });
  });
});

describe("norn doctor: skills, instructions and provider", () => {
  test("a skill missing from .agents/skills/ or not linked from .claude/skills/ fails", async () => {
    const { cwd, norn } = await healthy();
    rmSync(join(cwd, ".agents", "skills", "norn-qa"), { recursive: true });
    rmSync(join(cwd, ".claude", "skills", "norn-tdd"));

    expect(await check(norn, "skills")).toEqual({
      id: "skills",
      level: "fail",
      message: "missing from .agents/skills/: norn-qa; not linked from .claude/skills/: norn-tdd",
      fix: "norn init",
    });
  });

  test("a skill that differs from the bundled copy warns", async () => {
    const { cwd, norn } = await healthy();
    writeFileSync(join(cwd, ".agents", "skills", "norn-drive", "SKILL.md"), "edited\n");

    const res = await norn("doctor");

    expect(res.exitCode).toBe(0);
    expect(lines(res.stdout)).toContain("! skills: differ from the skills bundled with this norn: norn-drive");
    expect(lines(res.stdout)).toContain("  fix: norn init");
  });

  test("under NORN_SKILLS_SOURCE drift from the bundled skills is not checked", async () => {
    const { w, cwd, norn } = await healthy();
    w.workspace.env = { ...w.workspace.env, NORN_SKILLS_SOURCE: "acme/skills" };
    writeFileSync(join(cwd, ".agents", "skills", "norn-drive", "SKILL.md"), "ours\n");

    expect(await check(norn, "skills")).toMatchObject({
      level: "ok",
      message: "all 16 skills are in .agents/skills/ and linked from .claude/skills/ (from NORN_SKILLS_SOURCE, so not compared with the bundled ones)",
    });
  });

  test("no norn block in AGENTS.md or CLAUDE.md fails", async () => {
    const { cwd, norn } = await healthy();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");

    expect(await check(norn, "agent-instructions")).toEqual({
      id: "agent-instructions",
      level: "fail",
      message: "neither AGENTS.md nor CLAUDE.md has the norn block",
      fix: "norn init",
    });
  });

  test("a provider that does not match the environment fails, as take would refuse", async () => {
    const { w, norn } = await healthy();
    w.workspace.files.set(LOCAL, JSON.stringify({ worktrees: { provider: "herdr" } }));

    expect(await check(norn, "provider")).toEqual({
      id: "provider",
      level: "fail",
      message: "the worktree provider is herdr, but HERDR_ENV is not set",
      fix: `start norn from a herdr pane, or set worktrees.provider in ${LOCAL}`,
    });
  });
});

describe("pointers to norn doctor", () => {
  test("norn lists doctor and --version in its usage", async () => {
    const { stdout } = await setup().norn();
    expect(stdout).toContain("norn doctor");
    expect(stdout).toContain("norn --version");
  });
});

describe("norn doctor: one root cause, one failure", () => {
  test("without gh, an Enterprise origin is not also called off GitHub", async () => {
    const { w, norn } = await healthy();
    w.workspace.origin = "git@github.example.com:acme/app.git";
    w.github.ghAuthState = { kind: "missing" };

    const body = await json(norn);

    expect(body.checks.find((c) => c.id === "gh")?.level).toBe("fail");
    expect(body.checks.find((c) => c.id === "git")?.level).toBe("ok");
    expect(body.checks.filter((c) => c.level === "fail")).toHaveLength(1);
  });
});
