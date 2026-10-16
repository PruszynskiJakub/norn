import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import ts from "typescript";

/**
 * The layering rules between psdd's packages, checked from the imports in
 * their sources. Each package's package.json dependencies are the allowlist.
 */

export interface Pkg {
  name: string;
  /** Relative to the repository root, e.g. packages/core. */
  dir: string;
  dependencies: string[];
  files: { path: string; source: string }[];
}

const CORE = "@psdd/core";
const TESTING = "@psdd/testing";
const ADAPTERS = ["@psdd/github-gh", "@psdd/workspace-local"];
/** Packages that wire adapters to the core: the CLI and the dashboard now, later the runner, dispatcher and MCP server. */
const FRONT_ENDS = ["@psdd/cli", "@psdd/web"];

const ROOT = join(import.meta.dirname, "..");

/**
 * Every specifier a file imports: static imports, `export … from` and dynamic
 * `import()`. From a full parse: ts.preProcessFile's quick scan loses track
 * after some regex literals and misses the imports that follow.
 */
function importsOf(source: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, false));
  return out;
}

/** The package a specifier names, e.g. @psdd/core for @psdd/core/x; null for a relative one. */
function packageOf(specifier: string): string | null {
  if (specifier.startsWith(".")) return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The rule an import breaks, or null. */
function broken(pkg: Pkg, file: string, specifier: string): string | null {
  const target = packageOf(specifier);
  if (target === null) {
    const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
    return resolved.startsWith(`${pkg.dir}/`) ? null : "a relative import stays inside its package";
  }
  if (target === pkg.name) return null;
  if (pkg.name === CORE) {
    if (specifier.startsWith("node:")) return specifier === "node:path" ? null : "core imports no node: module but node:path";
    return "core imports no other package";
  }
  if (specifier.startsWith("node:")) return null;
  if (ADAPTERS.includes(pkg.name) && target !== CORE) return `an adapter imports only ${CORE}`;
  if (ADAPTERS.includes(target) && !FRONT_ENDS.includes(pkg.name)) return "only a front end wires adapters";
  if (target === TESTING) return `${TESTING} is imported only from tests`;
  if (!pkg.dependencies.includes(target)) return `not declared in ${pkg.dir}/package.json`;
  return null;
}

/** Each violation as `file → specifier: rule broken`, package by package. */
export function boundaryViolations(pkgs: Pkg[]): string[] {
  const out: string[] = [];
  for (const pkg of pkgs) {
    const used = new Set<string>();
    for (const { path, source } of pkg.files) {
      for (const specifier of importsOf(source)) {
        const target = packageOf(specifier);
        if (target) used.add(target);
        const rule = broken(pkg, path, specifier);
        if (rule) out.push(`${path} → ${specifier}: ${rule}`);
      }
    }
    for (const dep of pkg.dependencies) {
      if (dep.startsWith("@psdd/") && !used.has(dep)) out.push(`${pkg.dir}/package.json → ${dep}: declared but never imported`);
    }
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** psdd's packages as they are on disk. */
export function readPackages(): Pkg[] {
  return readdirSync(join(ROOT, "packages")).map((name) => {
    const dir = join(ROOT, "packages", name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return {
      name: manifest.name,
      dir: relative(ROOT, dir),
      dependencies: Object.keys(manifest.dependencies ?? {}),
      files: sources(join(dir, "src")).map((f) => ({ path: relative(ROOT, f), source: readFileSync(f, "utf8") })),
    };
  });
}
