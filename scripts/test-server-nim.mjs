import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "nim", "tests");
const win = process.platform === "win32";

const resolveCompiler = () => {
  if (process.env.SKETCHDEX_NIM) return { command: process.env.SKETCHDEX_NIM, args: [] };

  const onPath = spawnSync("nim", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!onPath.error) return { command: "nim", args: [] };

  return { command: "mise", args: ["exec", "--", "nim"] };
};

const tail = (value) => (value ?? "").trim().slice(-4000) || "<empty>";
const browserMissing = /SKIP: Chromium unavailable|BrowserNotFoundError|Chromium-based browser installed/i;

const tests = fs.readdirSync(testsDir)
  .filter((name) => name.startsWith("test_") && name.endsWith(".nim") && name !== "test_helpers.nim")
  .sort();

if (tests.length === 0) {
  console.error("No Nim server tests found.");
  process.exit(1);
}

const compiler = resolveCompiler();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sketchdex-server-nim-tests-"));
const serverBinary = process.env.SKETCHDEX_BIN ?? path.join(root, "nim", "bin", win ? "sketchdex.exe" : "sketchdex");
const env = {
  ...process.env,
  SKETCHDEX_BIN: serverBinary,
  SKETCHDEX_DIST: process.env.SKETCHDEX_DIST ?? path.join(root, "dist"),
};
const options = {
  cwd: root,
  env,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  maxBuffer: 16 * 1024 * 1024,
};
let passed = 0;
let failed = 0;
let skipped = 0;

try {
  for (const name of tests) {
    const started = performance.now();
    const stem = name.slice(0, -4);
    const binary = path.join(temp, win ? `${stem}.exe` : stem);
    const compiled = spawnSync(
      compiler.command,
      [
        ...compiler.args,
        "c",
        "--threads:on",
        "--hints:off",
        `--nimcache:${path.join(temp, name)}`,
        `-o:${binary}`,
        path.join("nim", "tests", name),
      ],
      options,
    );

    if (compiled.error || compiled.status !== 0) {
      failed += 1;
      const spawnError = compiled.error ? ` (${compiled.error.code ?? compiled.error.message})` : "";
      console.error(`FAIL ${name}`);
      console.error("stage: compile");
      console.error(`exit code: ${compiled.status ?? "unknown"}${spawnError}`);
      console.error(`stdout tail:\n${tail(compiled.stdout)}`);
      console.error(`stderr tail:\n${tail(compiled.stderr?.trim() || compiled.error?.message)}`);
      continue;
    }

    const result = spawnSync(binary, [], options);
    const elapsed = Math.round(performance.now() - started);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

    if (name === "test_render.nim" && browserMissing.test(output)) {
      skipped += 1;
      console.log(`SKIP ${name} (${elapsed})`);
      console.log(output.trim());
      continue;
    }

    if (result.error || result.status !== 0) {
      failed += 1;
      const spawnError = result.error ? ` (${result.error.code ?? result.error.message})` : "";
      console.error(`FAIL ${name}`);
      console.error("stage: run");
      console.error(`exit code: ${result.status ?? "unknown"}${spawnError}`);
      console.error(`stdout tail:\n${tail(result.stdout)}`);
      console.error(`stderr tail:\n${tail(result.stderr?.trim() || result.error?.message)}`);
      continue;
    }

    passed += 1;
    console.log(`PASS ${name} (${elapsed})`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(`Nim server tests: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed ? 1 : 0;
