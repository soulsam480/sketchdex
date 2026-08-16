import { get, set } from "idb-keyval";
import { importLegacyScene, loadIndex } from "./store";
import type { SceneMeta, ScenePayload } from "./types";

const DONE_KEY = "sketchdex/migrated";

/**
 * Scenes used to live in IndexedDB. This lifts anything still there into the
 * vault on disk, once. The IndexedDB copies are left untouched as a backup.
 */
export const migrateLegacyScenes = async (): Promise<number> => {
  if (await get(DONE_KEY)) return 0;

  const legacy = (await get<SceneMeta[]>("sketchdex/index")) ?? [];
  if (!legacy.length) {
    await set(DONE_KEY, true);
    return 0;
  }

  const existing = new Set((await loadIndex()).map((meta) => meta.id));
  let moved = 0;

  for (const meta of legacy) {
    if (existing.has(meta.id)) continue;
    const payload =
      (await get<ScenePayload>(`sketchdex/scene/${meta.id}`)) ?? null;
    const thumb = await get<string>(`sketchdex/thumb/${meta.id}`);
    await importLegacyScene({ meta, payload, thumb });
    moved += 1;
  }

  await set(DONE_KEY, true);
  return moved;
};
