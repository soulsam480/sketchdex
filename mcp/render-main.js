import fs from "node:fs";
import { app, BrowserWindow } from "electron";

/**
 * Electron main process for a single headless render, spawned by render.js.
 *
 * Excalidraw draws to a canvas, so producing a picture that matches the editor
 * needs a real browser. Electron is already a dependency here and its Chromium
 * version is pinned alongside the app, which makes it a steadier choice than
 * adding a second browser just for screenshots.
 *
 * The page leaves its result on `window.__sketchdexShot`; this polls for it and
 * writes it out. Polling rather than a callback channel is what lets the same
 * page work against the ordinary dev server, with no port of its own.
 *
 * The result goes to a file, never stdout. A base64 PNG is far larger than a
 * pipe buffer, `process.stdout.write` is asynchronous once it fills, and
 * `app.exit` does not wait for the drain - so writing the image to stdout
 * truncated it mid-string at whatever had flushed, and the parent got
 * unparseable JSON. Sizes looked like client limits (320 KiB, 384 KiB) but were
 * just however much made it out before the process died. A file write is
 * synchronous and complete.
 */

const url = process.argv[2];
const outFile = process.argv[3];
const DEADLINE = 60000;

app.commandLine.appendSwitch("disable-gpu-compositing");

const finish = (payload, code) => {
  try {
    fs.writeFileSync(outFile, JSON.stringify(payload));
  } catch (err) {
    process.stderr.write(`[render] could not write result: ${err}\n`);
    return app.exit(1);
  }
  app.exit(code);
};

app.whenReady().then(async () => {
  app.dock?.hide();

  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  // single-arg handler: Electron 40 deprecates the positional signature
  win.webContents.on("console-message", (event) => {
    if (event?.level === "error") {
      process.stderr.write(`[render page] ${event.message}\n`);
    }
  });

  try {
    await win.loadURL(url);
  } catch (err) {
    return finish({ error: `page failed to load: ${err}` }, 1);
  }

  const started = Date.now();
  while (Date.now() - started < DEADLINE) {
    const shot = await win.webContents
      .executeJavaScript("window.__sketchdexShot ?? null")
      .catch(() => null);
    if (shot) return finish(shot, shot.error ? 1 : 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  finish({ error: "render timed out" }, 1);
});
