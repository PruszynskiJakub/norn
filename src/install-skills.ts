import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The skills shipped inside the psdd package. */
export const BUNDLED_SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

/**
 * Installs psdd's skills into <cwd>/skills/ and returns the names of those it
 * updated. With PSDD_SKILLS_SOURCE set (a repo the `skills` CLI understands),
 * runs `npx skills add <source>` first, and that source owns the skills: only
 * missing ones are copied from the package. Otherwise a skill that differs
 * from the package is replaced, so upgrading psdd and running init again
 * brings its skills along; skills/ is committed, so git shows what changed.
 */
export async function installSkills(cwd: string, env = process.env): Promise<string[]> {
  const source = env.PSDD_SKILLS_SOURCE;
  if (source) {
    const r = spawnSync("npx", ["-y", "skills", "add", source], { cwd, stdio: "inherit" });
    if (r.status !== 0) process.stderr.write(`npx skills add ${source} failed; using the skills bundled with psdd.\n`);
  }
  const updated: string[] = [];
  for (const name of readdirSync(BUNDLED_SKILLS)) {
    const bundled = join(BUNDLED_SKILLS, name);
    const target = join(cwd, "skills", name);
    if (existsSync(join(target, "SKILL.md"))) {
      if (source || sameTree(bundled, target)) continue;
      rmSync(target, { recursive: true, force: true });
      updated.push(name);
    }
    cpSync(bundled, target, { recursive: true });
  }
  return updated;
}

/** Whether two directories hold the same files with the same contents. */
function sameTree(a: string, b: string) {
  const fa = files(a);
  const fb = files(b);
  return fa.length === fb.length && fa.every((f, i) => f === fb[i] && readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

function files(dir: string, root = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((e) => (statSync(join(dir, e)).isDirectory() ? files(join(dir, e), root) : [relative(root, join(dir, e))]));
}
