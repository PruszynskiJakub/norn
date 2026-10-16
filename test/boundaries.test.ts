import { describe, expect, test } from "vitest";
import { boundaryViolations, type Pkg, readPackages } from "./boundaries.js";

function pkg(name: string, files: Record<string, string>, deps: string[] = []): Pkg {
  const dir = `packages/${name.replace("@psdd/", "")}`;
  return {
    name,
    dir,
    dependencies: deps,
    files: Object.entries(files).map(([path, source]) => ({ path: `${dir}/src/${path}`, source })),
  };
}

const core = (source = "") => pkg("@psdd/core", { "index.ts": source });

describe("the layering rules", () => {
  test("core may import node:path and itself, nothing else", () => {
    const res = boundaryViolations([
      pkg("@psdd/core", {
        "index.ts": 'import { join } from "node:path";\nimport { x } from "./x.js";\nimport { spawn } from "node:child_process";',
        "x.ts": 'export * from "@psdd/cli";\nconst m = await import("node:fs");',
      }),
      pkg("@psdd/cli", {}),
    ]);
    expect(res).toEqual([
      "packages/core/src/index.ts → node:child_process: core imports no node: module but node:path",
      "packages/core/src/x.ts → @psdd/cli: core imports no other package",
      "packages/core/src/x.ts → node:fs: core imports no node: module but node:path",
    ]);
  });

  test("an adapter imports only core", () => {
    const res = boundaryViolations([
      core(),
      pkg("@psdd/github-gh", { "gh.ts": 'import { spawn } from "node:child_process";\nimport type { GitHub } from "@psdd/core";' }, ["@psdd/core"]),
      pkg("@psdd/workspace-local", { "w.ts": 'import { GhGitHub } from "@psdd/github-gh";' }, ["@psdd/core", "@psdd/github-gh"]),
    ]);
    expect(res).toEqual([
      "packages/workspace-local/src/w.ts → @psdd/github-gh: an adapter imports only @psdd/core",
      "packages/workspace-local/package.json → @psdd/core: declared but never imported",
    ]);
  });

  test("only a front end wires adapters", () => {
    const res = boundaryViolations([
      core(),
      pkg("@psdd/github-gh", {}, []),
      pkg("@psdd/cli", { "bin.ts": 'import { GhGitHub } from "@psdd/github-gh";' }, ["@psdd/github-gh"]),
      pkg("@psdd/testing", { "h.ts": 'import { GhGitHub } from "@psdd/github-gh";' }, ["@psdd/github-gh"]),
    ]);
    expect(res).toEqual(["packages/testing/src/h.ts → @psdd/github-gh: only a front end wires adapters"]);
  });

  test("testing is imported only from tests", () => {
    const res = boundaryViolations([
      core(),
      pkg("@psdd/testing", {}),
      pkg("@psdd/cli", { "cli.ts": 'import { setup } from "@psdd/testing";' }, ["@psdd/testing"]),
    ]);
    expect(res).toEqual(["packages/cli/src/cli.ts → @psdd/testing: @psdd/testing is imported only from tests"]);
  });

  test("an internal import is declared in the importer's package.json", () => {
    const res = boundaryViolations([core(), pkg("@psdd/cli", { "cli.ts": 'import { take } from "@psdd/core";' })]);
    expect(res).toEqual(["packages/cli/src/cli.ts → @psdd/core: not declared in packages/cli/package.json"]);
  });

  test("an import after a regex literal is still read", () => {
    // From the core's text.ts: a quick scan loses track in it and misses the import after it.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source text of a template literal, not a template
    const sh = "export function sh(word: string) {\n  return /^[A-Za-z0-9_\\-./:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\\\''`)}'`;\n}\n";
    const res = boundaryViolations([core(`${sh}import { readFileSync } from "node:fs";`)]);
    expect(res).toEqual(["packages/core/src/index.ts → node:fs: core imports no node: module but node:path"]);
  });

  test("a relative import stays inside its package", () => {
    const res = boundaryViolations([core(), pkg("@psdd/cli", { "cli.ts": 'import { take } from "../../core/src/operations.js";' })]);
    expect(res).toEqual(["packages/cli/src/cli.ts → ../../core/src/operations.js: a relative import stays inside its package"]);
  });
});

describe("psdd's packages", () => {
  test("keep to the layering rules", () => {
    expect(boundaryViolations(readPackages())).toEqual([]);
  });
});
