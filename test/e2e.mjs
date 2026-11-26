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
 *   npm test
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
const bin = path.join(project, "node_modules", "sketchdex", "bin", win ? "sketchdex.exe" : "sketchdex");
assert(fs.existsSync(bin), `installed package has no bin/${win ? "sketchdex.exe" : "sketchdex"}`);
assert(
  !fs.existsSync(path.join(project, "node_modules", "electron")) &&
    !fs.existsSync(path.join(project, "node_modules", "@excalidraw")),
  "install pulled in build-only dependencies",
);
log("installed into a clean project, runtime deps only");

/* ─── 2. the CLI ────────────────────────────────────────────────────── */

const version = spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout.trim();
assert(version === packed[0].version, `--version printed ${version}, expected ${packed[0].version}`);
const printedVault = spawnSync(bin, ["vault", "--vault", vault], { encoding: "utf8" }).stdout.trim();
assert(path.resolve(printedVault) === path.resolve(vault), `vault flag not honoured: ${printedVault}`);
const docsOut = spawnSync(bin, ["docs", "install"], { encoding: "utf8" });
assert(docsOut.status === 0 && /Claude Code/.test(docsOut.stdout) && /Cursor/.test(docsOut.stdout), "`sketchdex docs install` did not print the install guide");
const docsBad = spawnSync(bin, ["docs", "nope"], { encoding: "utf8" });
assert(docsBad.status === 2 && /Topics:/.test(docsBad.stderr), "`sketchdex docs nope` did not fail with the topic list");
log(`cli ok (${version}), docs print`);

/* ─── 3. MCP over stdio ─────────────────────────────────────────────── */

const transport = new StdioClientTransport({
  command: bin,
  args: ["mcp"],
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
assert(tools.length === 28, `expected 28 tools, got ${tools.length}`);
assert(/hand-drawn/i.test(client.getInstructions() ?? ""), "server instructions missing");
assert(/sketchdex_docs/.test(client.getInstructions() ?? ""), "server instructions do not point at the docs");
log("mcp connected, 28 tools");

const text = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) fail(`${name}: ${text(r)}\n${serverErr.slice(-800)}`);
  return r;
};

// the manual reaches the agent three ways: the tool, the resources, and the CLI above
const docsTool = text(await call("sketchdex_docs", { topic: "troubleshooting" }));
assert(docsTool.startsWith("# Troubleshooting") && /SKETCHDEX_BROWSER/.test(docsTool), "sketchdex_docs did not return the troubleshooting topic as markdown");
const docsIndex = text(await call("sketchdex_docs", {}));
assert(/- install:/.test(docsIndex) && /- drawing:/.test(docsIndex), "sketchdex_docs without a topic did not return the index");
const docsTools = text(await call("sketchdex_docs", { topic: "tools" }));
assert(/^28 tools/m.test(docsTools) && docsTools.includes("`render_scene`"), "the generated tools topic is wrong");
const { resources } = await client.listResources();
assert(resources.length === 7 && resources.every((r) => r.uri.startsWith("sketchdex://docs/")), `expected 7 docs resources, got ${resources.length}`);
const resource = await client.readResource({ uri: "sketchdex://docs/install" });
assert(resource.contents[0].mimeType === "text/markdown" && /claude mcp add/.test(resource.contents[0].text), "docs resource did not read back");
log("docs via tool and resources ok");

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

// comments ride on the element, so they survive a plain canvas save
const comment = JSON.parse(text(await call("add_comment", {
  scene: "E2E", elementId: boxId, body: "This label is the wrong colour.", label: "comment on the box",
})));
assert(comment.comment.id.startsWith("cmt_") && comment.open === 1, "add_comment did not return an open comment");
const listed = JSON.parse(text(await call("list_comments", { scene: "E2E" })));
assert(listed.total === 1 && listed.comments[0].elementId === boxId, "list_comments lost the comment");
const withCounts = JSON.parse(text(await call("describe_scene", { scene: "E2E" })));
assert(withCounts.comments.open === 1, "describe_scene did not report the open comment");
const resolvedComment = JSON.parse(text(await call("update_comment", {
  scene: "E2E", elementId: boxId, commentId: comment.comment.id, action: "resolve", label: "resolve the note",
})));
assert(resolvedComment.changed === true && resolvedComment.status === "resolved", "update_comment did not resolve");
const reopened = JSON.parse(text(await call("update_comment", {
  scene: "E2E", elementId: boxId, commentId: comment.comment.id, action: "reopen", label: "reopen the note",
})));
assert(reopened.status === "open" && reopened.changed, "update_comment did not reopen");
const found = JSON.parse(text(await call("search_elements", { scene: "E2E", query: "installed" })));
assert(found.matched === 1 && found.results[0].type === "rectangle", "search did not find the labelled box");
assert(found.results[0].id === boxId, "search returned the label instead of the shape it belongs to");
const byNote = JSON.parse(text(await call("search_elements", { scene: "E2E", query: "wrong colour" })));
assert(byNote.results[0]?.id === boxId && byNote.results[0]?.match === "comment", "search did not find the comment");
log("search finds a label's shape and a comment's element");

log("comments attach, list, resolve and reopen");

await call("update_elements", { scene: "E2E", label: "nudge the box", elements: [{ id: boxId, x: 20 }] });
const [box] = JSON.parse(text(await call("read_elements", { scene: "E2E", ids: [boxId] }))).elements;
assert(box.x === 20 && box.width === 220, "delta update changed more than it should");

// moving a bound shape drags the arrow's end along, so the editor and the render agree
const ellipseId = made.elements.find((e) => e.type === "ellipse").id;
const moved = JSON.parse(text(await call("move_elements", { scene: "E2E", label: "shift the ellipse", ids: [ellipseId], dx: 30, dy: 10 })));
assert(moved.moved === 2 && moved.followed === 1, `move_elements moved ${moved.moved} and followed ${moved.followed}, expected 2 and 1`);
const [arrow] = JSON.parse(text(await call("read_elements", { scene: "E2E", type: "arrow" }))).elements;
const tip = arrow.points[arrow.points.length - 1];
assert(arrow.x === 225 && tip[0] === 180 && tip[1] === 10, `arrow end did not follow the ellipse: x=${arrow.x} tip=${JSON.stringify(tip)}`);

const history = JSON.parse(text(await call("list_history", { scene: "E2E" })));
assert(
  history.entries?.length >= 2 &&
    history.entries[0].label === "shift the ellipse" &&
    history.entries.some((e) => e.label === "comment on the box"),
  "labelled writes were not all snapshotted",
);
log("create, describe, delta update, move with bound arrow, history ok");

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

// an installed item is a vault write. Finding and placing it never rewrites the library.
const libraryElement = {
  type: "rectangle", version: 2, versionNonce: 1, isDeleted: false,
  id: "e2e-library-rect", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid",
  roughness: 1, opacity: 100, angle: 0, x: 10, y: 20, strokeColor: "#e8e6e3",
  backgroundColor: "#2b6b3a", width: 120, height: 60, seed: 1, groupIds: [],
  frameId: null, roundness: { type: 3 },
  boundElements: [{ id: "e2e-library-label", type: "text" }],
  updated: 1764000000000, link: null, locked: false,
};
const libraryLabel = {
  type: "text", version: 1, versionNonce: 2, isDeleted: false,
  id: "e2e-library-label", x: 15, y: 25, width: 110, height: 20,
  text: "Library label", originalText: "Library label", fontSize: 20,
  fontFamily: 5, textAlign: "left", verticalAlign: "top",
  containerId: "e2e-library-rect", fillStyle: "solid", strokeWidth: 2,
  strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0,
  strokeColor: "#e8e6e3", backgroundColor: "transparent",
  seed: 2, groupIds: [], frameId: null, boundElements: [],
  updated: 1764000000000, link: null, locked: false, roundness: null,
};
const fixture = await new Promise((resolve) => {
  const fixtureServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      type: "excalidrawlib", version: 1, source: "e2e",
      library: [[libraryElement, libraryLabel]],
    }));
  });
  fixtureServer.listen(0, "127.0.0.1", () =>
    resolve({ fixtureServer, url: `http://127.0.0.1:${fixtureServer.address().port}/pack.excalidrawlib` }),
  );
});
const firstInstall = JSON.parse(text(await call("install_library", { library: fixture.url })));
assert(firstInstall.added === 1 && firstInstall.total === 1, `install_library added ${firstInstall.added} of ${firstInstall.total}`);
const again = JSON.parse(text(await call("install_library", { library: fixture.url })));
assert(again.added === 0 && again.skipped === 1, "a second install duplicated the items");
fixture.fixtureServer.close();
const libPath = path.join(vault, "library.excalidrawlib");
const stored = JSON.parse(fs.readFileSync(libPath, "utf8"));
assert(stored.libraryItems[0].elements[0].id === libraryElement.id, "the installed item lost its source element");
const held = JSON.parse(text(await call("list_library", {
  query: "Library label", type: "rectangle",
})));
assert(held.total === 1 && held.items.length === 1, "list_library did not report the installed item");
assert(held.items[0].text[0] === "Library label" && held.items[0].types.rectangle === 1, "list_library did not describe the item's content");
const itemId = held.items[0].id;
const compact = JSON.parse(text(await call("read_library_item", { item: itemId })));
assert(compact.elements === 2 && compact.bounds.width === 120, "read_library_item summary is wrong");
const complete = JSON.parse(text(await call("read_library_item", { item: itemId, full: true })));
assert(complete.elements.length === 2, "read_library_item did not return the raw elements");
const libBytes = fs.readFileSync(libPath);
const inserted = JSON.parse(text(await call("insert_library_item", {
  scene: "E2E", item: itemId, x: 600, y: 200, label: "place the library item",
})));
assert(inserted.added === 2 && inserted.ids.length === 2, "insert_library_item did not add two elements");
assert(inserted.ids.every((id) => id !== libraryElement.id && id !== libraryLabel.id), "insert_library_item reused source ids");
assert(inserted.bounds.x === 600 && inserted.bounds.y === 200, `insert landed at ${JSON.stringify(inserted.bounds)}`);
assert(fs.readFileSync(libPath).equals(libBytes), "placing an item rewrote the library file");
const placed = JSON.parse(text(await call("read_elements", { scene: "E2E", ids: inserted.ids })));
const clonedLabel = placed.elements.find((element) => element.text === "Library label");
assert(clonedLabel && clonedLabel.containerId === inserted.idMap[libraryElement.id], "the placed label lost its container");
const labelledHistory = JSON.parse(text(await call("list_history", { scene: "E2E" })));
assert(labelledHistory.entries.some((entry) => entry.label === "place the library item"), "the insert was not snapshotted with its label");
const insertedAgain = JSON.parse(text(await call("insert_library_item", {
  scene: "E2E", item: itemId, x: 800, y: 300, label: "place the library item again",
})));
assert(insertedAgain.added === 2, "the second insert did not add two elements");
assert(!insertedAgain.ids.some((id) => inserted.ids.includes(id)), "the second insert reused ids from the first");
log("library item found, read, inserted twice with labels, library bytes unchanged");

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
appChild = spawn(bin, ["app", "--port", String(port), "--no-open"], {
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
