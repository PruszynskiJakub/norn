import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The skills shipped inside the psdd package. */
export const BUNDLED_SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/**
 * Installs psdd's skills into <cwd>/skills/. With PSDD_SKILLS_SOURCE set (a
 * repo the `skills` CLI understands), runs `npx skills add <source>` first;
 * any skill still missing from skills/ is copied from the package.
 */
export async function installSkills(cwd: string, env = process.env): Promise<void> {
  const source = env.PSDD_SKILLS_SOURCE;
  if (source) {
    const r = spawnSync("npx", ["-y", "skills", "add", source], { cwd, stdio: "inherit" });
    if (r.status !== 0) process.stderr.write(`npx skills add ${source} failed; using the skills bundled with psdd.\n`);
  }
  for (const name of readdirSync(BUNDLED_SKILLS)) {
    const target = join(cwd, "skills", name);
    if (!existsSync(join(target, "SKILL.md"))) cpSync(join(BUNDLED_SKILLS, name), target, { recursive: true });
  }
}
