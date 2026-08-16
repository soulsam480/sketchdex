import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import crypto from "node:crypto";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Undo for changes Sketchdex did not make.
 *
 * Drawing by hand has Excalidraw's own undo stack. An agent writing straight to
 * the vault does not - the file simply changes underneath you - so every write
 * that arrives through the agent surface stashes the previous state first.
 *
 * Snapshots hold `elements` and `appState` only. `files` (the base64 image
 * blobs) is left out on purpose: it is the bulk of a scene on disk (one scene
 * here is 4MB of images and 14 elements) and nothing ever removes entries from
 * it, so the live map is always a superset of what any snapshot needs. Restoring
 * re-attaches the current map. Gzipped, a snapshot of a busy scene lands in the
 * tens of KB rather than the megabytes the raw file costs.
 *
 * Nothing here expires on a timer. Snapshots sit until you accept a result
 * (which clears the scene's history) or discard them one by one, with a cap as
 * the only automatic pruning.
 */

const MAX_PER_SCENE = 20;

export function createHistory(vault) {
  const root = path.join(vault, "history");
  const dirFor = (sceneId) => path.join(root, sceneId);
  const logFor = (sceneId) => path.join(dirFor(sceneId), "log.json");
  const snapFor = (sceneId, snapId) =>
    path.join(dirFor(sceneId), `${snapId}.json.gz`);

  const isSafe = (value) => /^[A-Za-z0-9_-]{1,64}$/.test(value ?? "");

  const writeAtomic = async (file, contents) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, file);
  };

  const readLog = async (sceneId) => {
    try {
      const parsed = JSON.parse(await fs.readFile(logFor(sceneId), "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const writeLog = async (sceneId, entries) => {
    await fs.mkdir(dirFor(sceneId), { recursive: true });
    await writeAtomic(logFor(sceneId), JSON.stringify(entries, null, 2));
    return entries;
  };

  const dropSnapshot = async (sceneId, snapId) => {
    await fs.rm(snapFor(sceneId, snapId), { force: true }).catch(() => {});
  };

  return {
    root,

    /**
     * Record that we just wrote this scene ourselves, identified by the exact
     * bytes we left behind.
     *
     * The MCP server edits the vault from its own process, so the app's file
     * watcher sees the change with nothing to attribute it to and treats it as
     * an outside edit - snapshotting a second time, right after the deliberate
     * one. Stat is enough to tell the two apart: if the file still matches what
     * the writer left, this event is that write.
     */
    async claim(sceneId, file) {
      if (!isSafe(sceneId)) return;
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) return;
      await fs.mkdir(dirFor(sceneId), { recursive: true }).catch(() => {});
      await writeAtomic(
        path.join(dirFor(sceneId), "claim.json"),
        JSON.stringify({ mtimeMs: stat.mtimeMs, size: stat.size, at: Date.now() }),
      );
    },

    /** True when the file on disk is still exactly what a claim described. */
    async isClaimed(sceneId, file) {
      if (!isSafe(sceneId)) return false;
      const [claim, stat] = await Promise.all([
        fs
          .readFile(path.join(dirFor(sceneId), "claim.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null),
        fs.stat(file).catch(() => null),
      ]);
      if (!claim || !stat) return false;
      return claim.mtimeMs === stat.mtimeMs && claim.size === stat.size;
    },

    /** Newest first, with the on-disk cost so the sidebar can show it. */
    async list(sceneId) {
      if (!isSafe(sceneId)) return { entries: [], bytes: 0 };
      const entries = await readLog(sceneId);
      let bytes = 0;
      for (const entry of entries) bytes += entry.bytes ?? 0;
      return { entries, bytes };
    },

    /**
     * Stash the current state of a scene. Called *before* the change lands, so
     * the entry describes what is about to happen, not what happened.
     */
    async take(sceneId, payload, { label = "agent edit", origin = "agent" } = {}) {
      if (!isSafe(sceneId)) throw new Error("bad scene id");
      await fs.mkdir(dirFor(sceneId), { recursive: true });

      const body = await gzip(
        JSON.stringify({
          elements: payload?.elements ?? [],
          appState: payload?.appState ?? {},
        }),
      );
      const entry = {
        id: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        at: Date.now(),
        label,
        origin,
        elementCount: (payload?.elements ?? []).filter((el) => !el.isDeleted)
          .length,
        bytes: body.length,
      };
      await writeAtomic(snapFor(sceneId, entry.id), body);

      const entries = [entry, ...(await readLog(sceneId))];
      // oldest first out, so the newest 20 states are always the ones kept
      const kept = entries.slice(0, MAX_PER_SCENE);
      for (const dropped of entries.slice(MAX_PER_SCENE)) {
        await dropSnapshot(sceneId, dropped.id);
      }
      await writeLog(sceneId, kept);
      return entry;
    },

    /** The stored `{ elements, appState }`, without the image map. */
    async read(sceneId, snapId) {
      if (!isSafe(sceneId) || !isSafe(snapId)) throw new Error("bad id");
      const raw = await gunzip(await fs.readFile(snapFor(sceneId, snapId)));
      return JSON.parse(raw.toString("utf8"));
    },

    async discard(sceneId, snapId) {
      if (!isSafe(sceneId) || !isSafe(snapId)) throw new Error("bad id");
      await dropSnapshot(sceneId, snapId);
      const entries = (await readLog(sceneId)).filter((e) => e.id !== snapId);
      await writeLog(sceneId, entries);
      return entries;
    },

    /** Accepting a result means there is nothing left to decide. */
    async clear(sceneId) {
      if (!isSafe(sceneId)) throw new Error("bad scene id");
      await fs.rm(dirFor(sceneId), { recursive: true, force: true }).catch(() => {});
      return [];
    },
  };
}
