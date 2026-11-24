import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageVersion = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const tempRoot = mkdtempSync(path.join(tmpdir(), "sketchdex-mcp-stdio-"));
const suppliedBinary = process.env.SKETCHDEX_MCP_BINARY;
const binary = suppliedBinary || path.join(tempRoot, "sketchdex-mcp");
const nim = process.env.SKETCHDEX_NIM || "nim";

if (!suppliedBinary) {
  try {
    execFileSync(nim, [
      "compile",
      `--nimcache:${path.join(tempRoot, "nimcache")}`,
      `-o:${binary}`,
      path.join(repoRoot, "nim/mcp/stdio.nim"),
    ], { cwd: repoRoot, stdio: "pipe" });
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function scratchVault() {
  return mkdtempSync(path.join(tempRoot, "vault-"));
}

function serverEnv(vault) {
  return {
    ...process.env,
    SKETCHDEX_VAULT: vault,
    SKETCHDEX_DIST: process.env.SKETCHDEX_DIST || path.join(repoRoot, "dist"),
    SKETCHDEX_METRICS: process.env.SKETCHDEX_METRICS || path.join(repoRoot, "server/font-metrics.json"),
  };
}

test("official SDK client initializes and uses tools and resources", { timeout: 60_000 }, async () => {
  const vault = scratchVault();
  const transport = new StdioClientTransport({
    command: binary,
    args: [],
    env: serverEnv(vault),
    stderr: "pipe",
  });
  const client = new Client({ name: "sketchdex-nim-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: "sketchdex", version: packageVersion });
    assert.deepEqual(client.getServerCapabilities(), {
      tools: { listChanged: true },
      resources: {},
    });
    assert.equal(client.getInstructions().startsWith("Sketchdex draws on the user's Excalidraw canvases;"), true);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 19);
    assert.equal(listed.tools[0].name, "list_scenes");

    const empty = await client.callTool({ name: "list_scenes", arguments: {} });
    assert.equal(empty.isError, undefined);
    assert.deepEqual(JSON.parse(empty.content[0].text), []);

    const created = await client.callTool({
      name: "create_scene",
      arguments: {
        name: "SDK scene",
        elements: [{ id: "rect", type: "rectangle", x: 0, y: 0, width: 120, height: 80 }],
      },
    });
    assert.equal(created.isError, undefined);
    const scene = JSON.parse(created.content[0].text);
    assert.equal(scene.name, "SDK scene");
    assert.equal(typeof scene.sceneId, "string");

    const scenes = await client.callTool({ name: "list_scenes", arguments: {} });
    assert.equal(JSON.parse(scenes.content[0].text).length, 1);

    const infoResult = await client.callTool({ name: "sketchdex_info", arguments: {} });
    assert.equal(infoResult.isError, undefined);
    const info = JSON.parse(infoResult.content[0].text);
    assert.deepEqual(Object.keys(info).sort(), [
      "pid", "runtime", "server", "startedAt", "uptimeMinutes", "vault", "version",
    ]);
    assert.equal(info.version, packageVersion);
    assert.equal(info.runtime, "nim");
    assert.equal(info.vault, vault);
    assert.equal(typeof info.pid, "number");
    assert.equal(new Date(info.startedAt).toISOString(), info.startedAt);

    const rendered = await client.callTool({
      name: "render_scene",
      arguments: { scene: scene.sceneId, scale: 1, maxWidth: 300, tiles: 1 },
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered.content.length, 2);
    const image = rendered.content.find((block) => block.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(typeof image.data, "string");
    const summary = JSON.parse(rendered.content.find((block) => block.type === "text").text);
    assert.equal(summary.inlined, true);
    assert.equal(summary.scene, "SDK scene");
    assert.equal(existsSync(summary.path), true);
    try {
      const png = readFileSync(summary.path);
      assert.equal(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
    } finally {
      rmSync(summary.path, { force: true });
    }

    const missing = await client.callTool({
      name: "add_elements",
      arguments: { scene: scene.sceneId, elements: [] },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /add_elements is missing: label/);

    const resources = await client.listResources();
    assert.equal(resources.resources.length, 7);
    assert.deepEqual(resources.resources.map((resource) => resource.name), [
      "install", "vault", "app", "rendering", "tools", "drawing", "troubleshooting",
    ]);
    const install = await client.readResource({ uri: "sketchdex://docs/install" });
    assert.equal(install.contents[0].mimeType, "text/markdown");
    assert.equal(install.contents[0].text.startsWith("# Install"), true);
  } finally {
    await client.close();
  }
});

test("raw JSON-lines handles blank lines, parse errors, batches, notifications, and EOF", { timeout: 30_000 }, async () => {
  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: serverEnv(scratchVault()),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const queued = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });

  function nextLine() {
    if (queued.length > 0) return Promise.resolve(queued.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stdio response timed out")), 5_000);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  try {
    child.stdin.write("\n");
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "eof-test", version: "1" },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const initialized = JSON.parse(await nextLine());
    assert.equal(initialized.id, 1);
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    const listed = JSON.parse(await nextLine());
    assert.equal(listed.id, 2);
    assert.equal(listed.result.tools.length, 19);

    child.stdin.write("not json\n");
    const parseError = JSON.parse(await nextLine());
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    child.stdin.write(`${JSON.stringify([
      { jsonrpc: "2.0", id: "string-id", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: true, method: "ping" },
    ])}\n`);
    const batch = JSON.parse(await nextLine());
    assert.equal(batch.length, 3);
    assert.equal(batch[0].id, "string-id");
    assert.deepEqual(batch[0].result, {});
    assert.equal(batch[1].id, 2);
    assert.equal(batch[1].result.tools.length, 19);
    assert.equal(batch[2].id, null);
    assert.equal(batch[2].error.code, -32600);

    child.stdin.end();
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) {
      child.stdin.destroy();
      child.kill();
    }
  }
});
