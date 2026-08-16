#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Sketchdex over stdio, with the code underneath it replaceable.
 *
 * A stdio MCP server is spawned once per client session and lives as long as
 * that session does, so it keeps whatever code it started with. Editing this
 * project therefore had no effect until every Claude Code and Codex session was
 * restarted - which is how you end up debugging a bug that was fixed hours ago.
 *
 * This process is now only a supervisor. It owns the pipe to the client and
 * nothing else; the tools run in a child (worker.js) that gets replaced whenever
 * a source file changes. The client's connection is never interrupted, so an
 * edit is live on the next tool call with no restart anywhere.
 *
 * The supervisor itself cannot reload - if you change *this* file, the session
 * does need restarting. It is deliberately thin for that reason.
 *
 * Set SKETCHDEX_NO_RELOAD=1 to pin a session to the code it started with.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const WATCHED = [path.join(repo, "server"), here];
const RELOAD = process.env.SKETCHDEX_NO_RELOAD !== "1";

let child = null;
let ready = null;
let tools = [];
let version = "";
let instructions = "";
let generation = 0;
let nextId = 0;
let brokenSince = null;
const pending = new Map();

const startWorker = (attempt = 0) => {
  generation += 1;
  const mine = generation;

  child = fork(path.join(here, "worker.js"), {
    // stdout must stay closed: this process's stdout *is* the MCP channel, and
    // one stray console.log in the child would corrupt the protocol stream
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  // per-worker, not global: `tools` survives from the last good worker, so it
  // cannot be used to tell whether *this* one ever came up
  let becameReady = false;

  ready = new Promise((resolve) => {
    child.on("message", (message) => {
      if (message?.type === "ready") {
        becameReady = true;
        tools = message.tools ?? [];
        version = message.version ?? "";
        instructions = message.instructions ?? instructions;
        brokenSince = null;
        resolve();
      }
      if (message?.type === "result") {
        const settle = pending.get(message.id);
        if (settle) {
          pending.delete(message.id);
          settle(message.result);
        }
      }
    });

    child.on("exit", () => {
      // a reload kills the old worker on purpose and has already replaced it
      if (mine !== generation) return;

      /**
       * Dying before it was ever ready means the source does not currently
       * load - almost always a file caught mid-save. Backing off rather than
       * respawning immediately avoids a hot loop, and `ready` is resolved
       * anyway so calls fail with an explanation instead of hanging forever.
       */
      if (!becameReady) {
        brokenSince = brokenSince ?? Date.now();
        resolve();
      }
      setTimeout(
        () => startWorker(attempt + 1),
        Math.min(200 * 2 ** attempt, 5000),
      );
    });
  });
};

/** Swap in a worker running the code as it stands now. */
let reloadTimer = null;
const reload = (server) => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      const old = child;
      // anything mid-flight belongs to code that is about to go away
      for (const [id, settle] of pending) {
        pending.delete(id);
        settle({
          isError: true,
          content: [
            {
              type: "text",
              text: "Sketchdex reloaded while this call was running. Retry it - the new code is live.",
            },
          ],
        });
      }
      startWorker();
      old?.kill();
      await ready;
      // the tool list may have changed shape, so invite the client to re-read it
      await server
        .notification({ method: "notifications/tools/list_changed" })
        .catch(() => {});
    } catch {
      // a failed reload must never take the watcher down with it, or edits
      // stop being picked up from that moment on with no sign of why
    }
  }, 300);
};

/**
 * A cheap fingerprint of every source file: name, size, mtime.
 *
 * Statting a dozen files every couple of seconds costs nothing measurable, and
 * unlike fs.watch it cannot quietly stop. That matters here: the watcher was
 * observed firing correctly for a while and then going silent in long-lived
 * processes, which turns "your edits are live" into a promise that expires
 * without telling anyone - the exact failure the supervisor exists to prevent.
 * fs.watch stays for instant response; this is the guarantee underneath it.
 */
const fingerprint = () => {
  const parts = [];
  for (const dir of WATCHED) {
    let names = [];
    try {
      names = fs
        .readdirSync(dir)
        .filter((n) => /\.(js|mjs)$/.test(n))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const stat = fs.statSync(path.join(dir, name));
        parts.push(`${name}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        // vanished between readdir and stat; the next tick will catch up
      }
    }
  }
  return parts.join("|");
};

const watchSources = (server) => {
  for (const dir of WATCHED) {
    try {
      const watcher = fs.watch(dir, (_event, filename) => {
        if (
          filename &&
          /\.(js|mjs)$/.test(filename) &&
          !filename.includes(".tmp")
        ) {
          reload(server);
        }
      });
      watcher.on("error", () => {});
    } catch {
      // a missing directory just means nothing to watch there
    }
  }

  let last = fingerprint();
  const timer = setInterval(() => {
    const now = fingerprint();
    if (now !== last) {
      last = now;
      reload(server);
    }
  }, 2000);
  // never hold the process open on account of the poll
  timer.unref?.();
};

const errorResult = (text) => ({
  isError: true,
  content: [{ type: "text", text }],
});

const call = async (name, args) => {
  await ready;
  if (brokenSince || !child?.connected) {
    return errorResult(
      "Sketchdex could not load its own source - most likely a file caught mid-save. It retries automatically; call again in a moment.",
    );
  }
  const id = (nextId += 1);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    // a dead worker would otherwise leave this call hanging forever; renders
    // are the slow case and finish well inside this
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        resolve(errorResult(`${name} did not answer within 120s.`));
      }
    }, 120_000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    child.send({ type: "call", id, name, args });
  });
};

startWorker();
await ready;

const server = new Server(
  { name: "sketchdex", version },
  // instructions are fixed for the life of the connection (the SDK sends them
  // once, in the initialize result); tools can still be reloaded
  { capabilities: { tools: { listChanged: true } }, instructions },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ready;
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, (request) =>
  call(request.params.name, request.params.arguments ?? {}),
);

await server.connect(new StdioServerTransport());
if (RELOAD) watchSources(server);
