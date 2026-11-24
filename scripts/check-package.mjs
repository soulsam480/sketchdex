/**
 * Runs before publish. Refuses to ship a package that would not work or that
 * still carries the maintainer's own setup in it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const problems = [];

const pkg = JSON.parse(read("package.json"));

// the render page and the app must be prebuilt: an install has no Vite
const executable = process.platform === "win32" ? "sketchdex.exe" : "sketchdex";
for (const rel of [`bin/${executable}`, "dist/render.html", "dist/index.html"]) {
  if (!fs.existsSync(path.join(root, rel))) problems.push(`${rel} is missing; run npm run build and npm run build:server`);
}
if (pkg.bin?.sketchdex !== "bin/sketchdex") problems.push("package bin must point to bin/sketchdex");
for (const entry of ["bin/", "dist/", "docs/"]) {
  if (!pkg.files?.includes(entry)) problems.push(`package files must include ${entry}`);
}

/**
 * Nothing shipped may assume one person's machine. Every text file named by
 * the `files` field is scanned, so a new source file is covered the day it
 * is added rather than when someone remembers to list it here.
 */
const TEXT = /\.(js|mjs|cjs|ts|json|md|html|css|svg|webmanifest|txt)$/i;
const NEEDLES = ["Lucas", "/Users/lucas", "~/Developer/lab", "lucascamribeiro"];
const ALLOWED = new Set(["LICENSE", "package.json"]); // the author's name belongs in these
const walk = (rel) => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isDirectory()) {
    return fs.readdirSync(abs).flatMap((name) => walk(path.join(rel, name)));
  }
  return [rel];
};
for (const entry of pkg.files ?? []) {
  for (const rel of walk(entry.replace(/\/$/, ""))) {
    if (!TEXT.test(rel) && !ALLOWED.has(rel)) continue;
    if (ALLOWED.has(rel)) continue;
    // built assets embed Excalidraw and React, megabytes of them; the needles
    // are short and specific, so a plain scan is fine
    const text = read(rel);
    for (const needle of NEEDLES) {
      if (text.includes(needle)) problems.push(`${rel} mentions "${needle}"`);
    }
  }
}

// registry metadata has to agree with the package
if (fs.existsSync(path.join(root, "server.json"))) {
  const reg = JSON.parse(read("server.json"));
  if (reg.version !== pkg.version) problems.push(`server.json version ${reg.version} != package ${pkg.version}`);
  for (const p of reg.packages ?? []) {
    if (p.version !== pkg.version) problems.push(`server.json package version ${p.version} != ${pkg.version}`);
  }
  if (reg.name !== pkg.mcpName) problems.push(`server.json name ${reg.name} != package mcpName ${pkg.mcpName}`);
}

if (!fs.existsSync(path.join(root, "LICENSE"))) problems.push("LICENSE is missing");

if (problems.length) {
  console.error("check-package: not publishable\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("check-package: ok");
