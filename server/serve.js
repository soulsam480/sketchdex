import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoreMiddleware } from "./middleware.js";

/**
 * The app as a plain Node server: static files out of dist/ plus the vault
 * API, MCP-over-HTTP and REST that the Vite plugin mounts in development.
 *
 * Used by `sketchdex app` (the CLI) and by the packaged Electron app. Both
 * want the same thing: one process, no build step, no external dependency,
 * serving the library at a localhost URL against whatever vault was chosen.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(dirname, "..");
export const distDir = path.join(root, "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
};

/** True when the built app is present; the CLI refuses to start without it. */
export const hasBuild = () => fs.existsSync(path.join(distDir, "index.html"));

/** Inside dist/, by path segments rather than a string prefix. */
const inside = (file) => {
  const rel = path.relative(distDir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const serveStatic = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.statusCode = 400;
    return res.end("bad request");
  }
  let file = path.join(distDir, pathname);
  // SPA: unknown paths fall back to the shell, hash routing does the rest
  if (!inside(file) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(distDir, "index.html");
  }
  const stream = fs.createReadStream(file);
  stream.on("open", () => {
    res.setHeader(
      "Content-Type",
      MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    );
  });
  stream.on("error", () => {
    if (!res.headersSent) res.statusCode = 404;
    res.end();
  });
  stream.pipe(res);
};

/**
 * @param options.port   0 for an ephemeral port (the Electron app), a number
 *                       to insist on one (the CLI)
 * @param options.host   127.0.0.1 unless told otherwise; the vault is private
 * @param options.vault  folder of scenes; defaults follow store.js
 * @returns { server, url, close }
 */
export function startAppServer({ port = 0, host = "127.0.0.1", vault } = {}) {
  const api = createStoreMiddleware(vault);

  const server = http.createServer((req, res) => {
    // the middleware is async; a rejection here must be an error response,
    // not an unhandled rejection that takes the whole app down
    Promise.resolve()
      .then(() => api(req, res, () => serveStatic(req, res)))
      .catch((err) => {
        console.error("[sketchdex] request failed:", err);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const { port: bound } = server.address();
      const shown = host.includes(":") ? `[${host}]` : host;
      resolve({
        server,
        url: `http://${shown}:${bound}`,
        close: () =>
          new Promise((done) => {
            api.close();
            server.close(() => done());
          }),
      });
    });
  });
}
