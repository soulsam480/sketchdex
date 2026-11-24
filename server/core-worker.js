import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METRICS_PATH = fileURLToPath(new URL("./font-metrics.json", import.meta.url));
const CORE_PATH = fileURLToPath(new URL("../nim/bin/sketchdex-core", import.meta.url));
const CORE_VERSION = "0.1.0";
const HANDSHAKE_TIMEOUT = 2_000;
const REQUEST_TIMEOUT = 30_000;
const STDERR_LIMIT = 4 * 1024;
const LINE_LIMIT = 64 * 1024 * 1024;
const TERMINATE_GRACE = 250;

export class CoreError extends Error {
  constructor(message, { code = "core_error", requestId = null, exitCode = null, signal = null, stderr = "" } = {}) {
    super(stderr ? `${message}\n${stderr}` : message);
    this.name = "CoreError";
    this.code = code;
    this.requestId = requestId;
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

const workers = new Set();
let current = null;
let starting = null;
let closing = null;
let nextId = 1;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stderrText = (worker) => worker.stderr.toString("utf8");

function resolveBinary() {
  if (process.env.SKETCHDEX_CORE_BIN) {
    const binary = resolve(process.env.SKETCHDEX_CORE_BIN);
    if (!existsSync(binary)) {
      throw new CoreError(
        "Nim core binary not found. Set SKETCHDEX_CORE_BIN or build nim/bin/sketchdex-core.",
        { code: "core_missing" },
      );
    }
    return binary;
  }

  const candidates = [];
  if (process.platform === "win32") candidates.push(`${CORE_PATH}.exe`, CORE_PATH);
  else candidates.push(CORE_PATH);

  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new CoreError(
      "Nim core binary not found. Set SKETCHDEX_CORE_BIN or build nim/bin/sketchdex-core.",
      { code: "core_missing" },
    );
  }
  return binary;
}

function rejectPending(worker, code, message, details = {}) {
  const pending = [...worker.pending.values()];
  worker.pending.clear();
  for (const request of pending) {
    clearTimeout(request.timer);
    request.reject(
      new CoreError(message, {
        code,
        stderr: stderrText(worker),
        ...details,
        requestId: request.id,
      }),
    );
  }
  return new CoreError(message, {
    code,
    stderr: stderrText(worker),
    ...details,
    requestId: details.requestId ?? pending[0]?.id ?? null,
  });
}

function retireWorker(worker, { destroyStdin = true } = {}) {
  if (worker.closed) return;
  if (destroyStdin) {
    try {
      worker.child.stdin.destroy();
    } catch {}
  }
  if (!worker.retiring) {
    worker.retiring = true;
    try {
      worker.child.kill("SIGTERM");
    } catch {}
  }
  if (worker.retireTimer === null) {
    worker.retireTimer = setTimeout(() => {
      worker.retireTimer = null;
      if (worker.closed) return;
      try {
        worker.child.kill("SIGKILL");
      } catch {}
    }, TERMINATE_GRACE);
  }
}

function failWorker(worker, code, message, details = {}) {
  if (worker.failed) return worker.error;
  worker.failed = true;
  worker.stdoutChunks = [];
  worker.stdoutBytes = 0;
  if (current === worker) current = null;
  worker.error = rejectPending(worker, code, message, details);
  retireWorker(worker);
  return worker.error;
}

function handleLine(worker, line) {
  if (worker.failed || !line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    failWorker(worker, "core_protocol", "Nim core returned malformed JSON.");
    return;
  }

  if (!isRecord(message) || !Number.isSafeInteger(message.id) || message.id < 1) {
    failWorker(worker, "core_protocol", "Nim core returned an invalid response envelope.");
    return;
  }

  const pending = worker.pending.get(message.id);
  if (!pending) return;
  if (typeof message.ok !== "boolean") {
    failWorker(worker, "core_protocol", "Nim core returned an invalid response status.", { requestId: message.id });
    return;
  }

  if (message.ok) {
    if (!isRecord(message.result)) {
      failWorker(worker, "core_protocol", "Nim core returned an invalid result.", { requestId: message.id });
      return;
    }
    clearTimeout(pending.timer);
    worker.pending.delete(message.id);
    pending.resolve({ id: message.id, result: message.result });
    return;
  }

  if (!isRecord(message.error) || typeof message.error.message !== "string" || typeof message.error.kind !== "string") {
    failWorker(worker, "core_protocol", "Nim core returned an invalid error.", { requestId: message.id });
    return;
  }
  clearTimeout(pending.timer);
  worker.pending.delete(message.id);
  pending.reject(
    new CoreError(message.error.message, {
      code: message.error.kind || "core_error",
      requestId: message.id,
      stderr: stderrText(worker),
    }),
  );
}

function send(worker, op, args, timeout, timeoutCode) {
  if (worker.failed || worker.closing || current !== worker) {
    return Promise.reject(new CoreError("Nim core is not available.", { code: "core_exit" }));
  }

  const id = nextId++;
  let line;
  try {
    line = `${JSON.stringify({ id, op, args })}\n`;
  } catch (error) {
    return Promise.reject(error);
  }
  if (Buffer.byteLength(line, "utf8") > LINE_LIMIT) {
    return Promise.reject(
      new CoreError(`Nim core ${op} request exceeds the 64 MiB line limit.`, {
        code: "core_request_too_large",
        requestId: id,
      }),
    );
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      failWorker(worker, timeoutCode, `Nim core ${op} timed out after ${timeout} ms.`, { requestId: id });
    }, timeout);
    worker.pending.set(id, { id, resolve: resolvePromise, reject: rejectPromise, timer });

    try {
      worker.child.stdin.write(line);
    } catch (error) {
      failWorker(worker, "core_exit", `Nim core request write failed: ${error.message}`, { requestId: id });
    }
  });
}

function appendStdout(worker, bytes) {
  if (bytes.length === 0) return true;
  worker.stdoutChunks.push(bytes);
  worker.stdoutBytes += bytes.length;
  if (worker.stdoutBytes <= LINE_LIMIT) return true;
  failWorker(worker, "core_protocol", "Nim core returned a response line over 64 MiB.");
  return false;
}

function finishStdoutLine(worker) {
  const lineBytes =
    worker.stdoutChunks.length === 1
      ? worker.stdoutChunks[0]
      : Buffer.concat(worker.stdoutChunks, worker.stdoutBytes);
  worker.stdoutChunks = [];
  worker.stdoutBytes = 0;

  let line;
  try {
    line = worker.decoder.decode(lineBytes);
  } catch {
    failWorker(worker, "core_protocol", "Nim core returned invalid UTF-8.");
    return;
  }
  if (line.endsWith("\r")) line = line.slice(0, -1);
  handleLine(worker, line);
}

function appendStderr(worker, chunk) {
  const combined = Buffer.concat([worker.stderr, chunk]);
  worker.stderr = Buffer.from(combined.subarray(Math.max(0, combined.length - STDERR_LIMIT)));
}

function attachWorker(worker) {
  const { child } = worker;

  child.stdout.on("data", (chunk) => {
    if (worker.failed) return;
    let start = 0;
    while (!worker.failed) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        appendStdout(worker, chunk.subarray(start));
        break;
      }
      if (!appendStdout(worker, chunk.subarray(start, newline))) return;
      finishStdoutLine(worker);
      start = newline + 1;
    }
    if (worker.failed) {
      worker.stdoutChunks = [];
      worker.stdoutBytes = 0;
    }
  });
  child.stdout.on("end", () => {
    if (worker.stdoutBytes > 0) {
      failWorker(worker, "core_protocol", "Nim core returned an unterminated response.");
    }
  });
  child.stdout.on("error", (error) => {
    failWorker(worker, "core_exit", `Nim core stdout failed: ${error.message}`);
  });

  child.stderr.on("data", (chunk) => {
    appendStderr(worker, chunk);
    if (process.env.SKETCHDEX_CORE_DEBUG === "1") process.stderr.write(chunk);
  });
  child.stderr.on("error", (error) => {
    failWorker(worker, "core_exit", `Nim core stderr failed: ${error.message}`);
  });

  child.stdin.on("error", (error) => {
    failWorker(worker, "core_exit", `Nim core stdin failed: ${error.message}`);
  });
  child.on("error", (error) => {
    failWorker(worker, "core_exit", `Nim core process error: ${error.message}`);
  });
  child.on("close", (exitCode, signal) => {
    worker.closed = true;
    workers.delete(worker);
    clearTimeout(worker.retireTimer);
    worker.retireTimer = null;
    if (current === worker) current = null;
    if (!worker.failed) {
      const status = signal ? `signal ${signal}` : `exit code ${exitCode}`;
      failWorker(worker, "core_exit", `Nim core exited with ${status}.`, { exitCode, signal });
    }
  });
}

async function startWorker() {
  const binary = resolveBinary();
  let child;
  try {
    child = spawn(binary, ["--serve", "--metrics", METRICS_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, SKETCHDEX_METRICS: METRICS_PATH },
    });
  } catch (error) {
    throw new CoreError(`Nim core failed to spawn: ${error.message}`, { code: "core_exit" });
  }

  const worker = {
    child,
    pending: new Map(),
    stdoutChunks: [],
    stdoutBytes: 0,
    decoder: new TextDecoder("utf-8", { fatal: true }),
    stderr: Buffer.alloc(0),
    ready: false,
    closing: false,
    failed: false,
    closed: false,
    retiring: false,
    retireTimer: null,
    error: null,
  };
  workers.add(worker);
  current = worker;
  attachWorker(worker);

  try {
    const { id, result } = await send(worker, "ping", {}, HANDSHAKE_TIMEOUT, "core_handshake");
    if (!isRecord(result) || typeof result.version !== "string" || !result.version.trim()) {
      throw failWorker(worker, "core_handshake", "Nim core returned an invalid ping version.", { requestId: id });
    }
    if (result.version !== CORE_VERSION) {
      throw failWorker(worker, "core_handshake", `Nim core version ${result.version} is not ${CORE_VERSION}.`, {
        requestId: id,
      });
    }
    worker.ready = true;
    return worker;
  } catch (error) {
    if (!worker.failed) {
      throw failWorker(worker, "core_handshake", `Nim core ping failed (${error.code ?? "unknown"}).`, {
        requestId: error.requestId,
      });
    }
    if (error instanceof CoreError && error.code === "core_protocol") {
      throw new CoreError("Nim core ping returned an invalid response.", {
        code: "core_handshake",
        requestId: error.requestId,
        stderr: error.stderr,
      });
    }
    throw error;
  }
}

function getWorker() {
  if (current?.ready && !current.failed && !current.closing) return Promise.resolve(current);
  if (starting) return starting;
  if (closing) return closing.then(() => getWorker());
  starting = startWorker().finally(() => {
    starting = null;
  });
  return starting;
}

export async function buildElements(specs, { existing = [], ink = "#1e1e1e" } = {}) {
  const worker = await getWorker();
  const { id, result } = await send(
    worker,
    "build",
    { specs: specs ?? [], existing, ink },
    REQUEST_TIMEOUT,
    "core_timeout",
  );
  if (
    !isRecord(result) ||
    !Array.isArray(result.elements) ||
    !Array.isArray(result.warnings) ||
    !Array.isArray(result.updated)
  ) {
    throw failWorker(worker, "core_protocol", "Nim core returned an invalid build result.", { requestId: id });
  }
  return result;
}

export async function closeCore() {
  if (closing) return closing;
  const worker = current;
  if (!worker) return;

  worker.closing = true;
  worker.failed = true;
  if (current === worker) current = null;
  worker.error = rejectPending(worker, "core_closed", "Nim core was closed.");
  closing = new Promise((resolvePromise) => {
    worker.child.once("close", resolvePromise);
    if (worker.closed) {
      resolvePromise();
      return;
    }
    try {
      worker.child.stdin.end();
    } catch {
      worker.child.stdin.destroy();
    }
    retireWorker(worker, { destroyStdin: false });
  });

  try {
    await closing;
  } finally {
    closing = null;
    if (current === worker) current = null;
  }
}

export async function resetCoreForTests() {
  if (starting) await starting.catch(() => {});
  if (closing) await closing.catch(() => {});
  await closeCore();
  for (const worker of workers) {
    try {
      worker.child.stdin.destroy();
    } catch {}
    try {
      worker.child.kill("SIGKILL");
    } catch {}
  }
  current = null;
  starting = null;
  closing = null;
}

process.once("exit", () => {
  for (const worker of workers) {
    try {
      worker.child.stdin.destroy();
    } catch {}
    try {
      worker.child.kill("SIGKILL");
    } catch {}
  }
});
