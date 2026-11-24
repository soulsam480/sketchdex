import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: process.env.SKETCHDEX_SERVER_ORIGIN ?? "http://127.0.0.1:5174", changeOrigin: true },
      "/mcp": { target: process.env.SKETCHDEX_SERVER_ORIGIN ?? "http://127.0.0.1:5174", changeOrigin: true },
    },
  },
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
