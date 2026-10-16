import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AGENT_INSTRUCTIONS, SKILLS } from "@shepherd/cli";
import { setup } from "@shepherd/testing";

function project() {
  const w = setup();
  const cwd = mkdtempSync(join(tmpdir(), "shepherd-init-"));
  const installs: string[] = [];
  const shepherd = w.withProject(cwd, async (dir) => {
    installs.push(dir);
    for (const name of SKILLS) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    return [];
  });
  return { w, cwd, installs, shepherd };
}

describe("shepherd init", () => {
  test("installs skills into skills/, symlinks them into .claude/skills/, creates .agents/specs/ and the labels", async () => {
    const { w, cwd, installs, shepherd } = project();

    const res = await shepherd("init");

    expect(res.exitCode).toBe(0);
    expect(installs).toEqual([cwd]);
    for (const name of SKILLS) {
      const link = join(cwd, ".claude", "skills", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join("..", "..", "skills", name));
      expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain(`name: ${name}`);
    }
    expect(existsSync(join(cwd, ".agents", "specs"))).toBe(true);
    const labels = [...w.github.labelDefs.keys()];
    for (const l of ["needs-refinement", "merge-queue", "type:story", "type:slice", "in-progress", "needs-human", "mode:afk", "mode:hil"]) {
      expect(labels).toContain(l);
    }
    expect(res.stdout).toContain("shepherd is set up");
  });

  test("running it twice is safe", async () => {
    const { shepherd } = project();
    await shepherd("init");
    const res = await shepherd("init");
    expect(res.exitCode).toBe(0);
  });

  test("names the skills it updated", async () => {
    const w = setup();
    const cwd = mkdtempSync(join(tmpdir(), "shepherd-init-"));
    const shepherd = w.withProject(cwd, async (dir) => {
      for (const name of SKILLS) {
        mkdirSync(join(dir, "skills", name), { recursive: true });
        writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      return ["deliver", "drive"];
    });

    const res = await shepherd("init");

    expect(res.stdout).toContain("  - updated to this shepherd version: deliver, drive (git diff skills/ shows the changes)");
  });

  test("reports skills the installer did not provide", async () => {
    const w = setup();
    const cwd = mkdtempSync(join(tmpdir(), "shepherd-init-"));
    const shepherd = w.withProject(cwd, async () => []);
    const res = await shepherd("init");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Missing skills: triage");
  });
});

describe("shepherd init: configuration and worktrees", () => {
  test("creates the team config with defaults and gitignores worktrees and the local config", async () => {
    const { cwd, shepherd } = project();
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

    await shepherd("init");

    expect(JSON.parse(readFileSync(join(cwd, ".agents", "shepherd.config.json"), "utf8"))).toEqual({
      baseBranch: "main",
      worktrees: { provider: "auto" },
      claims: { staleAfter: "2h" },
      deliver: { maxParallel: 2, maxFixRounds: 3 },
    });
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.agents/worktrees/\n.agents/shepherd.config.local.json\n");
  });

  test("the base branch is the repository's default branch", async () => {
    const { w, cwd, shepherd } = project();
    w.github.defaultBranchName = "master";

    await shepherd("init");

    expect(JSON.parse(readFileSync(join(cwd, ".agents", "shepherd.config.json"), "utf8")).baseBranch).toBe("master");
  });

  test("keeps an existing team config and does not repeat gitignore entries", async () => {
    const { cwd, shepherd } = project();
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "shepherd.config.json"), '{ "baseBranch": "develop" }\n');

    await shepherd("init");
    await shepherd("init");

    expect(readFileSync(join(cwd, ".agents", "shepherd.config.json"), "utf8")).toBe('{ "baseBranch": "develop" }\n');
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".agents/worktrees/\n.agents/shepherd.config.local.json\n");
  });
});

describe("shepherd init: agent instructions", () => {
  test("with no AGENTS.md or CLAUDE.md, creates AGENTS.md with the shepherd block and a CLAUDE.md that imports it", async () => {
    const { cwd, shepherd } = project();

    const res = await shepherd("init");

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`${AGENT_INSTRUCTIONS}\n`);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(res.stdout).toContain("drive <issue>");
  });

  test("appends the block to an existing CLAUDE.md and keeps what was there", async () => {
    const { cwd, shepherd } = project();
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project\n\nUse tabs.\n");

    await shepherd("init");

    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(`# Project\n\nUse tabs.\n\n${AGENT_INSTRUCTIONS}\n`);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  test("replaces an earlier shepherd block instead of adding a second one", async () => {
    const { cwd, shepherd } = project();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n\n<!-- shepherd:start -->\nold\n<!-- shepherd:end -->\n\nMore.\n");

    await shepherd("init");
    await shepherd("init");

    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENT_INSTRUCTIONS}\n\nMore.\n`);
  });

  test("leaves a CLAUDE.md that imports AGENTS.md alone", async () => {
    const { cwd, shepherd } = project();
    writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "@AGENTS.md\n");

    await shepherd("init");

    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(`# Agents\n\n${AGENT_INSTRUCTIONS}\n`);
  });
});
