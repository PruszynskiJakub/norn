// Bundles the CLI into one self-contained dist/bin.js: the workspace packages
// are inlined and only Node's own modules stay external. Typechecking is tsc -b.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const uiDist = resolve("packages/web/ui-dist");
const uiAssetsModule = resolve("packages/web/src/ui-assets.ts");

// The dashboard UI is embedded as strings, so the published package has no
// asset files to locate at runtime. Without a built UI the dashboard would
// serve nothing, so a missing build stops the release here.
function readUi() {
  const files = ["app.js", "app.css"].map((f) => resolve(uiDist, f));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`The dashboard UI is not built: ${missing.join(", ")} missing. Run npm run build:ui -w @psdd/web first (npm run build does).`);
    process.exit(1);
  }
  const [js, css] = files.map((f) => readFileSync(f, "utf8"));
  return { js, css };
}

/** Replaces packages/web/src/ui-assets.ts, which reads ui-dist at dev time, with one returning the files embedded. */
const embedUi = {
  name: "embed-ui",
  setup(b) {
    const ui = readUi();
    b.onLoad({ filter: /[\\/]ui-assets\.ts$/ }, (args) => {
      if (resolve(args.path) !== uiAssetsModule) return undefined;
      return {
        loader: "ts",
        contents: `export async function uiAssets() { return { js: ${JSON.stringify(ui.js)}, css: ${JSON.stringify(ui.css)} }; }\n`,
      };
    });
  },
};

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
  plugins: [embedUi],
});
