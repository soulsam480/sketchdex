import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error plain JS, runs in the vite process
import { sketchdexStore } from "./server/middleware.js";

export default defineConfig({
  // sketchdexStore serves /api/* from the vault folder on disk
  // (~/Documents/sketchdex, override with SKETCHDEX_VAULT)
  plugins: [react(), tailwindcss(), sketchdexStore()],
  build: {
    rollupOptions: {
      input: {
        // the app, plus the headless page mcp/render.js loads to turn a scene
        // into a real PNG (see src/render.ts)
        main: "index.html",
        render: "render.html",
      },
    },
  },
  define: {
    // required by @excalidraw/excalidraw when bundled outside its own repo
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
});
