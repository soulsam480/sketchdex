import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const NOW = 1700000000000;
Date.now = () => NOW;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const METRICS_PATH = path.join(ROOT, "server/font-metrics.json");
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const PREVIEW_LIMIT = 4096;
const SEED = 1;
const GENERATED_COUNT = 500;

const url = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
const [{ cases, generatedCases }, { collectIds, compare, assertVolatile }, elements, geometry, sketch, paper, agent] = await Promise.all([
  import(url("test/core/corpus.mjs")),
  import(url("test/core/normalize.mjs")),
  import(url("server/elements.js")),
  import(url("server/geometry.js")),
  import(url("server/sketch.js")),
  import(url("server/paper.js")),
  import(url("server/agent.js")),
]);

const { buildElements, patchElement, growContainerFor, measureText, wrapText } = elements;
const { pointBounds } = geometry;
const { resample } = sketch;
const { inkFor, luminance, paperOf } = paper;
const { createAgentApi } = agent;

function parseArgs(argv) {
  const options = { filter: null, verbose: false, jsOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--filter") {
      if (i + 1 >= argv.length) throw new Error("--filter requires a substring");
      options.filter = argv[++i];
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--js-only") {
      options.jsOnly = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function resolveBinary() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return path.resolve(process.env.SKETCHDEX_CORE_BIN || path.join(ROOT, "nim/bin/sketchdex-core" + suffix));
}

function binaryAvailable(binary) {
  try {
    if (!statSync(binary).isFile()) return false;
    accessSync(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bounds(moved) {
  if (!moved.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of moved) {
    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + (element.width ?? 0));
    maxY = Math.max(maxY, element.y + (element.height ?? 0));
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

function updateElements(input, patches) {
  const list = Array.isArray(patches) && patches.length
    ? patches
    : (input.ids ?? []).map((id) => ({ id, ...(input.patch ?? {}) }));
  const wanted = new Map(list.filter((patch) => patch?.id).map((patch) => [patch.id, patch]));
  const touched = new Set();
  let output = input.elements.map((element) => {
    const next = wanted.get(element.id);
    if (!next) return element;
    touched.add(element.id);
    return patchElement(element, next);
  });
  const grown = new Map();
  for (const element of output) {
    if (!touched.has(element.id) || !element.containerId) continue;
    const container = output.find((candidate) => candidate.id === element.containerId);
    if (!container) continue;
    const bigger = growContainerFor(element, container);
    if (bigger !== container) grown.set(container.id, bigger);
  }
  if (grown.size) output = output.map((element) => grown.get(element.id) ?? element);
  return {
    elements: output,
    result: {
      updated: touched.size,
      missing: [...wanted.keys()].filter((id) => !touched.has(id)),
    },
  };
}

function moveSelection(input) {
  const { ids, groupIds, region } = input;
  const wantedIds = new Set(ids ?? []);
  const wantedGroups = new Set(groupIds ?? []);
  const box = region
    ? {
        x: region.x ?? -Infinity,
        y: region.y ?? -Infinity,
        width: region.width ?? Infinity,
        height: region.height ?? Infinity,
      }
    : null;
  const inBox = (element) =>
    box &&
    element.x + (element.width ?? 0) >= box.x &&
    element.y + (element.height ?? 0) >= box.y &&
    element.x <= box.x + box.width &&
    element.y <= box.y + box.height;

  const moving = new Set();
  for (const element of input.elements) {
    if (element.isDeleted) continue;
    if (wantedIds.has(element.id) || inBox(element) || (element.groupIds ?? []).some((group) => wantedGroups.has(group))) {
      moving.add(element.id);
    }
  }
  for (const element of input.elements) {
    if (element.containerId && moving.has(element.containerId)) moving.add(element.id);
  }
  const followed = new Set();
  for (const element of input.elements) {
    if (moving.has(element.id) || element.type !== "arrow" || !Array.isArray(element.points) || element.points.length < 2) continue;
    const startFollows = !!element.startBinding && moving.has(element.startBinding.elementId);
    const endFollows = !!element.endBinding && moving.has(element.endBinding.elementId);
    if (startFollows || endFollows) followed.add(element.id);
  }
  return { moving, followed };
}

function moveElements(input) {
  const { ids, dx = 0, dy = 0 } = input;
  const { moving, followed } = moveSelection(input);
  const moved = [];
  const output = input.elements.map((element) => {
    if (moving.has(element.id)) {
      const next = patchElement(element, { x: element.x + dx, y: element.y + dy });
      moved.push(next);
      return next;
    }
    if (element.type !== "arrow" || !Array.isArray(element.points) || element.points.length < 2) return element;
    const startFollows = !!element.startBinding && moving.has(element.startBinding.elementId);
    const endFollows = !!element.endBinding && moving.has(element.endBinding.elementId);
    if (!startFollows && !endFollows) return element;
    const points = element.points.map((point) => [point[0], point[1]]);
    let { x, y } = element;
    if (startFollows) {
      x += dx;
      y += dy;
      for (let i = 1; i < points.length; i += 1) {
        points[i][0] -= dx;
        points[i][1] -= dy;
      }
    }
    if (endFollows) {
      const last = points[points.length - 1];
      last[0] += dx;
      last[1] += dy;
    }
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    followed.add(element.id);
    return patchElement(element, {
      x,
      y,
      points,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    });
  });
  return {
    elements: output,
    result: {
      moved: moved.length,
      followed: followed.size,
      missing: [...new Set(ids ?? [])].filter((id) => !moving.has(id)),
      bounds: bounds(moved),
    },
  };
}

function deleteElements(input, ids) {
  const doomed = new Set(ids ?? []);
  for (const element of input.elements) {
    if (element.containerId && doomed.has(element.containerId)) doomed.add(element.id);
  }
  let removed = 0;
  const output = input.elements.map((element) => {
    if (element.isDeleted) return element;
    if (doomed.has(element.id)) {
      removed += 1;
      return { ...element, isDeleted: true, version: (element.version ?? 1) + 1 };
    }
    const start = element.startBinding && doomed.has(element.startBinding.elementId);
    const end = element.endBinding && doomed.has(element.endBinding.elementId);
    const bound = (element.boundElements ?? []).some((entry) => doomed.has(entry.id));
    if (!start && !end && !bound) return element;
    return {
      ...element,
      ...(start ? { startBinding: null } : {}),
      ...(end ? { endBinding: null } : {}),
      ...(bound ? { boundElements: element.boundElements.filter((entry) => !doomed.has(entry.id)) } : {}),
      version: (element.version ?? 1) + 1,
    };
  });
  return { elements: output, result: { deleted: removed } };
}

function requestedAgentIds(method, args) {
  if (method === "updateElements") {
    if (Array.isArray(args.patches) && args.patches.length) {
      return args.patches.map((patch) => patch?.id).filter((id) => typeof id === "string");
    }
    return args.ids ?? [];
  }
  return args.ids ?? [];
}

function affectedAgentIds(method, args) {
  if (method === "moveElements") {
    const { moving, followed } = moveSelection(args);
    return new Set([...moving, ...followed]);
  }
  const affected = new Set(requestedAgentIds(method, args));
  for (const element of args.elements) {
    if (affected.has(element.id) && element.containerId) affected.add(element.containerId);
  }
  return affected;
}

function assertSavedIdentity(method, args, saved, caseName) {
  const before = args.elements;
  const after = saved.elements;
  const affected = affectedAgentIds(method, args);
  assert.equal(after.length, before.length, `${caseName}: ${method} changed the element count`);
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index].id, before[index].id, `${caseName}: ${method} changed element identity at ${index}`);
    if (!affected.has(before[index].id)) {
      assert.equal(after[index].index, before[index].index, `${caseName}: ${method} changed index for unrelated id ${JSON.stringify(before[index].id)}`);
    }
  }
  const beforeIds = new Set(before.map((element) => element.id));
  const afterIds = new Set(after.map((element) => element.id));
  for (const id of requestedAgentIds(method, args)) {
    if (beforeIds.has(id)) {
      assert(afterIds.has(id), `${caseName}: ${method} dropped requested id ${JSON.stringify(id)}`);
    }
  }
}

function assertDeleteScene(args, saved, caseName) {
  const before = args.elements;
  const after = saved.elements;
  const doomed = new Set(args.ids ?? []);
  for (const element of before) {
    if (element.containerId && doomed.has(element.containerId)) doomed.add(element.id);
  }
  const afterById = new Map(after.map((element) => [element.id, element]));
  const beforeIds = new Set(before.map((element) => element.id));
  for (const id of args.ids ?? []) {
    if (!beforeIds.has(id)) continue;
    assert.equal(afterById.get(id)?.isDeleted, true, `${caseName}: deleteElements did not delete requested id ${JSON.stringify(id)}`);
  }
  for (const element of before) {
    const output = afterById.get(element.id);
    assert(output, `${caseName}: deleteElements dropped id ${JSON.stringify(element.id)}`);
    if (doomed.has(element.id)) {
      assert.equal(output.isDeleted, true, `${caseName}: deleteElements did not delete bound id ${JSON.stringify(element.id)}`);
    } else {
      assert.equal(output.isDeleted, element.isDeleted, `${caseName}: deleteElements changed unrelated isDeleted for ${JSON.stringify(element.id)}`);
    }
  }
  for (const element of after) {
    if (element.type !== "arrow" || element.isDeleted) continue;
    for (const key of ["startBinding", "endBinding"]) {
      const targetId = element[key]?.elementId;
      if (doomed.has(targetId)) {
        assert.equal(element[key], null, `${caseName}: deleteElements left ${key} attached to deleted id ${JSON.stringify(targetId)}`);
      }
    }
  }
}

function runAgentLoop(api, method, args, caseName) {
  const payload = { elements: args.elements, appState: {}, files: {}, rev: "scratch" };
  api.store.list = async () => [{ id: "scratch", name: "scratch" }];
  api.store.read = async () => payload;
  let saved;
  api.store.save = async (_id, next) => {
    saved = next;
    return {};
  };
  api.history.take = async () => {};
  api.history.claim = async () => {};
  let result;
  if (method === "updateElements") {
    result = api.updateElements("scratch", args.patches, { label: "differential", ids: args.ids, patch: args.patch });
  } else if (method === "moveElements") {
    result = api.moveElements("scratch", { ...args, label: "differential" });
  } else {
    result = api.deleteElements("scratch", args.ids, { label: "differential" });
  }
  assert(result && typeof result.then === "function", `${caseName}: ${method} must return a promise`);
  return result.then((value) => {
    assert(saved && Array.isArray(saved.elements), `${caseName}: ${method} did not save elements`);
    if (method === "deleteElements") {
      assert.equal(typeof value.deleted, "number", `${caseName}: deleteElements did not return a deleted count`);
      assertSavedIdentity(method, args, saved, caseName);
      assertDeleteScene(args, saved, caseName);
      return saved.elements;
    }
    assertSavedIdentity(method, args, saved, caseName);
    return saved;
  });
}

const jsDispatch = new Map([
  ["build", (args) => buildElements(args.specs, {
    existing: args.existing,
    ink: Object.hasOwn(args, "ink") ? args.ink : inkFor(paperOf({ appState: args.appState })),
  })],
  ["patch", (args) => patchElement(args.element, args.patch)],
  ["grow", (args) => growContainerFor(args.text, args.container)],
  ["measure", (args) => measureText(args.text, args.fontSize, args.fontFamily)],
  ["wrap", (args) => wrapText(args.text, args.maxWidth, args.fontSize, args.fontFamily)],
  ["resample", (args) => resample(args.points, args.step)],
  ["ink", (args) => inkFor(args.paper)],
  ["luminance", (args) => luminance(args.color)],
  ["bounds", (args) => pointBounds(args.points)],
  ["update", (args) => updateElements(args, args.patches)],
  ["move", (args) => moveElements(args)],
  ["delete", (args) => deleteElements(args, args.ids)],
]);

const agentDispatch = new Map([
  ["update", "updateElements"],
  ["move", "moveElements"],
  ["delete", "deleteElements"],
]);

const supportedOps = new Set([...jsDispatch.keys(), ...agentDispatch.keys()]);

function isNimOp(testCase) {
  return testCase.op !== "update" && testCase.op !== "move" && testCase.op !== "delete";
}

function assertNimBuildArgs(testCase) {
  const { specs, existing } = testCase.args;
  for (const [name, value] of [["specs", specs], ["existing", existing]]) {
    assert(value == null || Array.isArray(value), `${testCase.name}: ${name} must be nullish or an array`);
  }
}

function assertClock() {
  const result = buildElements([{ type: "rectangle" }], { existing: [], ink: "#1e1e1e" });
  assert.equal(result.elements[0].updated, NOW, "JavaScript build did not use the overridden clock");
}

async function runJs(testCase) {
  const args = testCase.args;
  const method = agentDispatch.get(testCase.op);
  if (method) {
    const api = createAgentApi(path.join(ROOT, ".opencode/differential-scratch"));
    return runAgentLoop(api, method, args, testCase.name);
  }
  const dispatch = jsDispatch.get(testCase.op);
  assert(dispatch, `no JavaScript dispatch for op ${testCase.op}`);
  return dispatch(args);
}

function assertNimVolatile(value, inputIds) {
  assertVolatile(value, { inputIds });
}

export function assertSuppliedVolatile(testCase, jsResult, nimResult) {
  const fields = ["seed", "versionNonce", "updated"];
  const roots = [];
  if (testCase.op === "build") roots.push(["specs", testCase.args.specs]);
  if (testCase.op === "patch") roots.push(["element", testCase.args.element]);
  if (testCase.op === "grow") roots.push(["container", testCase.args.container]);

  const outputElements = (result) => {
    if (testCase.op === "build") return result?.elements ?? [];
    return result && typeof result === "object" && !Array.isArray(result) ? [result] : [];
  };
  const jsElements = outputElements(jsResult);
  const nimElements = outputElements(nimResult);

  const visit = (value, path) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    const supplied = fields.filter((field) => Object.hasOwn(value, field));
    if (supplied.length) {
      assert(
        typeof value.id === "string",
        `${testCase.name}: ${path} has supplied ${supplied.join(", ")} but no string id`,
      );
      for (const [backend, elements] of [["JS", jsElements], ["Nim", nimElements]]) {
        const output = elements.find((element) => element?.id === value.id);
        assert(output, `${testCase.name}: ${backend} output is missing supplied id ${JSON.stringify(value.id)}`);
        for (const field of supplied) {
          assert.equal(
            output[field],
            value[field],
            `${testCase.name}: ${backend} changed supplied ${field} for id ${JSON.stringify(value.id)}`,
          );
        }
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };

  for (const [name, root] of roots) visit(root, name);
}

function buildNimArgs(testCase) {
  const args = { ...testCase.args };
  if (["build", "patch", "grow"].includes(testCase.op)) args.now = NOW;
  if (testCase.op === "measure" || testCase.op === "wrap") {
    args.text = String(args.text ?? "");
    if (!Object.hasOwn(args, "fontSize")) args.fontSize = 20;
    if (!Object.hasOwn(args, "fontFamily")) args.fontFamily = 5;
  }
  if (testCase.op === "ink") args.paper = String(args.paper ?? "");
  if (testCase.op === "luminance") args.color = String(args.color ?? "");
  if (testCase.op === "resample" && !Object.hasOwn(args, "step")) args.step = 18;
  if (testCase.op === "build" && !Object.hasOwn(args, "ink")) {
    args.ink = inkFor(paperOf({ appState: args.appState }));
  }
  return args;
}

function preview(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n... trimmed ...` : text;
}

function protocolFailure(testCase, index, child, context) {
  const stderr = String(child.stderr ?? "").slice(-4096);
  const detail = child.error?.message ?? (child.signal ? `signal ${child.signal}` : `exit ${child.status}`);
  console.error(`FAIL op=${testCase.op} index=${index} name=${testCase.name}`);
  console.error(`reason: protocol failure: ${context}: ${detail}`);
  if (stderr) console.error(`Nim stderr (last 4 KB):\n${stderr}`);
}

function runNim(binary, testCase, index) {
  const id = index + 1;
  if (testCase.op === "build") assertNimBuildArgs(testCase);
  const request = { id, op: testCase.op, args: buildNimArgs(testCase) };
  const child = spawnSync(binary, ["--once", "--metrics", METRICS_PATH], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  if (child.error || child.status !== 0) {
    protocolFailure(testCase, index, child, child.error?.code ?? `process exited with status ${child.status}`);
    return { ok: false };
  }
  const stdout = String(child.stdout ?? "");
  if (!stdout.includes("\n")) {
    protocolFailure(testCase, index, child, "stdout has no newline");
    return { ok: false };
  }
  const line = stdout.split("\n", 1)[0].trim();
  let response;
  try {
    response = JSON.parse(line);
  } catch (error) {
    protocolFailure(testCase, index, child, `invalid JSON response: ${error.message}`);
    return { ok: false };
  }
  if (!response || response.id !== id || typeof response.ok !== "boolean") {
    protocolFailure(testCase, index, child, "response id or ok field is invalid");
    return { ok: false };
  }
  if (!response.ok) {
    console.error(`FAIL op=${testCase.op} index=${index} name=${testCase.name}`);
    console.error(`reason: Nim error: ${preview(response.error)}`);
    const stderr = String(child.stderr ?? "").slice(-4096);
    if (stderr) console.error(`Nim stderr (last 4 KB):\n${stderr}`);
    console.error(`Nim request: ${preview(request)}`);
    return { ok: false };
  }
  return { ok: true, result: unwrapNimResult(testCase.op, response.result) };
}

function unwrapNimResult(op, result) {
  if (op === "patch") return result?.element;
  if (op === "grow") return result?.container;
  if (op === "measure") return { width: result?.width, height: result?.height };
  if (op === "wrap") return result?.text;
  if (op === "ink") return result?.ink;
  if (op === "luminance") return result?.luminance;
  if (op === "resample") return result?.points;
  return result;
}

function reportMismatch(testCase, index, jsResult, nimResult, difference, inputIds) {
  console.error(`FAIL op=${testCase.op} index=${index} name=${testCase.name}`);
  console.error(`path: ${difference.path}`);
  console.error(`reason: ${difference.reason}`);
  console.error(`JS: ${preview(jsResult)}`);
  console.error(`Nim: ${preview(nimResult)}`);
  console.error(`inputIds: ${preview([...inputIds])}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const handWritten = cases;
  const generated = generatedCases(SEED, GENERATED_COUNT);
  const handWrittenCore = handWritten.filter(isNimOp);
  const compared = [...handWrittenCore, ...generated];
  const comparedIndex = new Map(compared.map((testCase, index) => [testCase, index]));
  const allCases = [
    ...handWritten.map((testCase, index) => ({ testCase, index, group: "hand-written" })),
    ...generated.map((testCase, index) => ({ testCase, index, group: "generated" })),
  ];
  const selected = allCases.filter(({ testCase }) => options.filter === null || testCase.name.includes(options.filter));
  const selectedCore = selected.filter(({ testCase }) => isNimOp(testCase));
  const selectedAgentOnly = selected.filter(({ testCase }) => !isNimOp(testCase));
  const selectedCoreHandWritten = selectedCore.filter(({ group }) => group === "hand-written").length;
  const selectedGenerated = selectedCore.filter(({ group }) => group === "generated").length;

  let binary = null;
  if (!options.jsOnly) {
    binary = resolveBinary();
    if (!binaryAvailable(binary)) {
      console.error(`Nim binary not found or not executable: ${binary}`);
      console.error(`Build it with: npm run build:core`);
      console.error(`Then run: node test/core/differential.mjs${options.filter === null ? "" : ` --filter ${JSON.stringify(options.filter)}`}`);
      printSummary({
        coreHandWritten: selectedCoreHandWritten,
        agentOnlyPassed: 0,
        agentOnlyFailed: 0,
        generated: selectedGenerated,
        passed: 0,
        failed: 0,
        elapsed: performance.now() - started,
        coreStatus: "not run",
        generatedStatus: "not run",
        agentOnlyStatus: "not run",
      });
      return 1;
    }
  }

  assertClock();
  const clockProbe = cases.find((testCase) => testCase.op === "build" && Array.isArray(testCase.args.specs) && testCase.args.specs.length > 0);
  assert(clockProbe, "corpus must contain a non-empty build case");
  const clockResult = await runJs(clockProbe);
  assert.equal(clockResult.elements[0].updated, NOW, "JavaScript corpus build result.updated did not use the overridden clock");

  const unsupported = selected.filter(({ testCase }) => !supportedOps.has(testCase.op));
  assert.equal(unsupported.length, 0, `unsupported corpus ops: ${unsupported.map(({ testCase }) => `${testCase.op} (${testCase.name})`).join(", ")}`);

  let passed = 0;
  let failed = 0;
  let agentOnlyPassed = 0;
  let agentOnlyFailed = 0;

  for (const { testCase } of selectedAgentOnly) {
    try {
      const jsResult = await runJs(testCase);
      if (options.verbose) console.log(`AGENT-ONLY ${testCase.name}: ${preview(jsResult)}`);
      agentOnlyPassed += 1;
    } catch (error) {
      console.error(`FAIL agent-only name=${testCase.name}`);
      console.error(`reason: ${error?.stack ?? error?.message ?? error}`);
      agentOnlyFailed += 1;
      break;
    }
  }

  for (const { testCase } of selectedCore) {
    const inputIds = collectIds(testCase.args);
    const index = comparedIndex.get(testCase);
    let jsResult;
    let nimResult = null;
    try {
      jsResult = await runJs(testCase);
      if (options.jsOnly) {
        if (options.verbose) console.log(`PASS ${testCase.name}: ${preview(jsResult)}`);
        passed += 1;
        continue;
      }
      const nimRun = runNim(binary, testCase, index);
      if (!nimRun.ok) {
        failed += 1;
        break;
      }
      nimResult = nimRun.result;
      assertNimVolatile(nimResult, inputIds);
      assertSuppliedVolatile(testCase, jsResult, nimResult);
      const difference = compare(jsResult, nimResult, { inputIds });
      if (!difference.equal) {
        reportMismatch(testCase, index, jsResult, nimResult, difference, inputIds);
        failed += 1;
        break;
      }
      if (options.verbose) console.log(`PASS ${testCase.name}: ${preview(jsResult)}`);
      passed += 1;
    } catch (error) {
      console.error(`FAIL op=${testCase.op} index=${index} name=${testCase.name}`);
      console.error(`path: $`);
      console.error(`reason: ${error?.stack ?? error?.message ?? error}`);
      console.error(`JS: ${preview(jsResult)}`);
      console.error(`Nim: ${preview(nimResult)}`);
      failed += 1;
      break;
    }
  }

  if (options.filter !== null) console.log(`filter: ${options.filter}`);
  const jsPathStatus = "verified on the JS path";
  printSummary({
    coreHandWritten: selectedCoreHandWritten,
    agentOnlyPassed,
    agentOnlyFailed,
    generated: selectedGenerated,
    passed,
    failed,
    elapsed: performance.now() - started,
    coreStatus: options.jsOnly ? jsPathStatus : "compared",
    generatedStatus: options.jsOnly ? jsPathStatus : "compared",
    agentOnlyStatus: jsPathStatus,
  });
  return failed === 0 && agentOnlyFailed === 0 ? 0 : 1;
}

function printSummary({
  coreHandWritten,
  agentOnlyPassed,
  agentOnlyFailed,
  generated,
  passed,
  failed,
  elapsed,
  coreStatus,
  generatedStatus,
  agentOnlyStatus,
}) {
  console.log(`hand-written core: ${coreHandWritten} ${coreStatus}`);
  console.log(`hand-written agent-only: ${agentOnlyPassed} ${agentOnlyStatus}`);
  console.log(`generated: ${generated} ${generatedStatus}`);
  console.log(`passed: ${passed}`);
  console.log(`failed: ${failed}`);
  if (agentOnlyFailed) console.log(`agent-only failures: ${agentOnlyFailed}`);
  console.log(`elapsed: ${(elapsed / 1000).toFixed(3)}s`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`differential harness failed: ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  });
}
