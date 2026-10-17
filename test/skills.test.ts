import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BUNDLED_SKILLS, installSkills, SKILLS } from "@norn/cli";

describe("bundled skills", () => {
  test.each(SKILLS)("%s ships with a SKILL.md named for it", (name) => {
    const md = readFileSync(join(BUNDLED_SKILLS, name, "SKILL.md"), "utf8");
    expect(md).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
  });

  test("installSkills puts every skill into <project>/.agents/skills/", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norn-skills-"));
    await installSkills(cwd, {});
    for (const name of SKILLS) expect(existsSync(join(cwd, ".agents", "skills", name, "SKILL.md"))).toBe(true);
  });

  test("installSkills replaces a skill that differs from the package and names it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "norn-skills-"));
    await installSkills(cwd, {});
    writeFileSync(join(cwd, ".agents", "skills", "norn-drive", "SKILL.md"), "an older drive");
    writeFileSync(join(cwd, ".agents", "skills", "norn-deliver", "notes.md"), "a file the package does not have");

    expect(await installSkills(cwd, {})).toEqual(["norn-deliver", "norn-drive"]);
    expect(readFileSync(join(cwd, ".agents", "skills", "norn-drive", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(BUNDLED_SKILLS, "norn-drive", "SKILL.md"), "utf8"),
    );
    expect(existsSync(join(cwd, ".agents", "skills", "norn-deliver", "notes.md"))).toBe(false);
    expect(await installSkills(cwd, {})).toEqual([]);
  });
});

describe("the norn-deliver skill matches what norn next says", () => {
  test("it does not promise a notification norn may not have sent", () => {
    const md = readFileSync(join(BUNDLED_SKILLS, "norn-deliver", "SKILL.md"), "utf8");
    expect(md).not.toContain("norn has already notified the user of anything waiting for them.");
    expect(md).toContain("if notifications are off it says nothing about it");
  });
});

describe("the norn-deliver skill is the short loop around norn deliver, norn wait and norn tidy", () => {
  const md = () => readFileSync(join(BUNDLED_SKILLS, "norn-deliver", "SKILL.md"), "utf8");

  test("it takes the delivery lock first, tidies on every turn and waits with norn wait, by its exit codes", () => {
    const loop = md().slice(md().indexOf("## Loop"), md().indexOf("## Rules"));
    expect(loop.indexOf("norn deliver <story>")).toBeLessThan(loop.indexOf("norn tidy"));
    expect(loop.indexOf("norn tidy")).toBeLessThan(loop.indexOf("norn next <story>"));
    expect(loop).toContain("Run `norn wait <story>` in the background");
    expect(loop).toContain("**0**: something new can start. Go back to step 2.");
    expect(loop).toContain("**3**: nothing is left that you can do. Run `norn tidy`");
    expect(loop).toContain("**4**: it timed out. Run `norn wait <story>` again.");
    expect(loop).not.toContain("herdr agent wait");
  });

  test("it forbids scripts around norn, matching its text, and typing into panes other than with herdr agent prompt", () => {
    expect(md()).toContain("Never write a monitor, a script or a sleep loop around norn, and never decide what to do by matching norn's text");
    expect(md()).toContain("Type into an agent's pane only with `herdr agent prompt`.");
  });

  test("its report lists the items norn escalated for stuck agents, with their panes", () => {
    expect(md()).toContain("each item norn escalated because its agent stopped, with the agent's pane");
  });
});

describe("the process skills hint at what they take", () => {
  test.each([
    ["norn-drive", "<issue | story | slice>"],
    ["norn-deliver", "<story>"],
  ])("%s takes %s", (name, hint) => {
    const md = readFileSync(join(BUNDLED_SKILLS, name, "SKILL.md"), "utf8");
    expect(md).toMatch(new RegExp(`^---\\n(?:.*\\n)*?argument-hint: "${hint.replace(/[|]/g, "\\|")}"\\n(?:.*\\n)*?---\\n`));
  });
});
