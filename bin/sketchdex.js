#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

/**
 * The `sketchdex` command.
 *
 *   sketchdex            the MCP server over stdio (what an agent client runs)
 *   sketchdex mcp        same thing, spelled out
 *   sketchdex app        the library and editor in your browser
 *   sketchdex vault      print the vault path and exit
 *
 * Flags, all optional:
 *   --vault <dir>        where scenes live (default ~/Documents/sketchdex,
 *                        or $SKETCHDEX_VAULT)
 *   --port <n>           `app` only; default 5173, then the next free port
 *   --no-open            `app` only; don't open a browser tab
 *   --version, --help
 *
 * Kept deliberately small: it only decides which module to run and turns
 * flags into the environment variables the rest of the code already reads.
 */

const { version } = createRequire(import.meta.url)("../package.json");

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--vault" || arg === "--port") {
    flags[arg.slice(2)] = args[i + 1];
    i += 1;
  } else if (arg.startsWith("--vault=") || arg.startsWith("--port=")) {
    const [key, value] = arg.slice(2).split("=");
    flags[key] = value;
  } else if (arg === "--no-open") {
    flags.open = false;
  } else if (arg === "--version" || arg === "-v") {
    flags.version = true;
  } else if (arg === "--help" || arg === "-h") {
    flags.help = true;
  } else if (arg.startsWith("-")) {
    process.stderr.write(`sketchdex: unknown flag ${arg}\n`);
    process.exit(2);
  } else {
    positional.push(arg);
  }
}

const HELP = `sketchdex ${version}

  sketchdex              MCP server over stdio (for Claude Code, Codex, Cursor, ...)
  sketchdex app          open the scene library in your browser
  sketchdex vault        print where scenes are stored

  --vault <dir>          scene folder (default ~/Documents/sketchdex)
  --port <n>             app: port to listen on (default 5173)
  --no-open              app: don't open a browser

  Register with Claude Code:
    claude mcp add --scope user sketchdex -- npx -y sketchdex

  Docs: https://github.com/lucasr1b/sketchdex
`;

if (flags.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flags.version) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (flags.vault) {
  // `~` is a shell thing; a value pasted into a JSON config never expands it
  const expanded = flags.vault.replace(/^~(?=$|[/\\])/, os.homedir());
  process.env.SKETCHDEX_VAULT = path.resolve(expanded);
}

const command = positional[0] ?? "mcp";

if (command === "mcp") {
  await import("../mcp/server.js");
} else if (command === "vault") {
  const { createStore } = await import("../server/store.js");
  process.stdout.write(`${createStore().vault}\n`);
} else if (command === "app") {
  const { startAppServer, hasBuild } = await import("../server/serve.js");
  if (!hasBuild()) {
    process.stderr.write(
      "sketchdex app: no built app found (dist/ is missing). In a clone, run `npm run build` first.\n",
    );
    process.exit(1);
  }
  const wanted = Number(flags.port ?? 5173);
  let started = null;
  // walk forward from the wanted port rather than fail on a busy one
  for (let port = wanted; port < wanted + 20 && !started; port += 1) {
    started = await startAppServer({ port }).catch((err) => {
      if (err?.code === "EADDRINUSE") return null;
      throw err;
    });
  }
  if (!started) {
    process.stderr.write(`sketchdex app: ports ${wanted}-${wanted + 19} are all busy\n`);
    process.exit(1);
  }
  const { createStore } = await import("../server/store.js");
  process.stdout.write(`sketchdex ${version}\n  app    ${started.url}\n  vault  ${createStore().vault}\n`);
  if (flags.open !== false) openInBrowser(started.url);
} else {
  process.stderr.write(`sketchdex: unknown command "${command}"\n\n${HELP}`);
  process.exit(2);
}

function openInBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
  } catch {
    // a missing opener just means the URL is printed and nothing else
  }
}
