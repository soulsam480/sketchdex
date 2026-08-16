import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Turn a scene into a PNG that matches what the editor draws.
 *
 * The library thumbnails are SVG squeezed into a card, which is why their
 * strokes read as heavier or lighter than the real thing. This runs Excalidraw's
 * own canvas export in a hidden Electron window instead, at real size.
 *
 * Ports: if the dev server is already up on 5173 this uses it and opens nothing
 * of its own - render.html is part of the same build and reads the scene through
 * the normal /api routes. Only when nothing is running does it fall back to a
 * throwaway static server on an ephemeral port, which exists for the length of
 * one screenshot. So: normally no extra port at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dist = path.join(repo, "dist");

const DEV_PORTS = [5173, 4173];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let building = null;

/** The render page is part of the normal build; build once if it is missing. */
const ensureBuild = async () => {
  const entry = path.join(dist, "render.html");
  if (await fs.access(entry).then(() => true, () => false)) return;
  if (!building) {
    building = new Promise((resolve, reject) => {
      const child = spawn("npm", ["run", "build"], {
        cwd: repo,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`build failed:\n${stderr.slice(-800)}`)),
      );
    }).finally(() => {
      building = null;
    });
  }
  return building;
};

/**
 * A dev server already serving *this* vault, if there is one.
 *
 * The vault has to match. A running server serves whichever vault it was
 * started with, so borrowing one that points somewhere else would render a
 * different scene that happens to share an id space - or nothing at all.
 *
 * Both hosts get tried because Vite binds ::1 only, so a 127.0.0.1 probe
 * reports "nothing running" while the app is plainly running.
 */
const findRunningServer = async (vault) => {
  for (const port of DEV_PORTS) {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const origin = `http://${host}:${port}`;
      const served = await fetch(`${origin}/api/vault`, {
        signal: AbortSignal.timeout(500),
      })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      if (served?.vault === vault) return origin;
      if (served) break; // something is on this port, but not our vault
    }
  }
  return null;
};

/** Fallback when nothing is running: serve dist/ and the scene, briefly. */
const startTempServer = async (payload) => {
  await ensureBuild();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__payload") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(payload);
    }
    const rel = url.pathname === "/" ? "/render.html" : url.pathname;
    const file = path.join(dist, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

/**
 * @param scene   the payload from agent.readScene, with `files` included
 * @param options scale, maxWidth, dark
 */
export async function renderScene(
  scene,
  {
    scale = 1,
    maxWidth = 1400,
    dark = false,
    region = null,
    ids = null,
    tiles = 1,
    inlineLimit = 150_000,
  } = {},
) {
  const running = await findRunningServer(scene.vault);
  let temp = null;
  let origin = running;

  if (!origin) {
    temp = await startTempServer(
      JSON.stringify({
        elements: scene.elements,
        appState: scene.appState,
        files: scene.files ?? {},
      }),
    );
    origin = temp.origin;
  }

  const query = new URLSearchParams({
    scale: String(scale),
    maxWidth: String(maxWidth),
    dark: dark ? "1" : "0",
    inlineLimit: String(inlineLimit),
    tiles: String(tiles > 1 ? tiles : 1),
  });
  // against a live server the page fetches the scene itself, by id
  if (running) query.set("scene", scene.id);
  if (ids?.length) query.set("only", ids.join(","));
  if (region) {
    const { x = 0, y = 0, width = 0, height = 0 } = region;
    query.set("region", [x, y, width, height].join(","));
  }

  const dir = path.join(os.tmpdir(), "sketchdex-renders");
  await fs.mkdir(dir, { recursive: true });
  // the child answers through a file, not stdout: see render-main.js
  const outFile = path.join(dir, `.result-${process.pid}-${Date.now()}.json`);

  const electron = (await import("electron")).default;
  const child = spawn(
    electron,
    [path.join(here, "render-main.js"), `${origin}/render.html?${query}`, outFile],
    { cwd: repo, stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const code = await new Promise((resolve) => child.on("close", resolve));
    const raw = await fs.readFile(outFile, "utf8").catch(() => "");
    if (!raw) {
      throw new Error(`render process exited ${code}\n${stderr.slice(-500)}`);
    }
    const shot = JSON.parse(raw);
    if (shot.error) throw new Error(shot.error);

    /**
     * Always written to a file, not only when it is too big to inline. A caller
     * that hits the transport's message limit needs somewhere to go, and a path
     * that sometimes exists is worse than one that always does.
     */
    const safe = String(scene.name ?? "scene").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
    const stamp = `${safe}-${scene.id.slice(0, 8)}`;
    const unpack = async (image, suffix) => {
      const base64 = image.dataUrl.split(",")[1];
      const bytes = Buffer.from(base64, "base64");
      const file = path.join(dir, `${stamp}-${image.width}px${suffix}.png`);
      await fs.writeFile(file, bytes);
      return {
        base64,
        path: file,
        bytes: bytes.length,
        width: image.width,
        height: image.height,
        // present only when the full image was too large to travel inline
        preview: image.preview
          ? {
              base64: image.preview.dataUrl.split(",")[1],
              width: image.preview.width,
              height: image.preview.height,
              mime: image.preview.mime ?? "image/jpeg",
            }
          : null,
      };
    };

    if (shot.tiles) {
      const out = [];
      for (const [i, tile] of shot.tiles.entries()) {
        out.push({ ...(await unpack(tile, `-tile${i + 1}`)), region: tile.region });
      }
      return { tiles: out, width: shot.width, height: shot.height };
    }
    if (!shot.dataUrl) throw new Error("render produced nothing");
    return unpack(shot, "");
  } finally {
    child.kill();
    temp?.server.close();
    await fs.rm(outFile, { force: true }).catch(() => {});
  }
}
