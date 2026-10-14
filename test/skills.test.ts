import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
});

describe("the deliver skill matches what psdd next says", () => {
  test("it does not promise a notification psdd may not have sent", () => {
    const md = readFileSync(join(BUNDLED_SKILLS, "deliver", "SKILL.md"), "utf8");
    expect(md).not.toContain("psdd has already notified the user of anything waiting for them.");
    expect(md).toContain("if notifications are off it says nothing about it");
  });
});
