/**
 * Measure Excalidraw's fonts for real and write server/font-metrics.json.
 *
 * The server lays text out without a canvas, so it needs the true advance
 * width of every character in every font Excalidraw ships. This opens the
 * headless render page in ?measure=1 mode (src/render.ts) inside Electron -
 * the same Chromium and the same font files the editor uses - and stores what
 * the canvas reports. Re-run after upgrading @excalidraw/excalidraw.
 *
 *   npm run dev            (the page is served by the dev server)
 *   node scripts/measure-fonts.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.env.SKETCHDEX_ORIGIN ?? "http://localhost:5173";
const url = `${origin}/render.html?measure=1`;
const outFile = path.join(os.tmpdir(), `sketchdex-measure-${process.pid}.json`);
const target = path.join(root, "server", "font-metrics.json");

const electron = (await import("electron")).default;
const child = spawn(electron, [path.join(root, "mcp", "render-main.js"), url, outFile], {
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});
const code = await new Promise((resolve) => child.on("exit", resolve));
const result = JSON.parse(await fs.readFile(outFile, "utf8"));
await fs.rm(outFile, { force: true });
if (code !== 0 || result.error || !result.metrics) {
  console.error("measure-fonts failed:", result.error ?? `exit ${code}`);
  process.exit(1);
}

// keep only what the server needs, rounded to keep the file small
const metrics = {};
for (const [id, { name, advance, sample }] of Object.entries(result.metrics)) {
  const compact = {};
  for (const [ch, w] of Object.entries(advance)) compact[ch] = Math.round(w * 10000) / 10000;
  const values = Object.values(compact);
  metrics[id] = {
    name,
    mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10000) / 10000,
    advance: compact,
  };
  // sanity: per-character sums should match the whole-string measurement
  for (const [text, width] of Object.entries(sample)) {
    const sum = [...text].reduce((a, ch) => a + (advance[ch] ?? 0), 0);
    const drift = Math.abs(sum - width) / width;
    if (drift > 0.02) console.warn(`${name}: "${text}" drifts ${(drift * 100).toFixed(1)}% (kerning?)`);
  }
}
await fs.writeFile(target, JSON.stringify(metrics));
console.log(`wrote ${path.relative(root, target)} for ${Object.values(metrics).map((m) => m.name).join(", ")}`);
