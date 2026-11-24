import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const binary = process.env.SKETCHDEX_SERVER_BINARY ?? path.join(root, "nim", "bin", win ? "sketchdex.exe" : "sketchdex");
const assets = process.env.SKETCHDEX_TEST_ASSETS ?? path.join(root, "dist");
const started = Date.now();
const log = (message) => console.log(`[server-e2e ${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const tempRoot = fs.mkdtempSync(path.join(process.env.SKETCHDEX_TEST_TMP ?? os.tmpdir(), "sketchdex-server-e2e-"));
const state = { server: null, stdio: null, sse: null, pngs: [] };

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function ensureBinary() {
  if (process.env.SKETCHDEX_SERVER_BINARY) {
    assert.ok(fs.existsSync(binary), `server binary not found: ${binary}`);
    return;
  }
  if (fs.existsSync(binary)) return;
  const built = spawnSync(process.execPath, ["scripts/build-server.mjs"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  assert.equal(built.status, 0, `build-server failed:\n${built.stderr || built.stdout}`);
}

function serverEnv(vault) {
  const env = { ...process.env, SKETCHDEX_VAULT: vault, SKETCHDEX_DIST: assets, SKETCHDEX_CORE: "js" };
  delete env.SKETCHDEX_METRICS;
  return env;
}

async function startServer(vault) {
  const child = spawn(binary, ["app", "--port", "0", "--vault", vault, "--assets", assets], {
    env: serverEnv(vault),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  state.server = child;
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not print its URL:\n${output}`)), 15_000);
    const onData = () => {
      const match = output.match(/^\s*app\s+(http:\/\/127\.0\.0\.1:\d+)\s*$/m);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(match[1]);
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before printing its URL: code=${code} signal=${signal}\n${output}`));
    });
  });

  return { child, origin, output: () => output };
}

async function postJson(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${pathname} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function openSse(origin) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  state.sse = { controller, reader };

  return {
    async nextScene() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!data) continue;
          const event = JSON.parse(data.slice(6));
          if (event.type === "scene") return event;
          continue;
        }
        const { value, done } = await withTimeout(reader.read(), 10_000, "SSE scene event timed out");
        if (done) throw new Error("SSE stream closed before a scene event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function processRows() {
  if (win) {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, `process snapshot failed: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout || "[]");
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      command: String(row.Name),
    }));
  }
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
  assert.equal(result.status, 0, `process snapshot failed: ${result.stderr}`);
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function assertNoNodeDescendants(pid) {
  const rows = processRows();
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const queue = [...(children.get(pid) ?? [])];
  const seen = new Set();
  const nodes = [];
  while (queue.length) {
    const row = queue.shift();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (/(^|[\\/])node(?:\.exe)?$/i.test(row.command.trim())) nodes.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  assert.deepEqual(nodes, [], `server spawned node descendants: ${JSON.stringify(nodes)}`);
}

async function runStdio(vault) {
  const child = spawn(binary, ["mcp", "--vault", vault], {
    env: serverEnv(vault),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  state.stdio = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({ input: child.stdout });
  const queued = [];
  const waiters = [];
  lines.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });

  const nextLine = () => {
    if (queued.length) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stdio response timed out")), 5_000);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "server-e2e", version: "1" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_scenes", arguments: {} } });

    const initialized = JSON.parse(await nextLine());
    const listed = JSON.parse(await nextLine());
    const scenes = JSON.parse(await nextLine());
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.serverInfo.name, "sketchdex");
    assert.equal(listed.id, 2);
    assert.equal(listed.result.tools.length, 22);
    assert.equal(scenes.id, 3);
    assert.ok(Array.isArray(JSON.parse(scenes.result.content[0].text)));

    child.stdin.end();
    const [code, signal] = await withTimeout(once(child, "close"), 5_000, "stdio server did not exit after EOF");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.doesNotMatch(stderr, /EOF|traceback/i);
    state.stdio = null;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill();
  try {
    await withTimeout(closed, 5_000, "server did not stop");
  } catch {
    child.kill("SIGKILL");
    await withTimeout(closed, 5_000, "server did not stop after SIGKILL").catch(() => {});
  }
}

async function main() {
  ensureBinary();
  assert.ok(fs.existsSync(path.join(assets, "index.html")), `built app not found at ${assets}`);
  assert.ok(fs.existsSync(path.join(assets, "render.html")), `render page not found at ${assets}`);
  const vault = path.join(tempRoot, "vault");
  const { origin } = await startServer(vault);
  const agent = (op, body) => postJson(origin, `/api/agent/${op}`, body);
  const readScene = () => agent("read", { scene: "Nim server e2e" });
  const liveCount = (scene) => scene.elements.filter((element) => !element.isDeleted).length;
  log(`server ready at ${origin}`);

  assert.equal(fs.existsSync(path.join(vault, "font-metrics.json")), false, "server created a metrics sidecar");

  const created = await agent("create", {
    name: "Nim server e2e",
    elements: [{
      type: "rectangle",
      ref: "box",
      x: 40,
      y: 30,
      width: 160,
      height: 80,
      label: "Box",
      backgroundColor: "#2b6b3a",
      seed: 101,
      versionNonce: 102,
    }],
  });
  assert.equal(created.added, 2);
  assert.equal(created.elements.length, 2);
  const rectangle = created.elements.find((element) => element.type === "rectangle");
  const rectangleLabel = created.elements.find((element) => element.type === "text");
  assert.ok(rectangle?.id);
  assert.equal(rectangleLabel.containerId, rectangle.id);
  assert.equal(liveCount(await readScene()), 2);
  log("create labelled rectangle");

  const added = await agent("add", {
    scene: created.sceneId,
    label: "add the ellipse",
    elements: [{
      type: "ellipse",
      x: 300,
      y: 30,
      width: 140,
      height: 90,
      label: "Ellipse",
      backgroundColor: "#8a6a12",
      seed: 103,
      versionNonce: 104,
    }],
  });
  assert.equal(added.added, 2);
  assert.equal(liveCount(await readScene()), 4);
  log("add labelled ellipse");

  const updated = await agent("update", {
    scene: created.sceneId,
    label: "recolor the rectangle",
    elements: [{ id: rectangle.id, strokeColor: "#e0101a" }],
  });
  assert.equal(updated.updated, 1);
  let scene = await readScene();
  assert.equal(scene.elements.find((element) => element.id === rectangle.id).strokeColor, "#e0101a");
  const beforeMove = scene.elements.find((element) => element.id === rectangle.id);
  const beforeMoveLabel = scene.elements.find((element) => element.id === rectangleLabel.id);

  const moved = await agent("move", {
    scene: created.sceneId,
    label: "move the rectangle",
    ids: [rectangle.id],
    dx: 25,
    dy: 15,
  });
  assert.equal(moved.moved, 2);
  scene = await readScene();
  const movedRectangle = scene.elements.find((element) => element.id === rectangle.id);
  const movedLabel = scene.elements.find((element) => element.id === rectangleLabel.id);
  assert.equal(movedRectangle.x, beforeMove.x + 25);
  assert.equal(movedRectangle.y, beforeMove.y + 15);
  assert.equal(movedLabel.x, beforeMoveLabel.x + 25);
  assert.equal(movedLabel.y, beforeMoveLabel.y + 15);
  log("update and move rectangle with its label");

  const deleted = await agent("delete", {
    scene: created.sceneId,
    label: "delete the rectangle",
    ids: [rectangle.id],
  });
  assert.equal(deleted.deleted, 2);
  scene = await readScene();
  assert.equal(scene.elements.find((element) => element.id === rectangle.id).isDeleted, true);
  assert.equal(scene.elements.find((element) => element.id === rectangleLabel.id).isDeleted, true);
  assert.equal(liveCount(scene), 2);
  log("delete soft-deletes rectangle and label");

  const history = await agent("history", { scene: created.sceneId });
  const snapshot = history.entries.find((entry) => entry.label === "delete the rectangle");
  assert.ok(snapshot?.id);
  const restored = await agent("restore", { scene: created.sceneId, snapshot: snapshot.id });
  assert.equal(restored.restored, snapshot.id);
  scene = await readScene();
  assert.equal(scene.elements.find((element) => element.id === rectangle.id).isDeleted, false);
  assert.equal(scene.elements.find((element) => element.id === rectangleLabel.id).isDeleted, false);
  assert.equal(liveCount(scene), 4);
  log("history restore brings the scene back");

  const sse = await openSse(origin);
  const sceneEvent = sse.nextScene();
  const diamond = await agent("add", {
    scene: created.sceneId,
    label: "add a diamond",
    elements: [{ type: "diamond", x: 500, y: 30, width: 90, height: 90, seed: 105, versionNonce: 106 }],
  });
  assert.equal(diamond.added, 1);
  const event = await withTimeout(sceneEvent, 5_000, "SSE scene event did not arrive");
  assert.equal(event.type, "scene");
  assert.equal(event.id, created.sceneId);
  state.sse.controller.abort();
  await state.sse.reader.cancel().catch(() => {});
  state.sse = null;
  log("SSE scene event received");

  let rpcId = 0;
  const rpc = async (method, params) => {
    const id = ++rpcId;
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `MCP ${method} returned ${response.status}: ${text}`);
    const body = JSON.parse(text);
    assert.equal(body.id, id);
    assert.equal(body.error, undefined, `MCP ${method} failed: ${text}`);
    return body.result;
  };
  const toolCall = async (name, args = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result)}`);
    return result;
  };
  const toolText = (result) => result.content.find((content) => content.type === "text")?.text ?? "";

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "server-e2e-http", version: "1" },
  });
  assert.equal(initialized.serverInfo.name, "sketchdex");
  const tools = await rpc("tools/list");
  assert.equal(tools.tools.length, 22);
  const scenes = JSON.parse(toolText(await toolCall("list_scenes")));
  assert.ok(scenes.some((entry) => entry.id === created.sceneId));
  const resources = await rpc("resources/list");
  assert.equal(resources.resources.length, 7);
  const docs = toolText(await toolCall("sketchdex_docs", { topic: "install" }));
  assert.match(docs, /^# Install/);
  log("MCP HTTP initialize, 22 tools, list_scenes, 7 resources, docs");

  await runStdio(vault);
  log("MCP stdio initialize, 22 tools, list_scenes, clean EOF");

  const renderCreated = await agent("create", {
    name: "Render scene",
    elements: [{
      type: "rectangle",
      x: 20,
      y: 20,
      width: 180,
      height: 100,
      backgroundColor: "#e0101a",
      seed: 107,
      versionNonce: 108,
    }],
  });
  const render = await toolCall("render_scene", { scene: renderCreated.sceneId, maxWidth: 800 });
  assert.ok(render.content.some((content) => content.type === "image"), "render returned no image content block");
  const renderMeta = JSON.parse(toolText(render));
  assert.ok(renderMeta.path && fs.existsSync(renderMeta.path), "render did not write a PNG");
  state.pngs.push(renderMeta.path);
  const png = fs.readFileSync(renderMeta.path);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  log(`render image block and PNG ${renderMeta.width}x${renderMeta.height}`);

  assertNoNodeDescendants(state.server.pid);
  log("process tree has no node descendant");
}

try {
  await main();
  log(`PASS in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(`[server-e2e] FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (state.sse) {
    state.sse.controller.abort();
    await state.sse.reader.cancel().catch(() => {});
  }
  await stopChild(state.stdio);
  await stopChild(state.server);
  for (const png of state.pngs) {
    try {
      fs.rmSync(png, { force: true });
    } catch {
      // The render may have already removed it.
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
