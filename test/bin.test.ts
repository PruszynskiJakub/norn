import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "norn-bin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bin = join(import.meta.dirname, "..", "packages", "cli", "src", "bin.ts");
const runner = join(import.meta.dirname, "..", "node_modules", ".bin", "vite-node");
const norn = (...argv: string[]) =>
  promisify(execFile)(runner, [bin, ...argv], { cwd: dir }).catch((e) => e) as Promise<{ code?: number; stdout: string; stderr: string }>;

describe("bin", () => {
  test("outside a checkout norn prints why and exits 1, without a stack trace", async () => {
    const res = await norn("status", "1");

    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Not inside a git repository's checkout:");
    expect(res.stderr).not.toContain("    at ");
  }, 30_000);

  test("outside a checkout norn doctor still runs: git fails with the reason, and what needs a checkout is skipped", async () => {
    const res = await norn("doctor");

    expect(res.code).toBe(1);
    expect(res.stdout).toContain("✗ git: Not inside a git repository's checkout:");
    expect(res.stdout).toContain("- config: skipped, needs git");
    expect(res.stdout).toContain("- skills: skipped, needs git");
    expect(res.stderr).not.toContain("    at ");
  }, 30_000);

  test("norn --version prints the version of the package that runs, outside a checkout too", async () => {
    const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    const res = await norn("--version");
    expect(res.code ?? 0).toBe(0);
    expect(res.stdout).toBe(`${version}\n`);
  }, 30_000);
});
