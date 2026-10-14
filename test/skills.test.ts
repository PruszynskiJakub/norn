import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SKILLS } from "../src/init.js";
import { BUNDLED_SKILLS, installSkills } from "../src/install-skills.js";

describe("bundled skills", () => {
  test.each(SKILLS)("%s ships with a SKILL.md named for it", (name) => {
    const md = readFileSync(join(BUNDLED_SKILLS, name, "SKILL.md"), "utf8");
    expect(md).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
  });

  test("installSkills puts every skill into <project>/skills/", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "psdd-skills-"));
    await installSkills(cwd, {});
    for (const name of SKILLS) expect(existsSync(join(cwd, "skills", name, "SKILL.md"))).toBe(true);
  });

  test("installSkills replaces a skill that differs from the package and names it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "psdd-skills-"));
    await installSkills(cwd, {});
    writeFileSync(join(cwd, "skills", "drive", "SKILL.md"), "an older drive");
    writeFileSync(join(cwd, "skills", "deliver", "notes.md"), "a file the package does not have");

    expect(await installSkills(cwd, {})).toEqual(["deliver", "drive"]);
    expect(readFileSync(join(cwd, "skills", "drive", "SKILL.md"), "utf8")).toBe(readFileSync(join(BUNDLED_SKILLS, "drive", "SKILL.md"), "utf8"));
    expect(existsSync(join(cwd, "skills", "deliver", "notes.md"))).toBe(false);
    expect(await installSkills(cwd, {})).toEqual([]);
  });
});

describe("the deliver skill matches what psdd next says", () => {
  test("it does not promise a notification psdd may not have sent", () => {
    const md = readFileSync(join(BUNDLED_SKILLS, "deliver", "SKILL.md"), "utf8");
    expect(md).not.toContain("psdd has already notified the user of anything waiting for them.");
    expect(md).toContain("if notifications are off it says nothing about it");
  });
});
