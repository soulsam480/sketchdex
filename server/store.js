import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { freshAppState } from "./paper.js";

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "sketchdex");

const EMPTY_PAYLOAD = { elements: [], appState: {}, files: {} };

export function createStore(vaultPath = process.env.SKETCHDEX_VAULT) {
  const vault = vaultPath ? path.resolve(vaultPath) : DEFAULT_VAULT;
  const scenesDir = path.join(vault, "scenes");
  const thumbsDir = path.join(vault, "thumbs");
  const trashDir = path.join(vault, "trash");
  const indexFile = path.join(vault, "index.json");

  const sceneFile = (id) => path.join(scenesDir, `${id}.excalidraw`);
  const thumbFile = (id) => path.join(thumbsDir, `${id}.svg`);

  const ready = (async () => {
    for (const dir of [scenesDir, thumbsDir, trashDir]) {
      await fs.mkdir(dir, { recursive: true });
    }
  })();

  /** Write via temp file + rename so a crash can never leave a half file. */
  const writeAtomic = async (file, contents) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, file);
  };

  const isSafeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id ?? "");

  /**
   * A revision token for a scene: the file's mtime and size. Cheap, needs no
   * bookkeeping, and changes on every write from any process - the app, the
   * MCP server, or someone editing the file by hand. It is what lets a save
   * say "only if nothing has changed under me" (see save's `ifRev`), and what
   * lets a tab recognise the echo of its own write byte for byte.
   */
  const revOf = async (id) => {
    const stat = await fs.stat(sceneFile(id)).catch(() => null);
    return stat ? `${stat.mtimeMs}-${stat.size}` : null;
  };

  /**
   * The scene files are the source of truth. index.json is a cache of names
   * and timestamps; if it goes missing or gets corrupted it is rebuilt by
   * scanning the folder, so no scene is ever lost with it.
   */
  const rebuildIndex = async () => {
    const names = await fs.readdir(scenesDir).catch(() => []);
    const metas = [];
    for (const name of names) {
      if (!name.endsWith(".excalidraw")) continue;
      const id = name.slice(0, -".excalidraw".length);
      const file = path.join(scenesDir, name);
      const [stat, payload] = await Promise.all([
        fs.stat(file).catch(() => null),
        readScene(id).catch(() => null),
      ]);
      if (!stat) continue;
      metas.push({
        id,
        name: payload?.name || `Recovered ${id.slice(0, 8)}`,
        createdAt: Math.round(stat.birthtimeMs || stat.mtimeMs),
        updatedAt: Math.round(stat.mtimeMs),
        elementCount: (payload?.elements ?? []).filter((el) => !el.isDeleted)
          .length,
      });
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    await writeAtomic(indexFile, JSON.stringify(metas, null, 2));
    return metas;
  };

  const readIndex = async () => {
    await ready;
    try {
      const parsed = JSON.parse(await fs.readFile(indexFile, "utf8"));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // missing or corrupt: fall through to a rebuild from the scene files
    }
    return rebuildIndex();
  };

  /**
   * Deduped on the way out. The index is a cache that can be rebuilt from the
   * folder at any moment, so a caller that adds an entry may be adding one a
   * rebuild has already produced. Keeping the first occurrence keeps the
   * caller's fresher copy.
   */
  const writeIndex = async (list) => {
    const seen = new Set();
    const unique = list.filter((meta) => {
      if (!meta?.id || seen.has(meta.id)) return false;
      seen.add(meta.id);
      return true;
    });
    await writeAtomic(indexFile, JSON.stringify(unique, null, 2));
    return unique;
  };

  const patchIndex = async (id, patch) => {
    const list = await readIndex();
    const next = list.map((meta) => (meta.id === id ? patch(meta) : meta));
    return writeIndex(next);
  };

  const readScene = async (id) => {
    const raw = await fs.readFile(sceneFile(id), "utf8");
    const parsed = JSON.parse(raw);
    return {
      elements: parsed.elements ?? [],
      appState: parsed.appState ?? {},
      files: parsed.files ?? {},
      name: parsed.name,
    };
  };

  /** Real .excalidraw format, so the files open in Excalidraw as-is. */
  const writeScene = async (id, payload, name) =>
    writeAtomic(
      sceneFile(id),
      JSON.stringify(
        {
          type: "excalidraw",
          version: 2,
          source: "sketchdex",
          name,
          elements: payload.elements ?? [],
          appState: payload.appState ?? {},
          files: payload.files ?? {},
        },
        null,
        2,
      ),
    );

  const liveCount = (payload) =>
    (payload.elements ?? []).filter((el) => !el.isDeleted).length;

  return {
    vault,

    /** Exposed so an agent can operate on the file with its own tools. */
    scenePath: (id) => (isSafeId(id) ? sceneFile(id) : null),

    async list() {
      return readIndex();
    },

    async create({ name = "Untitled", id, createdAt, updatedAt } = {}) {
      await ready;
      const now = Date.now();
      const meta = {
        id: isSafeId(id) ? id : crypto.randomUUID(),
        name,
        createdAt: createdAt ?? now,
        updatedAt: updatedAt ?? now,
        elementCount: 0,
      };
      // a new scene is dark paper with a matching pen; see paper.js
      await writeScene(meta.id, { ...EMPTY_PAYLOAD, appState: freshAppState() }, meta.name);
      // readIndex may rebuild from the folder, which now contains the file
      // written a line ago, so this entry can already be in the list
      await writeIndex([meta, ...(await readIndex())]);
      return meta;
    },

    async read(id) {
      if (!isSafeId(id)) throw new Error("bad id");
      const { elements, appState, files } = await readScene(id);
      return { elements, appState, files, rev: await revOf(id) };
    },

    /** The current revision token of a scene file, null if it does not exist. */
    rev: revOf,

    /**
     * `ifRev` makes the write conditional: when the file's revision no longer
     * matches, nothing is written and a conflict error (status 409, with the
     * current rev) is thrown, so the caller can pick up what changed instead
     * of writing over it. Without `ifRev` the write is unconditional.
     */
    async save(id, payload, { touch = true, ifRev } = {}) {
      if (!isSafeId(id)) throw new Error("bad id");
      if (ifRev !== undefined && ifRev !== null) {
        const current = await revOf(id);
        if (current && current !== ifRev) {
          throw Object.assign(new Error("scene changed on disk since it was loaded"), {
            status: 409,
            code: "conflict",
            rev: current,
          });
        }
      }
      const list = await readIndex();
      const meta = list.find((m) => m.id === id);
      await writeScene(id, payload, meta?.name);
      if (!touch) return list;
      return patchIndex(id, (m) => ({
        ...m,
        updatedAt: Date.now(),
        elementCount: liveCount(payload),
      }));
    },

    async patch(id, { name, starred }) {
      if (!isSafeId(id)) throw new Error("bad id");
      const list = await patchIndex(id, (meta) => ({
        ...meta,
        ...(name !== undefined ? { name: name.trim() || "Untitled" } : {}),
        ...(starred !== undefined ? { starred } : {}),
      }));
      if (name !== undefined) {
        // keep the name inside the file too, so a rebuild recovers it
        const payload = await readScene(id).catch(() => EMPTY_PAYLOAD);
        await writeScene(id, payload, name.trim() || "Untitled");
      }
      return list;
    },

    /** Deletes are recoverable: the file moves to trash/ rather than dying. */
    async remove(id) {
      if (!isSafeId(id)) throw new Error("bad id");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await fs
        .rename(sceneFile(id), path.join(trashDir, `${stamp}-${id}.excalidraw`))
        .catch(() => {});
      await fs.rm(thumbFile(id), { force: true }).catch(() => {});
      const list = await readIndex();
      return writeIndex(list.filter((meta) => meta.id !== id));
    },

    async duplicate(id) {
      if (!isSafeId(id)) throw new Error("bad id");
      const list = await readIndex();
      const source = list.find((meta) => meta.id === id);
      if (!source) return null;
      const payload = await readScene(id).catch(() => EMPTY_PAYLOAD);
      const now = Date.now();
      const copy = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} copy`,
        createdAt: now,
        updatedAt: now,
        starred: false,
      };
      await writeScene(copy.id, payload, copy.name);
      await fs.copyFile(thumbFile(id), thumbFile(copy.id)).catch(() => {});
      const at = list.findIndex((meta) => meta.id === id);
      const next = [...list];
      next.splice(at + 1, 0, copy);
      await writeIndex(next);
      return copy;
    },

    async readThumb(id) {
      if (!isSafeId(id)) throw new Error("bad id");
      return fs.readFile(thumbFile(id), "utf8").catch(() => "");
    },

    async writeThumb(id, svg) {
      if (!isSafeId(id)) throw new Error("bad id");
      await ready;
      if (!svg) {
        await fs.rm(thumbFile(id), { force: true }).catch(() => {});
        return;
      }
      await writeAtomic(thumbFile(id), svg);
      // stamped so the library can tell a preview is older than the scene it
      // previews, which is how an agent's edit gets a fresh card
      await patchIndex(id, (meta) => ({ ...meta, thumbAt: Date.now() }));
    },

    /** One-time import of scenes that were living in IndexedDB. */
    async importScene({ meta, payload, thumb }) {
      const created = await this.create({
        name: meta?.name ?? "Untitled",
        id: meta?.id,
        createdAt: meta?.createdAt,
        updatedAt: meta?.updatedAt,
      });
      await writeScene(created.id, payload ?? EMPTY_PAYLOAD, created.name);
      if (thumb) await this.writeThumb(created.id, thumb);
      await patchIndex(created.id, (m) => ({
        ...m,
        starred: meta?.starred ?? false,
        elementCount: liveCount(payload ?? EMPTY_PAYLOAD),
        updatedAt: meta?.updatedAt ?? m.updatedAt,
      }));
      return created;
    },
  };
}
