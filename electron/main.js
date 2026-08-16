import { app, BrowserWindow, shell } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStoreMiddleware } from "../server/middleware.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dirname, "..");
const isDev = !app.isPackaged;

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

/**
 * In dev the Vite server already serves the app and the vault API. Packaged,
 * this process is both: a static file server over dist/ plus the same store
 * middleware the Vite plugin mounts, so the app has no external dependency.
 */
function startServer() {
  const distDir = path.join(root, "dist");
  const api = createStoreMiddleware();

  const server = http.createServer((req, res) => {
    api(req, res, () => {
      const url = new URL(req.url, "http://localhost");
      let file = path.join(distDir, decodeURIComponent(url.pathname));
      if (!file.startsWith(distDir)) {
        res.statusCode = 403;
        return res.end("forbidden");
      }
      // SPA: unknown paths fall back to the shell, hash routing does the rest
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(distDir, "index.html");
      }
      res.setHeader(
        "Content-Type",
        MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      );
      fs.createReadStream(file).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
}

function createWindow(baseURL) {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#0b0b0c",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 17 },
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once("ready-to-show", () => win.show());

  // external links belong in the browser, not in a canvas window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(baseURL);
  return win;
}

app.whenReady().then(async () => {
  const baseURL = isDev ? "http://localhost:5173" : await startServer();
  createWindow(baseURL);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(baseURL);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
