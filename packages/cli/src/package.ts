import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The norn package's own directory and manifest, looked up from this module,
 * which runs from packages/cli/src/ in the repository and from dist/ in the
 * built package. Null when no norn package.json is above it.
 */
function findPackage(from: string): { dir: string; version: string } | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name === "norn") return { dir, version };
    }
    if (dirname(dir) === dir) return null;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const found = findPackage(here);

/**
 * The skills shipped inside the norn package: skills/ next to its package.json.
 * Without one, the path the built package has, so init names it when it cannot read it.
 */
export const BUNDLED_SKILLS = found ? join(found.dir, "skills") : join(here, "..", "skills");

/** The running norn's version, from the package that is running. */
export const NORN_VERSION: string = found?.version ?? "0.0.0";
