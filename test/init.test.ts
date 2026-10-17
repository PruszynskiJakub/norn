import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync, existsSync, readFileSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AGENT_INSTRUCTIONS, SKILLS } from "@norn/cli";
import { setup } from "@norn/testing";

function project() {
  const w = setup();
  const cwd = mkdtempSync(join(tmpdir(), "norn-init-"));
  const installs: string[] = [];
  const norn = w.withProject(cwd, async (dir) => {
    installs.push(dir);
    for (const name of SKILLS) {
      mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
      writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return [];
  });
  return { w, cwd, installs, norn };
}

describe("norn init", () => {
  test("installs skills into .agents/skills/, symlinks them into .claude/skills/, creates .agents/specs/ and the labels", async () => {
    const { w, cwd, installs, norn } = project();

    const res = await norn("init");

    expect(res.exitCode).toBe(0);
    expect(installs).toEqual([cwd]);
    for (const name of SKILLS) {
      const link = join(cwd, ".claude", "skills", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join("..", "..", ".agents", "skills", name));
      expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    }
    expect(existsSync(join(cwd, ".agents", "specs"))).toBe(true);
    const labels = [...w.github.labelDefs.keys()];
    for (const l of ["needs-refinement", "merge-queue", "type:story", "type:slice", "in-progress", "needs-human", "mode:afk", "mode:hil"]) {
      expect(labels).toContain(l);
    }
    expect(res.stdout).toContain("norn is set up");
  });

  test("leaves the project's own skills/ alone, norn-named ones included", async () => {
    const { cwd, norn } = project();
    mkdirSync(join(cwd, "skills", "norn-drive"), { recursive: true });
    writeFileSync(join(cwd, "skills", "norn-drive", "SKILL.md"), "the project's own\n");

    const res = await norn("init");

    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(cwd, "skills", "norn-drive", "SKILL.md"), "utf8")).toBe("the project's own\n");
    expect(readlinkSync(join(cwd, ".claude", "skills", "norn-drive"))).toBe(join("..", "..", ".agents", "skills", "norn-drive"));
  });

  test("moves a link an older norn made into skills/ to .agents/skills/, and keeps the project's own", async () => {
    const { cwd, norn } = project();
    mkdirSync(join(cwd, ".claude", "skills", "norn-qa"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "norn-qa", "SKILL.md"), "ours\n");
    symlinkSync(join("..", "..", "skills", "norn-drive"), join(cwd, ".claude", "skills", "norn-drive"), "dir");

    await norn("init");

    expect(readlinkSync(join(cwd, ".claude", "skills", "norn-drive"))).toBe(join("..", "..", ".agents", "skills", "norn-drive"));
    expect(readFileSync(join(cwd, ".claude", "skills", "norn-qa", "SKILL.md"), "utf8")).toBe("ours\n");
  });

  test("running it twice is safe", async () => {
    const { norn } = project();
    await norn("init");
    const res = await norn("init");
    expect(res.exitCode).toBe(0);
  });

  test("names the skills it updated", async () => {
    const w = setup();
    const cwd = mkdtempSync(join(tmpdir(), "norn-init-"));
    const norn = w.withProject(cwd, async (dir) => {
      for (const name of SKILLS) {
        mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
        writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      return ["norn-deliver", "norn-drive"];
    });

    const res = await norn("init");

    expect(res.stdout).toContain("  - updated to this norn version: norn-deliver, norn-drive (git diff .agents/skills/ shows the changes)");
  });

  test("reports skills the installer did not provide", async () => {
    const w = setup();
    const cwd = mkdtempSync(join(tmpdir(), "norn-init-"));
    const norn = w.withProject(cwd, async () => []);
    const res = await norn("init");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Missing skills: norn-triage");
  });
});

/** A bug flow with a coloured state and one with no colour or description, which takes the default of its kind. */
const BUG = {
  description: "A defect: reproduce it, fix it, close it.",
  start: "reproducing",
  workspace: "none",
  states: {
    reproducing: { skill: "bug-repro", attended: true, outcomes: { reproduced: { to: "fixing", means: "reproduced" } } },
    fixing: { skill: "bug-fix", attended: false, color: "123456", description: "Being fixed", outcomes: { fixed: { to: "closed", means: "fixed" } } },
  },
};

describe("norn init: labels from the flows", () => {
  test("creates every state and type:<flow> of the repository's flows on the base branch, with the defaults of a state's kind", async () => {
    const { w, cwd, norn } = project();
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "norn.config.json"), JSON.stringify({ baseBranch: "develop" }));
    w.github.seedFlow("bug", BUG, "develop");

    const res = await norn("init");

    expect(res.exitCode).toBe(0);
    expect(w.github.labelDefs.get("reproducing")).toEqual({ color: "c5def5", description: "a person takes part in this step (norn)" });
    expect(w.github.labelDefs.get("fixing")).toEqual({ color: "123456", description: "Being fixed (norn)" });
    expect(w.github.labelDefs.get("type:bug")).toEqual({ color: "ededed", description: "Runs the bug flow (norn)" });
    expect(w.github.labelDefs.get("needs-review")).toEqual({ color: "5319e7", description: "Waiting for review (norn)" });
    expect(res.stdout).toContain(`  - ${w.github.labelDefs.size} labels on the repository`);
  });

  test("a repository flow that replaces a built-in one gives its states instead", async () => {
    const { w, norn } = project();
    w.github.seedFlow("slice", { ...BUG, workspace: "parent", triage: false });

    await norn("init");

    expect(w.github.labelDefs.has("reproducing")).toBe(true);
    expect(w.github.labelDefs.has("blocked")).toBe(false);
    expect(w.github.labelDefs.has("type:slice")).toBe(true);
  });

  test("skips an invalid flow and still creates the others' labels", async () => {
    const { w, norn } = project();
    w.github.seedFlow("bug", { ...BUG, start: "nowhere" });

    const res = await norn("init");

    expect(res.exitCode).toBe(0);
    expect(w.github.labelDefs.has("reproducing")).toBe(false);
    expect(w.github.labelDefs.has("type:bug")).toBe(false);
    expect(w.github.labelDefs.has("needs-refinement")).toBe(true);
  });
});

describe("norn init: configuration and worktrees", () => {
  test("creates the team config with defaults and gitignores worktrees and the local config", async () => {
    const { cwd, norn } = project();
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

    await norn("init");

    expect(JSON.parse(readFileSync(join(cwd, ".agents", "norn.config.json"), "utf8"))).toEqual({
      nornVersion: "1.4.2",
      baseBranch: "main",
      worktrees: { provider: "auto" },
      claims: { staleAfter: "2h" },
      deliver: { maxParallel: 2, maxFixRounds: 3 },
    });
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.agents/worktrees/\n.agents/norn.config.local.json\n");
  });

  test("the base branch is the repository's default branch", async () => {
    const { w, cwd, norn } = project();
    w.github.defaultBranchName = "master";

    await norn("init");

    expect(JSON.parse(readFileSync(join(cwd, ".agents", "norn.config.json"), "utf8")).baseBranch).toBe("master");
  });

  test("keeps an existing team config, only recording the norn version, and does not repeat gitignore entries", async () => {
    const { cwd, norn } = project();
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "norn.config.json"), '{ "nornVersion": "1.4.2", "baseBranch": "develop" }\n');

    await norn("init");
    await norn("init");

    expect(readFileSync(join(cwd, ".agents", "norn.config.json"), "utf8")).toBe('{ "nornVersion": "1.4.2", "baseBranch": "develop" }\n');
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".agents/worktrees/\n.agents/norn.config.local.json\n");
  });
});

describe("norn init: agent instructions", () => {
  test("with no AGENTS.md or CLAUDE.md, creates AGENTS.md with the norn block and a CLAUDE.md that imports it", async () => {
    const { cwd, norn } = project();

    const res = await norn("init");

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`${AGENT_INSTRUCTIONS}\n`);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(res.stdout).toContain("norn-drive <issue>");
  });

  test("appends the block to an existing CLAUDE.md and keeps what was there", async () => {
    const { cwd, norn } = project();
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project\n\nUse tabs.\n");

    await norn("init");

    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(`# Project\n\nUse tabs.\n\n${AGENT_INSTRUCTIONS}\n`);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  test("replaces an earlier norn block instead of adding a second one", async () => {
    const { cwd, norn } = project();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n\n<!-- norn:start -->\nold\n<!-- norn:end -->\n\nMore.\n");

    await norn("init");
    await norn("init");

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENT_INSTRUCTIONS}\n\nMore.\n`);
  });

  test("leaves a CLAUDE.md that imports AGENTS.md alone", async () => {
    const { cwd, norn } = project();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "@AGENTS.md\n");

    await norn("init");

    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENT_INSTRUCTIONS}\n`);
  });
});
