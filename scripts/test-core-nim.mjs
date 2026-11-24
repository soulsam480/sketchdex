import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "nim", "tests");

const resolveCompiler = () => {
  if (process.env.SKETCHDEX_NIM) return { command: process.env.SKETCHDEX_NIM, args: [] };

  const onPath = spawnSync("nim", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!onPath.error) return { command: "nim", args: [] };

  return { command: "mise", args: ["exec", "--", "nim"] };
};

const tail = (value) => (value ?? "").trim().slice(-4000) || "<empty>";

for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
  if (!entry.isFile() || entry.name.endsWith(".nim")) continue;
  const mode = fs.statSync(path.join(testsDir, entry.name)).mode;
  if (process.platform === "win32" ? entry.name.endsWith(".exe") : (mode & 0o111) !== 0) {
    fs.rmSync(path.join(testsDir, entry.name), { force: true });
  }
}

const tests = fs.readdirSync(testsDir)
  .filter((name) => name.startsWith("test_") && name.endsWith(".nim") && name !== "test_helpers.nim")
  .sort();

const compiler = resolveCompiler();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sketchdex-nim-tests-"));
let failures = 0;

try {
  for (const name of tests) {
    const started = performance.now();
    const result = spawnSync(
      compiler.command,
      [...compiler.args, "c", "-r", "--hints:off", `-o:${path.join(temp, name.slice(0, -4))}`, path.join("nim", "tests", name)],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const elapsed = Math.round(performance.now() - started);
    if (result.error || result.status !== 0) {
      failures += 1;
      const spawnError = result.error ? ` (${result.error.code ?? result.error.message})` : "";
      console.error(`FAIL ${name}`);
      console.error(`exit code: ${result.status ?? "unknown"}${spawnError}`);
      console.error(`stdout tail:\n${tail(result.stdout)}`);
      console.error(`stderr tail:\n${tail(result.stderr?.trim() || result.error?.message)}`);
      continue;
    }
    console.log(`PASS ${name} (${elapsed})`);
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.exitCode = failures ? 1 : 0;
