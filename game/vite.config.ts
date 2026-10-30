import { defineConfig } from "vite";

// The game is a static site: game/dist is published at /openworld/game/ on GitHub Pages.
export default defineConfig({
  root: "game",
  base: "./",
  publicDir: "public",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 900 },
});
