import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = performance.now();

const resolveCompiler = () => {
  if (process.env.SKETCHDEX_NIM) return { command: process.env.SKETCHDEX_NIM, args: [], label: process.env.SKETCHDEX_NIM };

  const onPath = spawnSync("nim", ["--version"], { encoding: "utf8", windowsHide: true });
  if (!onPath.error) return { command: "nim", args: [], label: "nim" };

  return { command: "mise", args: ["exec", "--", "nim"], label: "mise exec -- nim" };
};

const compiler = resolveCompiler();
const executable = process.platform === "win32" ? "sketchdex.exe" : "sketchdex";
const output = `nim/bin/${executable}`;
const binOutput = `bin/${executable}`;
const outputDir = path.join(root, "nim", "bin");
fs.mkdirSync(outputDir, { recursive: true });

console.log(`build-server: compiler ${compiler.label}`);

const result = spawnSync(
  compiler.command,
  [...compiler.args, "c", "-d:release", "--opt:speed", "--hints:off", `-o:${output}`, "nim/cmd/sketchdex.nim"],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);

const elapsed = ((performance.now() - started) / 1000).toFixed(2);

if (result.error || result.status !== 0) {
  const detail = (result.stderr || result.error?.message || `compiler exited with status ${result.status}`).trim().slice(-4000);
  console.error(`build-server: compilation failed after ${elapsed}s\n${detail}`);
  process.exit(1);
}

console.log(`build-server: output ${output}`);
const binDir = path.join(root, "bin");
fs.mkdirSync(binDir, { recursive: true });
const packagedBinary = path.join(binDir, executable);
fs.copyFileSync(path.join(root, output), packagedBinary);
fs.chmodSync(packagedBinary, 0o755);
console.log(`build-server: bin ${binOutput}`);
console.log(`build-server: elapsed ${elapsed}s`);
