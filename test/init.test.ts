import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS } from "../src/init.js";
import { setup } from "./harness.js";

function project() {
  const w = setup();
  const cwd = mkdtempSync(join(tmpdir(), "psdd-init-"));
  const installs: string[] = [];
  const psdd = w.withProject(cwd, async (dir) => {
    installs.push(dir);
    for (const name of SKILLS) {
      mkdirSync(join(dir, "skills", name), { recursive: true });
      writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
  });
  return { w, cwd, installs, psdd };
}

describe("psdd init", () => {
  test("installs skills into skills/, symlinks them into .claude/skills/, creates .agents/specs/ and the labels", async () => {
    const { w, cwd, installs, psdd } = project();

    const res = await psdd("init");

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
    expect(res.stdout).toContain("psdd is set up");
  });

  test("running it twice is safe", async () => {
    const { psdd } = project();
    await psdd("init");
    const res = await psdd("init");
    expect(res.exitCode).toBe(0);
  });

  test("reports skills the installer did not provide", async () => {
    const w = setup();
    const cwd = mkdtempSync(join(tmpdir(), "psdd-init-"));
    const psdd = w.withProject(cwd, async () => {});
    const res = await psdd("init");
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Missing skills: triage");
  });
});

describe("psdd init: configuration and worktrees", () => {
  test("creates the team config with defaults and gitignores worktrees and the local config", async () => {
    const { cwd, psdd } = project();
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n");

    await psdd("init");

    expect(JSON.parse(readFileSync(join(cwd, ".agents", "psdd.config.json"), "utf8"))).toEqual({
      baseBranch: "main",
      worktrees: { provider: "auto" },
      claims: { staleAfter: "2h" },
      deliver: { maxParallel: 2, maxFixRounds: 3 },
    });
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules\n.agents/worktrees/\n.agents/psdd.config.local.json\n",
    );
  });

  test("keeps an existing team config and does not repeat gitignore entries", async () => {
    const { cwd, psdd } = project();
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(join(cwd, ".agents", "psdd.config.json"), '{ "baseBranch": "develop" }\n');

    await psdd("init");
    await psdd("init");

    expect(readFileSync(join(cwd, ".agents", "psdd.config.json"), "utf8")).toBe('{ "baseBranch": "develop" }\n');
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".agents/worktrees/\n.agents/psdd.config.local.json\n");
  });
});
