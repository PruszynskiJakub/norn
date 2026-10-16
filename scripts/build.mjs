// Bundles the CLI into one self-contained dist/bin.js: the workspace packages
// are inlined and only Node's own modules stay external. Typechecking is tsc -b.
import { rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["packages/cli/src/bin.ts"],
  outfile: "dist/bin.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["node:*"],
  logLevel: "warning",
});
