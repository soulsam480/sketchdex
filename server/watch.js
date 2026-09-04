import fs from "node:fs";
import path from "node:path";

/**
 * Tells open tabs that a scene changed on disk.
 *
 * Without this, an agent write is invisible and then lost: the editor holds the
 * scene in memory and overwrites the file on its next save. Watching the folder
 * (rather than broadcasting from the write routes) is what makes it work for the
 * MCP server too, which edits the vault in its own process and never touches
 * this HTTP server at all.
 *
 * Writes that came through this server are tagged with the client that made
 * them and the exact revision (mtime + size) they produced, so the tab that
 * saved ignores its own echo while every other tab reloads. A change whose
 * revision matches no noted write is `external` - an agent, or a hand edit -
 * and everyone reloads.
 *
 * Attribution is by revision rather than by time on purpose. A time window
 * ("anything within 2.5s of my write is my echo") swallowed real agent writes
 * that landed just after the tab's own save: the tab ignored them, kept its
 * stale copy in memory, and wrote over the agent's work on its next save.
 */

const ECHO_WINDOW = 2500;

export function createWatcher(vault, { onExternal, revOf } = {}) {
  const scenesDir = path.join(vault, "scenes");
  const clients = new Set();
  const beats = new Map(); // res -> heartbeat interval
  const recent = new Map(); // sceneId -> { by, at, rev }
  const pending = new Map(); // sceneId -> timer

  const send = (event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        drop(res);
      }
    }
  };

  const drop = (res) => {
    clients.delete(res);
    clearInterval(beats.get(res));
    beats.delete(res);
  };

  const announce = async (sceneId) => {
    // the file is gone: a delete (moved to trash) or a rename by hand. There
    // is nothing to reload and nothing to snapshot; tell tabs to let go of it
    if (revOf && (await revOf(sceneId).catch(() => null)) === null) {
      recent.delete(sceneId);
      send({ type: "removed", id: sceneId, at: Date.now() });
      return;
    }
    const note = recent.get(sceneId);
    let by = "external";
    if (note) {
      if (note.rev && revOf) {
        // exact: this is the echo only if the file is still the bytes we wrote
        const current = await revOf(sceneId).catch(() => null);
        if (current === note.rev) by = note.by;
      } else if (Date.now() - note.at < ECHO_WINDOW) {
        by = note.by;
      }
    }
    // an edit made straight to the file gets its snapshot here, after the fact,
    // from the last state the server saw - see agent.noteExternalChange
    let snapshot = null;
    if (by === "external" && onExternal) {
      snapshot = await onExternal(sceneId).catch(() => null);
    }
    send({ type: "scene", id: sceneId, by, at: Date.now() });
    if (snapshot) send({ type: "history", id: sceneId });
  };

  /** fs.watch fires several times per atomic write (tmp create, rename). */
  const nudge = (sceneId) => {
    if (pending.has(sceneId)) clearTimeout(pending.get(sceneId));
    pending.set(
      sceneId,
      setTimeout(() => {
        pending.delete(sceneId);
        announce(sceneId).catch(() => {});
      }, 120),
    );
  };

  let watcher = null;
  const start = () => {
    if (watcher) return;
    try {
      watcher = fs.watch(scenesDir, (_event, filename) => {
        if (!filename || !filename.endsWith(".excalidraw")) return;
        nudge(filename.slice(0, -".excalidraw".length));
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // the vault may not exist yet; the next subscribe retries
    }
  };

  return {
    /**
     * Called by the write routes so a tab can recognise its own save. Pass the
     * revision the write produced for exact matching; without it, a short
     * time window is used.
     */
    noteWrite(sceneId, by, rev = null) {
      recent.set(sceneId, { by: by || "app", at: Date.now(), rev });
    },

    /** Broadcast something that is not a scene file change (history edits). */
    push(event) {
      send(event);
    },

    subscribe(req, res) {
      start();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);

      // proxies and sleeping laptops drop idle streams; a comment keeps it warm
      const beat = setInterval(() => {
        try {
          res.write(": beat\n\n");
        } catch {
          drop(res);
        }
      }, 25000);
      beats.set(res, beat);

      req.on("close", () => drop(res));
    },

    /**
     * Let the process end: close the folder watch, stop every heartbeat, end
     * every stream. Without this, anything that embeds the server has to
     * process.exit to get out.
     */
    close() {
      watcher?.close();
      watcher = null;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const res of [...clients]) {
        drop(res);
        try {
          res.end();
        } catch {
          // already gone
        }
      }
    },
  };
}
