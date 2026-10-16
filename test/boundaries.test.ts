import { describe, expect, test } from "vitest";
import { boundaryViolations, type Pkg, readPackages } from "./boundaries.js";

function pkg(name: string, files: Record<string, string>, deps: string[] = []): Pkg {
  const dir = `packages/${name.replace("@shepherd/", "")}`;
  return {
    name,
    dir,
    dependencies: deps,
    files: Object.entries(files).map(([path, source]) => ({ path: `${dir}/src/${path}`, source })),
  };
}

const core = (source = "") => pkg("@shepherd/core", { "index.ts": source });

describe("the layering rules", () => {
  test("core may import node:path and itself, nothing else", () => {
    const res = boundaryViolations([
      pkg("@shepherd/core", {
        "index.ts": 'import { join } from "node:path";\nimport { x } from "./x.js";\nimport { spawn } from "node:child_process";',
        "x.ts": 'export * from "@shepherd/cli";\nconst m = await import("node:fs");',
      }),
      pkg("@shepherd/cli", {}),
    ]);
    expect(res).toEqual([
      "packages/core/src/index.ts → node:child_process: core imports no node: module but node:path",
      "packages/core/src/x.ts → @shepherd/cli: core imports no other package",
      "packages/core/src/x.ts → node:fs: core imports no node: module but node:path",
    ]);
  });

  test("an adapter imports only core", () => {
    const res = boundaryViolations([
      core(),
      pkg("@shepherd/github-gh", { "gh.ts": 'import { spawn } from "node:child_process";\nimport type { GitHub } from "@shepherd/core";' }, ["@shepherd/core"]),
      pkg("@shepherd/workspace-local", { "w.ts": 'import { GhGitHub } from "@shepherd/github-gh";' }, ["@shepherd/core", "@shepherd/github-gh"]),
    ]);
    expect(res).toEqual([
      "packages/workspace-local/src/w.ts → @shepherd/github-gh: an adapter imports only @shepherd/core",
      "packages/workspace-local/package.json → @shepherd/core: declared but never imported",
    ]);
  });

  test("only a front end wires adapters", () => {
    const res = boundaryViolations([
      core(),
      pkg("@shepherd/github-gh", {}, []),
      pkg("@shepherd/cli", { "bin.ts": 'import { GhGitHub } from "@shepherd/github-gh";' }, ["@shepherd/github-gh"]),
      pkg("@shepherd/testing", { "h.ts": 'import { GhGitHub } from "@shepherd/github-gh";' }, ["@shepherd/github-gh"]),
    ]);
    expect(res).toEqual(["packages/testing/src/h.ts → @shepherd/github-gh: only a front end wires adapters"]);
  });

  test("testing is imported only from tests", () => {
    const res = boundaryViolations([
      core(),
      pkg("@shepherd/testing", {}),
      pkg("@shepherd/cli", { "cli.ts": 'import { setup } from "@shepherd/testing";' }, ["@shepherd/testing"]),
    ]);
    expect(res).toEqual(["packages/cli/src/cli.ts → @shepherd/testing: @shepherd/testing is imported only from tests"]);
  });

  test("an internal import is declared in the importer's package.json", () => {
    const res = boundaryViolations([core(), pkg("@shepherd/cli", { "cli.ts": 'import { take } from "@shepherd/core";' })]);
    expect(res).toEqual(["packages/cli/src/cli.ts → @shepherd/core: not declared in packages/cli/package.json"]);
  });

  test("an import after a regex literal is still read", () => {
    // From the core's text.ts: a quick scan loses track in it and misses the import after it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal, not a template
    const sh = "export function sh(word: string) {\n  return /^[A-Za-z0-9_\\-./:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\\\''`)}'`;\n}\n";
    const res = boundaryViolations([core(`${sh}import { readFileSync } from "node:fs";`)]);
    expect(res).toEqual(["packages/core/src/index.ts → node:fs: core imports no node: module but node:path"]);
  });

  test("a relative import stays inside its package", () => {
    const res = boundaryViolations([core(), pkg("@shepherd/cli", { "cli.ts": 'import { take } from "../../core/src/operations.js";' })]);
    expect(res).toEqual(["packages/cli/src/cli.ts → ../../core/src/operations.js: a relative import stays inside its package"]);
  });
});

describe("shepherd's packages", () => {
  test("keep to the layering rules", () => {
    expect(boundaryViolations(readPackages())).toEqual([]);
  });
});
