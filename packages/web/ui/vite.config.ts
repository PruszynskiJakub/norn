// Builds the dashboard UI into exactly ui-dist/app.js and ui-dist/app.css: the
// server serves its own HTML shell, and scripts/build.mjs embeds both files
// into the CLI bundle by those names, so there is no index.html and no hash.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// biome-ignore lint/style/noDefaultExport: Vite reads its configuration from the default export.
export default defineConfig({
  root: here("."),
  plugins: [react(), tailwindcss()],
  publicDir: false,
  build: {
    outDir: here("../ui-dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: {
      input: here("src/main.tsx"),
      output: {
        entryFileNames: "app.js",
        assetFileNames: (asset) => (asset.names.some((n) => n.endsWith(".css")) ? "app.css" : "[name][extname]"),
      },
    },
  },
});
