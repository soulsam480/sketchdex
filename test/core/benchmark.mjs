import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases } from "./corpus.mjs";
import { collectIds, compare, normalize } from "./normalize.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const METRICS_PATH = path.join(ROOT, "server/font-metrics.json");
const BATCH_SIZE = 10;
const BATCH_COUNT = 10;
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const BENCH_TIMEOUT_MS = 10_000;
const INK = "#e9ecef";
const NOW = 1_700_000_000_000;

const corpusCase = (name) => {
  const found = cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`corpus case not found: ${name}`);
  return found;
};

const e2eSpecs = [
  { type: "rectangle", ref: "a", x: 0, y: 0, width: 220, height: 90, label: "installed", backgroundColor: "#2b6b3a" },
  { type: "ellipse", ref: "b", x: 380, y: 0, width: 170, height: 90, label: "rendered", backgroundColor: "#8a6a12" },
  { type: "arrow", x: 225, y: 45, width: 150, height: 0, start: "a", end: "b" },
];

async function loadJsBuilder() {
  process.env.SKETCHDEX_CORE = "js";
  const core = await import(pathToFileURL(path.join(ROOT, "server/core.js")).href);
  if (typeof core.buildElements !== "function") {
    throw new Error("server/core.js does not export buildElements");
  }
  return core.buildElements;
}

async function runJs(jsBuild, request) {
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    return await jsBuild(request.args.specs, {
      existing: request.args.existing,
      ink: request.args.ink,
    });
  } finally {
    Date.now = originalNow;
  }
}

function repeatedE2eSpecs() {
  const specs = [];
  for (let repeat = 0; repeat < 100; repeat += 1) {
    const dx = (repeat % 10) * 1000;
    const dy = Math.floor(repeat / 10) * 300;
    for (const spec of e2eSpecs) {
      const copy = { ...spec, x: spec.x + dx, y: spec.y + dy };
      if (copy.ref) copy.ref = `${copy.ref}-${repeat}`;
      if (copy.start) copy.start = `${copy.start}-${repeat}`;
      if (copy.end) copy.end = `${copy.end}-${repeat}`;
      specs.push(copy);
    }
  }
  return specs;
}

function textSpecs() {
  const seeds = [
    corpusCase("text-cjk").args.specs[0].text,
    corpusCase("text-emoji").args.specs[0].text,
    corpusCase("text-explicit-width").args.specs[0].text,
    corpusCase("text-long-word").args.specs[0].text,
  ];
  const families = [1, 2, 3, 5, 6, 7, 8];
  return Array.from({ length: 100 }, (_, index) => {
    const seed = seeds[index % seeds.length];
    return {
      type: "text",
      text: `${seed}   ${seed}  tail ${index}`,
      width: 180,
      x: (index % 10) * 220,
      y: Math.floor(index / 10) * 80,
      fontFamily: families[index % families.length],
    };
  });
}

function geometrySpecs() {
  const template = corpusCase("path-open-and-closed").args.specs[1];
  return Array.from({ length: 10 }, (_, index) => {
    const points = Array.from({ length: 200 }, (_, point) => {
      const angle = (point / 200) * Math.PI * 2;
      const radius = 120 + 30 * Math.sin(angle * 7 + index);
      return [index * 320 + Math.cos(angle) * radius, Math.sin(angle) * radius];
    });
    return { ...template, points, smooth: true, closed: true, resolution: 50 };
  });
}

async function existingWorkload(jsBuild) {
  const shapeTemplate = corpusCase("label-string").args.specs[0];
  const existingSpecs = Array.from({ length: 2500 }, (_, index) => ({
    ...shapeTemplate,
    id: `existing-shape-${index}`,
    ref: `existing-ref-${index}`,
    x: (index % 50) * 260,
    y: Math.floor(index / 50) * 140,
    width: 220,
    height: 90,
    label: `Existing ${index}`,
  }));
  const scene = await runJs(jsBuild, { op: "build", args: { specs: existingSpecs, existing: [], ink: INK } });
  if (scene.elements.length !== 5000) {
    throw new Error(`existing fixture has ${scene.elements.length} elements, expected 5000`);
  }
  const shapes = scene.elements.filter((element) => element.type === "rectangle");
  const arrowTemplate = corpusCase("arrow-bind-existing-id").args.specs[0];
  const specs = Array.from({ length: 100 }, (_, index) => ({
    ...arrowTemplate,
    id: `bound-arrow-${index}`,
    x: (index % 10) * 260,
    y: Math.floor(index / 10) * 140 + 45,
    start: shapes[index * 2].id,
    end: shapes[index * 2 + 1].id,
  }));
  return {
    name: "existing_5000",
    request: { op: "build", args: { specs, existing: scene.elements, ink: INK, now: NOW } },
    warmup: 20,
    coreIterations: 50,
    expected: { elements: 100, updated: 200 },
    inputIds: collectIds({ specs, existing: scene.elements }),
  };
}

async function buildWorkloads(jsBuild) {
  const build = (name, specs, expected) => {
    const request = { op: "build", args: { specs, existing: [], ink: INK, now: NOW } };
    return {
      name,
      request,
      warmup: name === "e2e" ? 100 : 20,
      coreIterations: name === "e2e" ? 500 : 50,
      expected,
      inputIds: collectIds(request.args),
    };
  };
  return [
    build("e2e", e2eSpecs, { elements: 5, updated: 0 }),
    build("e2e_x100", repeatedE2eSpecs(), { elements: 500, updated: 0 }),
    build("text", textSpecs(), { elements: 100, updated: 0 }),
    build("geometry", geometrySpecs(), { elements: 10, updated: 0 }),
    await existingWorkload(jsBuild),
  ];
}

function assertShape(workload, result) {
  const shaped = normalize(result, { inputIds: workload.inputIds });
  if (shaped.elements.length !== workload.expected.elements) {
    throw new Error(`${workload.name} built ${shaped.elements.length} elements, expected ${workload.expected.elements}`);
  }
  if (shaped.updated.length !== workload.expected.updated) {
    throw new Error(`${workload.name} updated ${shaped.updated.length} elements, expected ${workload.expected.updated}`);
  }
}

function assertParity(backend, workload, jsResult, nimResult) {
  const args = workload.request.args;
  const result = compare(jsResult, nimResult, { inputIds: collectIds(args) });
  if (!result.equal) {
    throw new Error(`${backend}/${workload.name} parity failed at ${result.path}: ${result.reason}`);
  }
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

async function measureBackend(backend, run, workloads, baselines) {
  const rows = [];
  for (const workload of workloads) {
    console.error(`benchmarking ${backend}/${workload.name}`);
    for (let index = 0; index < workload.warmup; index += 1) await run(workload.request);
    const sample = await run(workload.request);
    assertShape(workload, sample);
    assertParity(backend, workload, baselines.get(workload.name), sample);

    const batches = [];
    for (let batch = 0; batch < BATCH_COUNT; batch += 1) {
      const started = performance.now();
      for (let operation = 0; operation < BATCH_SIZE; operation += 1) await run(workload.request);
      batches.push((performance.now() - started) / BATCH_SIZE);
    }
    const p50 = percentile(batches, 0.5);
    const p95 = percentile(batches, 0.95);
    rows.push({ backend, workload: workload.name, p50, p95, ops: 1000 / p50, parity: "PASS" });
  }
  return rows;
}

function errorText(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}

class JsonLinesWorker {
  constructor(binary, args, env) {
    this.binary = binary;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.failure = null;
    this.child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.accept(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4096);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signal) => {
      this.failAll(new Error(`${binary} exited with code ${code} signal ${signal}: ${this.stderr}`));
    });
  }

  accept(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.failAll(new Error(`invalid JSON from ${this.binary}: ${error.message}`));
        return;
      }
      const waiting = this.pending.get(response?.id);
      if (!waiting) {
        this.failAll(new Error(`unexpected response id from ${this.binary}: ${errorText(response?.id)}`));
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(waiting.timer);
      if (response.ok === true) {
        waiting.resolve(response.result);
      } else {
        waiting.reject(new Error(`${this.binary} request failed: ${errorText(response.error)}`));
      }
    }
  }

  failAll(error) {
    if (this.failure) return;
    this.failure = error;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  send(op, args) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.binary} ${op} timed out after ${TIMEOUT_MS} ms`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const line = `${JSON.stringify({ id, op, args })}\n`;
      this.child.stdin.write(line, (error) => {
        const waiting = this.pending.get(id);
        if (!error || !waiting) return;
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        reject(error);
      });
    });
  }

  async close() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
      this.child.kill();
    });
  }
}

function binaryArgs(serve, metricsPath) {
  return [serve ? "--serve" : "--once", "--metrics", metricsPath];
}

function coldInput(request) {
  return `${JSON.stringify({ id: 1, op: request.op, args: request.args })}\n`;
}

function checkCold(child, context) {
  if (child.error) throw new Error(`${context}: ${child.error.message}`);
  if (child.status !== 0) {
    const detail = (child.stderr || "").trim().slice(-4096);
    throw new Error(`${context}: exit ${child.status}${detail ? `: ${detail}` : ""}`);
  }
}

function decodeCold(stdout, context) {
  let response;
  try {
    response = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${context}: invalid JSON response: ${error.message}`);
  }
  if (response?.ok !== true || !response.result) {
    throw new Error(`${context}: ${errorText(response?.error ?? response)}`);
  }
  return response.result;
}

function createColdRunner(binary, metricsPath) {
  const args = binaryArgs(false, metricsPath);
  const env = { ...process.env, SKETCHDEX_METRICS: metricsPath };
  return (request) => {
    const child = spawnSync(binary, args, {
      input: coldInput(request),
      encoding: "utf8",
      env,
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
    });
    checkCold(child, `${binary} ${request.op}`);
    return decodeCold(child.stdout, `${binary} ${request.op}`);
  };
}

function measureNimCore(binary, metricsPath, workloads, baselines, coldRun) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sketchdex-core-bench-"));
  const env = { ...process.env, SKETCHDEX_METRICS: metricsPath };
  const rows = [];
  try {
    for (const workload of workloads) {
      console.error(`benchmarking nim-core/${workload.name}`);
      const requestPath = path.join(directory, `${workload.name}.json`);
      writeFileSync(requestPath, JSON.stringify(workload.request));

      const sample = coldRun(workload.request);
      assertShape(workload, sample);
      assertParity("nim-core", workload, baselines.get(workload.name), sample);

      let iterations = workload.coreIterations;
      const samples = [];
      while (samples.length < BATCH_COUNT) {
        const child = spawnSync(binary, ["--bench", requestPath, String(iterations), "--metrics", metricsPath], {
          encoding: "utf8",
          env,
          maxBuffer: MAX_BUFFER,
          timeout: BENCH_TIMEOUT_MS,
        });
        if (child.error?.code === "ETIMEDOUT" && iterations > 1) {
          iterations = Math.max(1, Math.floor(iterations / 2));
          samples.length = 0;
          console.error(`nim-core/${workload.name}: exceeded 10 seconds; retrying with ${iterations} iterations`);
          continue;
        }
        checkCold(child, `${binary} --bench ${workload.name}`);

        let report;
        try {
          report = JSON.parse(child.stdout.trim());
        } catch (error) {
          throw new Error(`${binary} --bench ${workload.name}: invalid JSON response: ${error.message}`);
        }
        if (
          report?.iterations !== iterations ||
          !Number.isFinite(report.avgMs) ||
          report.avgMs <= 0 ||
          report.elements !== workload.expected.elements ||
          report.updated !== workload.expected.updated
        ) {
          throw new Error(`${binary} --bench ${workload.name}: invalid benchmark report: ${errorText(report)}`);
        }
        samples.push(report.avgMs);
      }

      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      rows.push({ backend: "nim-core", workload: workload.name, p50, p95, ops: 1000 / p50, parity: "PASS" });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return rows;
}

function commandOutput(command, args) {
  const child = spawnSync(command, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (child.error || child.status !== 0) return null;
  return child.stdout.trim();
}

function cpuModel() {
  if (process.platform === "darwin") {
    const model = commandOutput("sysctl", ["-n", "machdep.cpu.brand_string"]);
    if (model) return model;
  }
  if (process.platform === "linux") {
    try {
      const line = readFileSync("/proc/cpuinfo", "utf8").split("\n").find((entry) => entry.startsWith("model name"));
      if (line) return line.slice(line.indexOf(":") + 1).trim();
    } catch {
      return os.cpus()[0]?.model ?? "unavailable";
    }
  }
  return os.cpus()[0]?.model ?? process.env.PROCESSOR_IDENTIFIER ?? "unavailable";
}

function machineFacts() {
  const nimVersion = commandOutput("nim", ["--version"])?.split("\n")[0] ?? "unavailable";
  const commit = commandOutput("git", ["-C", ROOT, "rev-parse", "HEAD"]) ?? "unavailable";
  return [
    `OS: ${os.type()} ${os.release()} (${process.platform}/${os.arch()})`,
    `CPU: ${cpuModel()} (${os.cpus().length} logical processors)`,
    `Node: ${process.version}`,
    `Nim: ${nimVersion}`,
    `Git commit: ${commit}`,
    `Metrics: ${METRICS_PATH}`,
  ];
}

function resolveBinary() {
  if (process.env.SKETCHDEX_CORE_BIN) return path.resolve(process.env.SKETCHDEX_CORE_BIN);
  const corePath = path.join(ROOT, "nim/bin/sketchdex-core");
  const candidates = process.platform === "win32" ? [`${corePath}.exe`, corePath] : [corePath];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
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

function median(samples) {
  return percentile(samples, 0.5);
}

function rssParser() {
  if (process.platform === "darwin") {
    return {
      flag: "-l",
      pattern: /^[ \t]*(\d+)[ \t]+maximum resident set size[ \t]*$/im,
      multiplier: 1,
    };
  }
  if (process.platform === "linux") {
    return {
      flag: "-v",
      pattern: /^[ \t]*Maximum resident set size \(kbytes\):[ \t]*(\d+)[ \t]*$/im,
      multiplier: 1024,
    };
  }
  return null;
}

function coldRss(binary, metricsPath, workloads) {
  const time = "/usr/bin/time";
  const parser = rssParser();
  if (!parser) {
    console.log("Cold RSS skipped: unsupported platform for /usr/bin/time RSS output.");
    return [];
  }
  if (!existsSync(time)) {
    console.log("Cold RSS skipped: /usr/bin/time is unavailable.");
    return [];
  }
  const probe = spawnSync(time, [parser.flag, "/usr/bin/true"], { encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0 || !parser.pattern.test(probe.stderr || "")) {
    console.log(`Cold RSS skipped: /usr/bin/time does not support ${parser.flag} RSS output on this system.`);
    return [];
  }
  const env = { ...process.env, SKETCHDEX_METRICS: metricsPath };
  const rows = [];
  for (const workload of workloads) {
    console.error(`benchmarking nim-cold-rss/${workload.name}`);
    const samples = [];
    for (let launch = 0; launch < 20; launch += 1) {
      const child = spawnSync(time, [parser.flag, binary, ...binaryArgs(false, metricsPath)], {
        input: coldInput(workload.request),
        encoding: "utf8",
        env,
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
      });
      checkCold(child, `${binary} RSS ${workload.name} launch ${launch + 1}`);
      const match = (child.stderr || "").match(parser.pattern);
      if (!match) {
        console.log(`Cold RSS skipped: RSS field missing for ${workload.name}.`);
        return [];
      }
      const bytes = Number(match[1]) * parser.multiplier;
      if (!Number.isFinite(bytes) || bytes <= 0) {
        console.log(`Cold RSS skipped: invalid RSS value for ${workload.name}.`);
        return [];
      }
      samples.push(bytes);
    }
    rows.push({ workload: workload.name, mib: median(samples) / (1024 * 1024) });
  }
  return rows;
}

function printTable(rows) {
  console.log("| Backend | Workload | p50 ms | p95 ms | ops/s | Parity |");
  console.log("| --- | --- | ---: | ---: | ---: | --- |");
  for (const row of rows) {
    console.log(`| ${row.backend} | ${row.workload} | ${row.p50.toFixed(3)} | ${row.p95.toFixed(3)} | ${row.ops.toFixed(1)} | ${row.parity} |`);
  }
}

function printRss(rows) {
  if (!rows.length) return;
  console.log("");
  console.log("| Backend | Workload | Launches | Median max RSS MiB |");
  console.log("| --- | --- | ---: | ---: |");
  for (const row of rows) {
    console.log(`| nim-cold | ${row.workload} | 20 | ${row.mib.toFixed(2)} |`);
  }
}

function parseArgs(argv) {
  const options = { jsOnly: false, requireNim: false };
  for (const arg of argv) {
    if (arg === "--js-only") options.jsOnly = true;
    else if (arg === "--require-nim") options.requireNim = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.jsOnly && options.requireNim) throw new Error("--js-only and --require-nim cannot be combined");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const binary = resolveBinary();
  const hasBinary = !options.jsOnly && binaryAvailable(binary);
  let skipReason = null;
  let missingRequiredNim = false;
  if (options.jsOnly) {
    skipReason = "Nim columns skipped by --js-only.";
  } else if (!hasBinary) {
    skipReason = `Nim binary not found or not executable: ${binary}`;
    if (options.requireNim) {
      console.error(`${skipReason}; --require-nim makes this fatal.`);
      missingRequiredNim = true;
    } else {
      console.log(`${skipReason}; running the JS column only.`);
    }
  }

  console.log("## Machine facts");
  for (const fact of machineFacts()) console.log(`- ${fact}`);
  console.log("");
  console.log(`Warmup: e2e 100 operations, other workloads 20 operations. Timing: ${BATCH_COUNT} batches of ${BATCH_SIZE} operations. Percentiles use linear interpolation over batch means.`);
  console.log("nim-core: 10 samples per workload, 500 iterations for e2e and 50 for other workloads. Each sample excludes request parsing and process startup.");

  const jsBuild = await loadJsBuilder();
  const workloads = await buildWorkloads(jsBuild);
  const baselines = new Map();
  for (const workload of workloads) {
    const result = await runJs(jsBuild, workload.request);
    assertShape(workload, result);
    baselines.set(workload.name, result);
  }

  const rows = await measureBackend("js", (request) => runJs(jsBuild, request), workloads, baselines);

  let rssRows = [];
  if (hasBinary) {
    const env = { ...process.env, SKETCHDEX_METRICS: METRICS_PATH };
    const coldRun = createColdRunner(binary, METRICS_PATH);
    rows.push(...measureNimCore(binary, METRICS_PATH, workloads, baselines, coldRun));

    const worker = new JsonLinesWorker(binary, binaryArgs(true, METRICS_PATH), env);
    try {
      await worker.send("ping", {});
      rows.push(...await measureBackend("nim-warm", async (request) => worker.send(request.op, request.args), workloads, baselines));
    } finally {
      await worker.close();
    }
    rows.push(...await measureBackend("nim-cold", coldRun, workloads, baselines));
    rssRows = coldRss(binary, METRICS_PATH, workloads);
  }

  console.log("");
  console.log("## Results");
  console.log("js is in-process; nim-core is in-process inside the Nim process with the request parsed once; nim-warm and nim-cold include JSON IPC.");
  printTable(rows);
  printRss(rssRows);
  if (skipReason) console.log(`\n${skipReason} Nim parity and latency are pending.`);
  return missingRequiredNim ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`benchmark failed: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
