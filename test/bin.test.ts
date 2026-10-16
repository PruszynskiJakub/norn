import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "norn-bin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bin", () => {
  test("outside a checkout norn prints why and exits 1, without a stack trace", async () => {
    const bin = join(import.meta.dirname, "..", "packages", "cli", "src", "bin.ts");
    const runner = join(import.meta.dirname, "..", "node_modules", ".bin", "vite-node");
    const res = await promisify(execFile)(runner, [bin, "status", "1"], { cwd: dir }).catch((e) => e);

    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Not inside a git repository's checkout:");
    expect(res.stderr).not.toContain("    at ");
  }, 30_000);
});
