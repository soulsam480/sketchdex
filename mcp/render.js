import http from "node:http";
import fs from "node:fs/promises";
import fsSync, { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Turn a scene into a PNG that matches what the editor draws.
 *
 * The library thumbnails are SVG squeezed into a card, which is why their
 * strokes read as heavier or lighter than the real thing. This runs Excalidraw's
 * own canvas export in a hidden browser window instead, at real size.
 *
 * Which browser: SKETCHDEX_BROWSER must point at a Chromium-based browser
 * binary. There is no discovery, so the same path works on every machine.
 *
 * Ports: if the dev server is already up on 5173 the page is loaded from it and
 * reads the scene through the normal /api routes. Otherwise a throwaway server
 * on an ephemeral port serves dist/ and the scene for the length of one render.
 * Either way a throwaway server carries the result back: the page POSTs its
 * image to /__result, which is what lets any headless browser work without a
 * debugging protocol.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dist = path.join(repo, "dist");

const DEV_PORTS = [5173, 4173];
const DEADLINE = 60_000;
const RENDER_DIR = path.join(os.tmpdir(), "sketchdex-renders");
const KEEP_FOR = 24 * 60 * 60 * 1000;

/**
 * Browsers this process has launched and not yet reaped. A worker that is
 * killed mid-render (client gone, or a reload in a checkout) never reaches
 * the `finally` below, so they are also killed from the exit hook.
 */
const liveBrowsers = new Set();
process.on("exit", () => {
  for (const { child, profile } of liveBrowsers) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    if (profile) fsSync.rmSync(profile, { recursive: true, force: true });
  }
});

/** Renders and spilled results are written for the caller to read; they are not kept. */
let pruned = false;
const pruneOldOutput = async () => {
  if (pruned) return;
  pruned = true;
  const names = await fs.readdir(RENDER_DIR).catch(() => []);
  const cutoff = Date.now() - KEEP_FOR;
  for (const name of names) {
    const file = path.join(RENDER_DIR, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
  }
};

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

/* ─── browser configuration ─────────────────────────────────────────── */

/** @returns {{ kind: "chromium", bin: string } | null} */
const findBrowser = () => {
  const forced = process.env.SKETCHDEX_BROWSER;
  return forced ? { kind: "chromium", bin: forced } : null;
};

export const NO_BROWSER_MESSAGE =
  "render_scene needs SKETCHDEX_BROWSER set to the path of a Chromium-based browser binary.";

/* ─── serving the page ──────────────────────────────────────────────── */

let building = null;

/** The render page is part of the normal build; build once if it is missing. */
const ensureBuild = async () => {
  const entry = path.join(dist, "render.html");
  if (await fs.access(entry).then(() => true, () => false)) return;
  if (!existsSync(path.join(repo, "node_modules", "vite"))) {
    throw new Error(
      "the built render page (dist/render.html) is missing and this is not a dev checkout, so it cannot be built here. Reinstall sketchdex.",
    );
  }
  if (!building) {
    building = new Promise((resolve, reject) => {
      const child = spawn("npm", ["run", "build"], {
        cwd: repo,
        stdio: ["ignore", "ignore", "pipe"],
        shell: process.platform === "win32",
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

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * The throwaway server. Always present for the length of one render: it is
 * where the page posts its result. When no dev server is running it also
 * serves dist/ and the scene payload.
 */
const startTempServer = async ({ payload, serveDist }) => {
  if (serveDist) await ensureBuild();
  let settle = null;
  const result = new Promise((resolve) => {
    settle = resolve;
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // the page may live on another origin (the dev server); let it post here
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (url.pathname === "/__result" && req.method === "POST") {
      const raw = await readBody(req).catch(() => "");
      res.writeHead(204);
      res.end();
      try {
        settle(JSON.parse(raw));
      } catch (err) {
        settle({ error: `unreadable render result: ${err}` });
      }
      return;
    }
    if (url.pathname === "/__payload" && payload) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(payload);
    }
    if (!serveDist) {
      res.writeHead(404);
      return res.end();
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
  return { server, origin: `http://127.0.0.1:${server.address().port}`, result };
};

/* ─── driving a browser ─────────────────────────────────────────────── */

/**
 * Headless Chromium. No debugging protocol: the page posts its own result to
 * the temp server, so all this has to do is open the URL and wait.
 */
const runChromium = async (bin, url, result) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "sketchdex-browser-"));
  const child = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-features=Translate",
      `--user-data-dir=${profile}`,
      "--window-size=1600,1200",
      // Chromium refuses to start as root without this (containers, some CI)
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const handle = { child, profile };
  liveBrowsers.add(handle);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve({ error: "render timed out" }), DEADLINE).unref(),
  );
  try {
    const shot = await Promise.race([
      result,
      timeout,
      exited.then((code) => ({
        error: `the browser exited (${code}) before rendering\n${stderr.slice(-500)}`,
      })),
    ]);
    return shot;
  } finally {
    child.kill();
    await exited.catch(() => {});
    liveBrowsers.delete(handle);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
};


/* ─── the render ────────────────────────────────────────────────────── */

/**
 * @param scene   the payload from agent.readScene, with `files` included
 * @param options scale, maxWidth, dark, region, ids, tiles, inlineLimit
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
    transparent = false,
  } = {},
) {
  const browser = await findBrowser();
  if (!browser) throw new Error(NO_BROWSER_MESSAGE);
  await pruneOldOutput();

  const running = await findRunningServer(scene.vault);
  const temp = await startTempServer({
    serveDist: !running,
    payload: running
      ? null
      : JSON.stringify({
          elements: scene.elements,
          appState: scene.appState,
          files: scene.files ?? {},
        }),
  });
  const origin = running ?? temp.origin;

  const query = new URLSearchParams({
    scale: String(scale),
    maxWidth: String(maxWidth),
    dark: dark ? "1" : "0",
    inlineLimit: String(inlineLimit),
    tiles: String(tiles > 1 ? tiles : 1),
  });
  if (transparent) query.set("bg", "0");
  // against a live server the page fetches the scene itself, by id
  if (running) query.set("scene", scene.id);
  if (ids?.length) query.set("only", ids.join(","));
  if (region) {
    const { x = 0, y = 0, width = 0, height = 0 } = region;
    query.set("region", [x, y, width, height].join(","));
  }
  query.set("result", `${temp.origin}/__result`);

  const url = `${origin}/render.html?${query}`;

  try {
    const shot = await runChromium(browser.bin, url, temp.result);
    if (shot.error) throw new Error(shot.error);

    /**
     * Always written to a file, not only when it is too big to inline. A caller
     * that hits the transport's message limit needs somewhere to go, and a path
     * that sometimes exists is worse than one that always does.
     */
    const dir = RENDER_DIR;
    await fs.mkdir(dir, { recursive: true });
    const safe = String(scene.name ?? "scene").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
    // a short random tail so two renders of one scene never share a file
    const stamp = `${safe}-${scene.id.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
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
    temp.server.close();
  }
}
