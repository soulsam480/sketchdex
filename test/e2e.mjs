/**
 * The whole product, the way a user gets it.
 *
 * Packs the repo into a tarball, installs it into a throwaway project, and
 * drives the installed `sketchdex` binary through a real MCP client over stdio:
 * list tools, create a scene, edit it as a delta, render it through whatever
 * browser the machine has, check it, and read the history back. Then starts
 * `sketchdex app` and probes the library, the API and the HTTP MCP endpoint.
 *
 * Runs on macOS, Linux and Windows (see .github/workflows/ci.yml). Needs the
 * repo's own node_modules for the MCP client SDK, and a Chromium-based browser
 * on the machine for the render step.
 *
 *   npm run build && node test/e2e.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const started = Date.now();
const log = (msg) => console.log(`[e2e ${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg) => {
  console.error(`[e2e] FAIL: ${msg}`);
  process.exit(1);
};
const assert = (cond, msg) => cond || fail(msg);

const npm = (args, cwd) => {
  // npm is a .cmd on Windows, which Node will only spawn through a shell
  const out = spawnSync("npm", args, { cwd, shell: win, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (out.status !== 0) fail(`npm ${args.join(" ")} failed:\n${out.stderr.slice(-1500)}`);
  return out.stdout;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sketchdex-e2e-"));
const testStart = Date.now();
const vault = path.join(tmp, "vault");
let appChild = null;
const cleanup = () => {
  appChild?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
};
process.on("exit", cleanup);

/* ─── 1. pack and install ───────────────────────────────────────────── */

assert(fs.existsSync(path.join(root, "dist", "render.html")), "dist/ is missing; run npm run build first");
// --ignore-scripts: the prepare hook prints, and its work is already done
const packOut = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], root);
const packed = JSON.parse(packOut.slice(packOut.indexOf("[")));
const tarball = path.join(tmp, packed[0].filename);
log(`packed ${packed[0].filename} (${(packed[0].size / 1024).toFixed(0)} KB, ${packed[0].entryCount} files)`);

const project = path.join(tmp, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "e2e", private: true, type: "module" }));
npm(["install", "--no-fund", "--no-audit", "--loglevel=error", tarball], project);
const bin = path.join(project, "node_modules", "sketchdex", "bin", "sketchdex.js");
assert(fs.existsSync(bin), "installed package has no bin/sketchdex.js");
assert(
  !fs.existsSync(path.join(project, "node_modules", "electron")) &&
    !fs.existsSync(path.join(project, "node_modules", "@excalidraw")),
  "install pulled in build-only dependencies",
);
log("installed into a clean project, runtime deps only");

/* ─── 2. the CLI ────────────────────────────────────────────────────── */

const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).stdout.trim();
assert(version === packed[0].version, `--version printed ${version}, expected ${packed[0].version}`);
const printedVault = spawnSync(process.execPath, [bin, "vault", "--vault", vault], { encoding: "utf8" }).stdout.trim();
assert(path.resolve(printedVault) === path.resolve(vault), `vault flag not honoured: ${printedVault}`);
log(`cli ok (${version})`);

/* ─── 3. MCP over stdio ─────────────────────────────────────────────── */

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin],
  env: { ...process.env, SKETCHDEX_VAULT: vault },
  stderr: "pipe",
});
let serverErr = "";
transport.stderr?.on("data", (c) => {
  serverErr += c;
});
const client = new Client({ name: "sketchdex-e2e", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
assert(tools.length === 18, `expected 18 tools, got ${tools.length}`);
assert(/hand-drawn/i.test(client.getInstructions() ?? ""), "server instructions missing");
log("mcp connected, 18 tools");

const text = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) fail(`${name}: ${text(r)}\n${serverErr.slice(-800)}`);
  return r;
};

const made = JSON.parse(text(await call("create_scene", {
  name: "E2E",
  elements: [
    { type: "rectangle", ref: "a", x: 0, y: 0, width: 220, height: 90, label: "installed", backgroundColor: "#2b6b3a" },
    { type: "ellipse", ref: "b", x: 380, y: 0, width: 170, height: 90, label: "rendered", backgroundColor: "#8a6a12" },
    { type: "arrow", x: 225, y: 45, width: 150, height: 0, start: "a", end: "b" },
  ],
})));
assert(made.added === 5, `create_scene added ${made.added}, expected 5 (labels become elements)`);
const boxId = made.elements.find((e) => e.type === "rectangle").id;

const described = JSON.parse(text(await call("describe_scene", { scene: "E2E" })));
assert(described.background === "#121212", `new scene paper is ${described.background}, expected #121212`);

await call("update_elements", { scene: "E2E", label: "nudge the box", elements: [{ id: boxId, x: 20 }] });
const [box] = JSON.parse(text(await call("read_elements", { scene: "E2E", ids: [boxId] }))).elements;
assert(box.x === 20 && box.width === 220, "delta update changed more than it should");

const history = JSON.parse(text(await call("list_history", { scene: "E2E" })));
assert(history.entries?.length === 1 && history.entries[0].label === "nudge the box", "write was not snapshotted with its label");
log("create, describe, delta update, history ok");

const t0 = Date.now();
const render = await call("render_scene", { scene: "E2E", scale: 2 });
const image = render.content.find((c) => c.type === "image");
assert(image, `render returned no image: ${text(render)}`);
const meta = JSON.parse(text(render));
assert(meta.path && fs.existsSync(meta.path), "render did not write its PNG to disk");
const png = fs.readFileSync(meta.path);
assert(png.subarray(1, 4).toString() === "PNG", "render output is not a PNG");
assert(meta.width > 1000 && !meta.tiles, `unexpected render shape ${meta.width}x${meta.height} tiles=${!!meta.tiles}`);
log(`render ok, ${meta.width}x${meta.height} in ${Date.now() - t0}ms`);

const checked = JSON.parse(text(await call("check_scene", { scene: "E2E" })));
assert(checked.problems === 0, `check_scene found ${checked.problems} problems`);

await call("import_svg", {
  scene: "E2E",
  label: "a dot",
  x: 0,
  y: 200,
  width: 60,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e0101a" stroke="#e9ecef"/></svg>',
});
const afterSvg = JSON.parse(text(await call("describe_scene", { scene: "E2E", type: "ellipse" })));
assert(afterSvg.counts.ellipse === 2, `import_svg did not produce a native ellipse: ${JSON.stringify(afterSvg.counts)}`);
log("check, import_svg ok");

// a call without a label is refused by the server, not just the schema
const unlabelled = await client.callTool({ name: "add_elements", arguments: { scene: "E2E", elements: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] } });
assert(unlabelled.isError && /label/.test(text(unlabelled)), "an unlabelled write was accepted");

/**
 * Closing the pipe must end the server on its own. The SDK client ends
 * stdin, waits two seconds, then kills; a server that only dies to the kill
 * would leave two node processes per session for clients that do not kill.
 */
const serverPid = transport.pid;
const closedAt = Date.now();
await client.close();
let exitedOnItsOwn = false;
for (let i = 0; i < 15 && !exitedOnItsOwn; i += 1) {
  try {
    process.kill(serverPid, 0);
    await new Promise((r) => setTimeout(r, 100));
  } catch {
    exitedOnItsOwn = true;
  }
}
assert(exitedOnItsOwn && Date.now() - closedAt < 1900, "server did not exit when the client closed the pipe");
const leftovers = fs
  .readdirSync(os.tmpdir())
  .filter((n) => n.startsWith("sketchdex-browser-"))
  .filter((n) => fs.statSync(path.join(os.tmpdir(), n)).mtimeMs >= testStart);
assert(leftovers.length === 0, `render left browser profiles behind: ${leftovers.join(", ")}`);
log("server exits with the client, no browser leftovers");

/* ─── 4. the app ────────────────────────────────────────────────────── */

const port = 5200 + Math.floor(Math.random() * 300);
appChild = spawn(process.execPath, [bin, "app", "--port", String(port), "--no-open"], {
  env: { ...process.env, SKETCHDEX_VAULT: vault },
  stdio: ["ignore", "pipe", "pipe"],
});
let appOut = "";
appChild.stdout.on("data", (c) => {
  appOut += c;
});
appChild.stderr.on("data", (c) => {
  appOut += c;
});
const origin = `http://127.0.0.1:${port}`;
let up = null;
for (let i = 0; i < 50 && !up; i += 1) {
  up = await fetch(`${origin}/api/vault`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!up) await new Promise((r) => setTimeout(r, 200));
}
assert(up, `app did not come up on ${port}:\n${appOut}`);
assert(path.resolve(up.vault) === path.resolve(vault), "app is serving the wrong vault");
const html = await fetch(`${origin}/`).then((r) => r.text());
assert(html.includes("<title>sketchdex</title>"), "app shell not served");
const scenes = await fetch(`${origin}/api/scenes`).then((r) => r.json());
assert(scenes.length === 1 && scenes[0].name === "E2E", "app does not list the scene the agent made");
const init = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
  }),
}).then((r) => r.text());
assert(init.includes('"name":"sketchdex"'), `HTTP MCP did not initialize: ${init.slice(0, 200)}`);

// a page from another site must not be able to write to the vault
const crossSite = await fetch(`${origin}/api/agent/add`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
  body: JSON.stringify({ scene: "E2E", label: "csrf", elements: [] }),
});
assert(crossSite.status === 403, `cross-site write got ${crossSite.status}, expected 403`);
// fetch will not let a script set Host, so this one goes through node:http
const rebound = await new Promise((resolve, reject) => {
  http
    .get({ host: "127.0.0.1", port, path: "/api/scenes", headers: { Host: "evil.example" } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    })
    .on("error", reject);
});
assert(rebound === 403, `DNS-rebinding read got ${rebound}, expected 403`);
const textPlain = await fetch(`${origin}/api/agent/add`, {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ scene: "E2E", label: "csrf", elements: [] }),
});
assert(textPlain.status === 415, `text/plain body got ${textPlain.status}, expected 415`);
const missing = await fetch(`${origin}/api/scenes/does-not-exist`);
assert(missing.status === 404, `missing scene got ${missing.status}, expected 404`);
const badJson = await fetch(`${origin}/api/agent/describe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
assert(badJson.status === 400, `malformed JSON got ${badJson.status}, expected 400`);
const stillUp = await fetch(`${origin}/%`).then((r) => r.status).catch(() => 0);
assert(stillUp === 400, `a bad URL got ${stillUp}, expected 400 (and the server still up)`);
log("app serves the library, the API and HTTP MCP; refuses cross-site writes; honest statuses");

appChild.kill();
appChild = null;
log("all good");
