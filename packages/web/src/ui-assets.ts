import { readFile } from "node:fs/promises";

/** The built UI: one script and one stylesheet. */
export interface UiAssets {
  js: string;
  css: string;
}

/**
 * Reads the UI that `npm run build:ui` wrote to packages/web/ui-dist. The
 * bundled executable never runs this: scripts/build.mjs replaces this module
 * with one that has both files embedded as strings, so there is nothing to
 * locate at runtime. Null when the UI has not been built.
 */
export async function uiAssets(): Promise<UiAssets | null> {
  try {
    const dir = new URL("../ui-dist/", import.meta.url);
    const [js, css] = await Promise.all([readFile(new URL("app.js", dir), "utf8"), readFile(new URL("app.css", dir), "utf8")]);
    return { js, css };
  } catch {
    return null;
  }
}
