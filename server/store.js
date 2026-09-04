import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { freshAppState } from "./paper.js";

const DEFAULT_VAULT = path.join(os.homedir(), "Documents", "sketchdex");

const EMPTY_PAYLOAD = { elements: [], appState: {}, files: {} };

// names Windows reserves for devices; a scene file called CON.excalidraw
// cannot be created there, so such an id is refused everywhere
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

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

  /**
   * Every mutation runs through one queue. Two writers in the same process
   * (the editor's autosave and an agent op on the same scene, or several
   * thumbnail stamps on library load) would otherwise read the index or a
   * scene at the same moment and the second write would drop the first. A
   * vault has one owner and writes are milliseconds, so a queue costs nothing
   * and makes check-then-write (the `ifRev` test and the write it guards)
   * atomic within the process.
   */
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** Write via temp file + rename so a crash can never leave a half file. */
  let tmpCounter = 0;
  const writeAtomic = async (file, contents) => {
    tmpCounter += 1;
    const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, file);
  };

  const isSafeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id ?? "") && !RESERVED.test(id);

  const badId = () => Object.assign(new Error("bad id"), { status: 400 });

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
      // a file dropped in by hand with a name the routes would refuse would
      // become a card that cannot be opened; leave it for the user to rename
      if (!isSafeId(id)) continue;
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

  const create = ({ name = "Untitled", id, createdAt, updatedAt } = {}) =>
    serial(async () => {
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
    });

  const writeThumb = (id, svg) =>
    serial(async () => {
      await ready;
      if (!svg) {
        await fs.rm(thumbFile(id), { force: true }).catch(() => {});
        return;
      }
      await writeAtomic(thumbFile(id), svg);
      // stamped so the library can tell a preview is older than the scene it
      // previews, which is how an agent's edit gets a fresh card
      await patchIndex(id, (meta) => ({ ...meta, thumbAt: Date.now() }));
    });

  return {
    vault,

    /** Exposed so an agent can operate on the file with its own tools. */
    scenePath: (id) => (isSafeId(id) ? sceneFile(id) : null),

    async list() {
      return readIndex();
    },

    create,

    async read(id) {
      if (!isSafeId(id)) throw badId();
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
    save(id, payload, { touch = true, ifRev } = {}) {
      if (!isSafeId(id)) return Promise.reject(badId());
      return serial(async () => {
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
      });
    },

    patch(id, { name, starred }) {
      if (!isSafeId(id)) return Promise.reject(badId());
      return serial(async () => {
        // the name lives inside the file too, so a rebuild recovers it. Read
        // before touching anything: a file that cannot be read right now (mid
        // sync, held by another program, hand-edited into invalid JSON) must
        // not be replaced with an empty scene just because it was renamed
        const payload = name !== undefined ? await readScene(id) : null;
        const list = await patchIndex(id, (meta) => ({
          ...meta,
          ...(name !== undefined ? { name: name.trim() || "Untitled" } : {}),
          ...(starred !== undefined ? { starred } : {}),
        }));
        if (payload) await writeScene(id, payload, name.trim() || "Untitled");
        return list;
      });
    },

    /** Deletes are recoverable: the file moves to trash/ rather than dying. */
    remove(id) {
      if (!isSafeId(id)) return Promise.reject(badId());
      return serial(async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          await fs.rename(sceneFile(id), path.join(trashDir, `${stamp}-${id}.excalidraw`));
        } catch (err) {
          // already gone is fine; anything else means the file is still in
          // scenes/ and must stay listed rather than become invisible
          if (err?.code !== "ENOENT") throw err;
        }
        await fs.rm(thumbFile(id), { force: true }).catch(() => {});
        const list = await readIndex();
        return writeIndex(list.filter((meta) => meta.id !== id));
      });
    },

    duplicate(id) {
      if (!isSafeId(id)) return Promise.reject(badId());
      return serial(async () => {
        const list = await readIndex();
        const source = list.find((meta) => meta.id === id);
        if (!source) return null;
        const payload = await readScene(id);
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
      });
    },

    async readThumb(id) {
      if (!isSafeId(id)) throw badId();
      return fs.readFile(thumbFile(id), "utf8").catch(() => "");
    },

    writeThumb(id, svg) {
      if (!isSafeId(id)) return Promise.reject(badId());
      return writeThumb(id, svg);
    },

    /** One-time import of scenes that were living in IndexedDB. */
    async importScene({ meta, payload, thumb }) {
      const created = await create({
        name: meta?.name ?? "Untitled",
        id: meta?.id,
        createdAt: meta?.createdAt,
        updatedAt: meta?.updatedAt,
      });
      await serial(async () => {
        await writeScene(created.id, payload ?? EMPTY_PAYLOAD, created.name);
        await patchIndex(created.id, (m) => ({
          ...m,
          starred: meta?.starred ?? false,
          elementCount: liveCount(payload ?? EMPTY_PAYLOAD),
          updatedAt: meta?.updatedAt ?? m.updatedAt,
        }));
      });
      if (thumb) await writeThumb(created.id, thumb);
      return created;
    },
  };
}
