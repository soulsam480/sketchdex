import { app, BrowserWindow, shell } from "electron";
import { startAppServer } from "../server/serve.js";

const isDev = !app.isPackaged;

/**
 * In dev the Vite server already serves the app and the vault API. Packaged,
 * this process is both: the same static-plus-API server the CLI's `sketchdex
 * app` runs (server/serve.js), on an ephemeral port, so the app has no
 * external dependency.
 */
const startServer = () => startAppServer({ port: 0 }).then(({ url }) => url);

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
