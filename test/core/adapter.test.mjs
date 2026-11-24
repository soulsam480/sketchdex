import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildElements, closeCore, CoreError, resetCoreForTests } from "../../server/core-worker.js";

const execFileAsync = promisify(execFile);
const coreWorkerPath = fileURLToPath(new URL("../../server/core-worker.js", import.meta.url));
const corePath = fileURLToPath(new URL("../../server/core.js", import.meta.url));
const trackedPids = new Set();
const expectedResult = {
  elements: [{ id: "fake-element", type: "rectangle", x: 1, y: 2, width: 3, height: 4 }],
  warnings: ["fake warning"],
  updated: [{ id: "existing", x: 9 }],
};

function fakeCoreMain() {
  const { appendFileSync, existsSync, writeFileSync, writeSync } = require("node:fs");
  const { spawn } = require("node:child_process");
  const { join } = require("node:path");

  const directory = process.env.FAKE_CORE_DIR;
  const state = { builds: 0 };
  const buildResult = {
    elements: [{ id: "fake-element", type: "rectangle", x: 1, y: 2, width: 3, height: 4 }],
    warnings: ["fake warning"],
    updated: [{ id: "existing", x: 9 }],
  };

  appendFileSync(join(directory, "pids.jsonl"), `${process.pid}\n`);

  const reply = (id, result) => {
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  };

  const behaviors = {
    success(request) {
      return request.op === "ping" ? { version: "0.1.0" } : buildResult;
    },
    "invalid-json-ping"(request) {
      if (request.op === "ping") process.stdout.write("not-json\n");
    },
    "invalid-version-ping"(request) {
      if (request.op === "ping") return { version: 7 };
    },
    silent() {},
    "malformed-build"(request) {
      if (request.op !== "build") return { version: "0.1.0" };
      state.builds += 1;
      if (state.builds === 3) process.stdout.write("not-json\n");
    },
    "exit-build"(request) {
      if (request.op !== "build") return { version: "0.1.0" };
      writeSync(2, "fatal build failure\n");
      process.exit(17);
    },
    "silent-build-once"(request) {
      if (request.op !== "build") return { version: "0.1.0" };
      const marker = join(directory, "timed-out");
      if (existsSync(marker)) return buildResult;
      writeFileSync(marker, "");
      writeFileSync(join(directory, "build-received"), "");
    },
    "stderr-exit"(request) {
      if (request.op !== "ping") return { version: "0.1.0" };
      const payload = Buffer.alloc(8 * 1024, 0x61);
      payload.write("stderr-tail", payload.length - Buffer.byteLength("stderr-tail"));
      writeSync(2, payload);
      process.exit(19);
    },
    "version-mismatch"(request) {
      if (request.op === "ping") return { version: "0.2.0" };
      return buildResult;
    },
    "ignore-sigterm"(request) {
      if (request.op === "ping") return { version: "0.1.0" };
      if (request.op === "build") writeFileSync(join(directory, "build-received"), "");
    },
    "retire-then-success"(request) {
      if (request.op === "ping") return { version: "0.1.0" };
      const marker = join(directory, "retired");
      if (existsSync(marker)) return buildResult;
      writeFileSync(marker, "");
      process.stdout.write("not-json\n");
    },
    "delayed-close"(request) {
      if (request.op === "ping") return { version: "0.1.0" };
      if (request.op !== "build") return;
      const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], {
        stdio: ["ignore", "inherit", "ignore"],
      });
      appendFileSync(join(directory, "pids.jsonl"), `${holder.pid}\n`);
      holder.unref();
      writeFileSync(join(directory, "build-received"), "");
    },
    "oversized-line"(request) {
      if (request.op === "ping") return { version: "0.1.0" };
      if (request.op === "build") process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61));
    },
    "invalid-utf8"(request) {
      if (request.op === "ping") return { version: "0.1.0" };
      if (request.op === "build") writeSync(1, Buffer.from([0xff, 0x0a]));
    },
    "crash-once"(request) {
      if (request.op !== "build") return { version: "0.1.0" };
      const marker = join(directory, "crashed");
      if (existsSync(marker)) return buildResult;
      writeFileSync(marker, "");
      process.exit(21);
    },
    "invalid-build-result"(request) {
      if (request.op !== "build") return { version: "0.1.0" };
      return { elements: {}, warnings: [], updated: [] };
    },
  };

  const mode = process.env.FAKE_CORE_MODE;
  const retirementMarker = join(directory, "retired");
  const ignoresTermination =
    mode === "ignore-sigterm" ||
    mode === "delayed-close" ||
    (mode === "retire-then-success" && !existsSync(retirementMarker));
  const markExiting = () => writeFileSync(join(directory, "exiting"), "");
  if (ignoresTermination) {
    process.on("SIGTERM", () => appendFileSync(join(directory, "signals.jsonl"), "SIGTERM\n"));
    setInterval(() => {}, 1_000);
  }

  const handle = (request) => {
    appendFileSync(join(directory, "requests.jsonl"), `${JSON.stringify(request)}\n`);
    const result = behaviors[mode](request);
    if (result !== undefined) reply(request.id, result);
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => {
    if (mode === "delayed-close") markExiting();
    if (!ignoresTermination) process.exit(0);
  });
}

const fakeCoreSource = `#!/usr/bin/env node\n(${fakeCoreMain.toString()})();\n`;

function makeTempDir(t, { registerCleanup = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sketchdex-core-"));
  if (registerCleanup) t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readJsonLines(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForGone(pids, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.deepEqual(pids.filter(isAlive), [], "fake core processes still running");
}

async function waitForFile(path, timeout = 1_000, message = `timed out waiting for ${path}`) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail(message);
}

async function stopPids(pids) {
  for (const pid of pids) {
    trackedPids.add(pid);
    if (!isAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  try {
    await waitForGone(pids, 500);
  } catch {}
}

function createFixture(t, mode) {
  const directory = makeTempDir(t, { registerCleanup: false });
  const binary = join(directory, "fake-core");
  const requestsPath = join(directory, "requests.jsonl");
  const pidsPath = join(directory, "pids.jsonl");
  writeFileSync(binary, fakeCoreSource, { mode: 0o755 });
  chmodSync(binary, 0o755);

  const keys = ["SKETCHDEX_CORE_BIN", "SKETCHDEX_CORE", "SKETCHDEX_CORE_DEBUG", "FAKE_CORE_DIR", "FAKE_CORE_MODE"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SKETCHDEX_CORE_BIN = binary;
  process.env.SKETCHDEX_CORE = "nim";
  delete process.env.SKETCHDEX_CORE_DEBUG;
  process.env.FAKE_CORE_DIR = directory;
  process.env.FAKE_CORE_MODE = mode;

  t.after(async () => {
    try {
      await closeCore();
    } finally {
      try {
        const pids = (await readJsonLines(pidsPath)).map(Number);
        await stopPids(pids);
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  return {
    directory,
    binary,
    requestsPath,
    pidsPath,
    readRequests: () => readJsonLines(requestsPath),
    readPids: async () => (await readJsonLines(pidsPath)).map(Number),
  };
}

function hasCoreCode(code, requestId) {
  return (error) => {
    assert(error instanceof CoreError, `expected CoreError, received ${error}`);
    assert.equal(error.code, code);
    if (requestId !== undefined) assert.equal(error.requestId, requestId);
    return true;
  };
}

async function rejectionOf(promise) {
  let failure;
  await assert.rejects(promise, (error) => {
    failure = error;
    return true;
  });
  return failure;
}

function assertIncreasingIds(requests) {
  for (let index = 1; index < requests.length; index += 1) {
    assert(requests[index].id > requests[index - 1].id, "request ids must increase");
  }
}

async function runNode(script, env = {}) {
  return execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ...env },
    timeout: 3_000,
  });
}

beforeEach(async () => {
  let timer;
  try {
    await Promise.race([
      resetCoreForTests(),
      new Promise((resolvePromise) => {
        timer = setTimeout(resolvePromise, 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await stopPids([...trackedPids]);
    await resetCoreForTests();
  }
});

after(async () => {
  await stopPids([...trackedPids]);
});

test("Nim adapter pings, builds, and validates the result shape", async (t) => {
  const fixture = await createFixture(t, "success");

  const result = await buildElements([{ type: "rectangle" }]);

  assert.deepEqual(result, expectedResult);
  const requests = await fixture.readRequests();
  assert.deepEqual(requests.map((request) => request.op), ["ping", "build"]);
  assertIncreasingIds(requests);
});

test("Nim adapter rejects an invalid build result", async (t) => {
  const fixture = createFixture(t, "invalid-build-result");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_protocol")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
});

test("Nim adapter reports a missing binary", async (t) => {
  const directory = makeTempDir(t);
  const keys = ["SKETCHDEX_CORE_BIN", "SKETCHDEX_CORE"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.SKETCHDEX_CORE_BIN = join(directory, "does-not-exist");
  process.env.SKETCHDEX_CORE = "nim";
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await assert.rejects(buildElements([]), hasCoreCode("core_missing"));
});

for (const [name, mode] of [
  ["invalid JSON", "invalid-json-ping"],
  ["a non-string version", "invalid-version-ping"],
]) {
  test(`Nim adapter fails the handshake on ${name} and kills the child`, async (t) => {
    const fixture = createFixture(t, mode);

    const error = await rejectionOf(buildElements([]));
    hasCoreCode("core_handshake")(error);
    const requests = await fixture.readRequests();
    assert.equal(error.requestId, requests.find((request) => request.op === "ping").id);

    await waitForGone(await fixture.readPids());
  });
}

test("Nim adapter times out a silent handshake and kills the child", { timeout: 2_900 }, async (t) => {
  const fixture = createFixture(t, "silent");
  const started = performance.now();

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_handshake")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "ping").id);

  assert(performance.now() - started < 2_900, "handshake timeout took too long");
  await waitForGone(await fixture.readPids());
});

test("Nim adapter rejects a version mismatch during the handshake", async (t) => {
  const fixture = createFixture(t, "version-mismatch");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_handshake")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "ping").id);
  await waitForGone(await fixture.readPids());
});

test("Nim adapter rejects every pending request on malformed stdout", async (t) => {
  const fixture = createFixture(t, "malformed-build");

  const results = await Promise.allSettled([buildElements([]), buildElements([]), buildElements([])]);

  assert.equal(results.length, 3);
  const buildIds = (await fixture.readRequests())
    .filter((request) => request.op === "build")
    .map((request) => request.id);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    hasCoreCode("core_protocol")(result.reason);
    assert(buildIds.includes(result.reason.requestId));
  }
  assert.equal(new Set(results.map((result) => result.reason.requestId)).size, 3);
  assert.equal(buildIds.length, 3);
  await waitForGone(await fixture.readPids());
});

test("Nim adapter reports a non-zero exit with its code and stderr", async (t) => {
  const fixture = createFixture(t, "exit-build");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_exit")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
  assert.equal(error.exitCode, 17);
  assert.equal(error.signal, null);
  assert.match(error.stderr, /fatal build failure/);
});

test("Nim adapter times out a build, kills the child, and respawns", async (t) => {
  const fixture = createFixture(t, "silent-build-once");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = buildElements([]);
  await waitForFile(join(fixture.directory, "build-received"));
  t.mock.timers.tick(30_000);

  const error = await rejectionOf(pending);
  hasCoreCode("core_timeout")(error);
  const firstRequests = await fixture.readRequests();
  assert.equal(error.requestId, firstRequests.find((request) => request.op === "build").id);
  const firstPids = await fixture.readPids();
  await waitForGone(firstPids);

  assert.deepEqual(await buildElements([]), expectedResult);
  const pids = await fixture.readPids();
  assert.equal(pids.length, 2);
  assert.notEqual(pids[1], pids[0]);
  const requests = await fixture.readRequests();
  assertIncreasingIds(requests);
});

test("Nim adapter escalates to SIGKILL when a child ignores SIGTERM", async (t) => {
  const fixture = createFixture(t, "ignore-sigterm");
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const pending = buildElements([]);
  await waitForFile(join(fixture.directory, "build-received"));
  const [pid] = await fixture.readPids();
  t.mock.timers.tick(30_000);

  const error = await rejectionOf(pending);
  hasCoreCode("core_timeout")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
  assert(isAlive(pid));

  t.mock.timers.tick(249);
  assert(isAlive(pid));
  t.mock.timers.tick(1);
  await waitForGone([pid]);
});

test("Nim adapter keeps only the last 4 KiB of stderr", async (t) => {
  createFixture(t, "stderr-exit");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_exit")(error);
  assert.equal(error.exitCode, 19);
  const payload = Buffer.alloc(8 * 1024, 0x61);
  payload.write("stderr-tail", payload.length - Buffer.byteLength("stderr-tail"));
  const expected = payload.subarray(-4 * 1024).toString("utf8");
  assert.equal(error.stderr, expected);
  assert(error.stderr.endsWith("stderr-tail"));
  assert(Buffer.byteLength(error.stderr) <= 4 * 1024);
});

test("Nim adapter restarts after a crash", async (t) => {
  const fixture = createFixture(t, "crash-once");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_exit")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
  assert.equal(error.exitCode, 21);

  assert.deepEqual(await buildElements([]), expectedResult);
  const pids = await fixture.readPids();
  assert.equal(pids.length, 2);
  assert.notEqual(pids[1], pids[0]);
  assertIncreasingIds(await fixture.readRequests());
});

test("closeCore ends the child and a later build starts a new one", async (t) => {
  const fixture = createFixture(t, "success");

  assert.deepEqual(await buildElements([]), expectedResult);
  const firstPids = await fixture.readPids();
  assert.equal(firstPids.length, 1);

  await closeCore();
  await waitForGone(firstPids);

  assert.deepEqual(await buildElements([]), expectedResult);
  const pids = await fixture.readPids();
  assert.equal(pids.length, 2);
  assert.notEqual(pids[1], pids[0]);
  assertIncreasingIds(await fixture.readRequests());
});

test("closeCore rejects a pending request and resolves only after the child closes", async (t) => {
  const fixture = createFixture(t, "delayed-close");
  const pending = buildElements([]);
  await waitForFile(join(fixture.directory, "build-received"));
  const requests = await fixture.readRequests();
  const buildId = requests.find((request) => request.op === "build").id;
  const started = performance.now();
  let resolved = false;
  const closing = closeCore().then(() => {
    resolved = true;
  });

  const error = await rejectionOf(pending);
  hasCoreCode("core_closed", buildId)(error);
  await waitForFile(join(fixture.directory, "exiting"));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(resolved, false);

  await closing;
  assert(performance.now() - started >= 250, "closeCore resolved before stdio closed");
  await waitForGone(await fixture.readPids());
});

test("Nim adapter rejects an oversized stdout line", { timeout: 5_000 }, async (t) => {
  const fixture = createFixture(t, "oversized-line");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_protocol")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
  await waitForGone(await fixture.readPids());
});

test("Nim adapter rejects invalid UTF-8 on stdout", async (t) => {
  const fixture = createFixture(t, "invalid-utf8");

  const error = await rejectionOf(buildElements([]));
  hasCoreCode("core_protocol")(error);
  const requests = await fixture.readRequests();
  assert.equal(error.requestId, requests.find((request) => request.op === "build").id);
  await waitForGone(await fixture.readPids());
});

test("Nim adapter rejects a request line over 64 MiB before writing", async (t) => {
  const fixture = createFixture(t, "success");

  const error = await rejectionOf(buildElements(["x".repeat(64 * 1024 * 1024)]));
  hasCoreCode("core_request_too_large")(error);
  assert(Number.isSafeInteger(error.requestId));
  const requests = await fixture.readRequests();
  assert.deepEqual(requests.map((request) => request.op), ["ping"]);
});

test("core.js defaults to the JavaScript backend when SKETCHDEX_CORE is unset", async (t) => {
  const directory = makeTempDir(t);
  const env = { ...process.env, SKETCHDEX_CORE_BIN: join(directory, "does-not-exist") };
  delete env.SKETCHDEX_CORE;
  const coreUrl = JSON.stringify(pathToFileURL(corePath).href);

  await runNode(
    `
      import assert from "node:assert/strict";
      import { buildElements, CORE_BACKEND } from ${coreUrl};
      assert.equal(CORE_BACKEND, "js");
      assert.deepEqual(await buildElements([]), { elements: [], warnings: [], updated: [] });
    `,
    env,
  );
});

test("parent exit cleans up the Nim child", async (t) => {
  const fixture = createFixture(t, "success");
  const coreUrl = JSON.stringify(pathToFileURL(coreWorkerPath).href);

  await runNode(
    `
      import { buildElements } from ${coreUrl};
      await buildElements([]);
      process.exit(0);
    `,
  );

  const pids = await fixture.readPids();
  assert.equal(pids.length, 1);
  await waitForGone(pids, 1_000);
});

test("parent exit kills every tracked child, including a retiring child", async (t) => {
  const fixture = createFixture(t, "retire-then-success");
  const coreUrl = JSON.stringify(pathToFileURL(coreWorkerPath).href);
  const directory = JSON.stringify(fixture.directory);

  await runNode(
    `
      import assert from "node:assert/strict";
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const directory = ${directory};
      const nativeSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, delay, ...args) =>
        nativeSetTimeout(callback, delay === 250 ? 5_000 : delay, ...args);
      const { buildElements } = await import(${coreUrl});
      await assert.rejects(buildElements([]), { code: "core_protocol" });
      buildElements([]).catch(() => {});
      const pidsPath = join(directory, "pids.jsonl");
      while (readFileSync(pidsPath, "utf8").trim().split("\\n").length < 2) {
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
      }
      const pids = readFileSync(pidsPath, "utf8").trim().split("\\n").map(Number);
      assert.equal(pids.length, 2);
      process.kill(pids[0], 0);
      writeFileSync(join(directory, "parent-ready"), "");
      process.exit(0);
    `,
  );

  const pids = await fixture.readPids();
  assert.equal(pids.length, 2);
  const signalsPath = join(fixture.directory, "signals.jsonl");
  await waitForFile(signalsPath, 1_000, "retiring child did not record SIGTERM");
  const signals = await readFile(signalsPath, "utf8");
  assert.match(signals, /SIGTERM/);
  await waitForGone(pids, 1_000);
});
