import { createStore } from "./store.js";
import { createHistory } from "./history.js";
import { buildElements, growContainerFor, patchElement } from "./elements.js";
import { inspectScene } from "./inspect.js";
import { svgToSpecs } from "./svg.js";
import { freshAppState, inkFor, paperOf } from "./paper.js";

/**
 * The surface an agent talks to.
 *
 * Deliberately narrower and higher-level than the raw scene API the app uses.
 * The app owns a whole scene and rewrites it wholesale; an agent works in terms
 * of "add these shapes", "change that one", and needs a description of the scene
 * it can reason about without pulling 4MB of embedded images through a context
 * window.
 *
 * Both the MCP server and the HTTP routes are thin wrappers over this, so there
 * is exactly one implementation of the rules - above all the rule that every
 * mutation snapshots first.
 */

export function createAgentApi(vaultPath) {
  const store = createStore(vaultPath);
  const history = createHistory(store.vault);

  const live = (elements) => (elements ?? []).filter((el) => !el.isDeleted);

  /**
   * An arrow bound to an element that was already on the canvas needs that
   * element to list the arrow in its `boundElements`, or the app will not
   * move the arrow with it. buildElements hands those back as copies; this
   * puts them in place of the originals.
   */
  const withUpdated = (elements, updated = []) => {
    if (!updated.length) return elements;
    const byId = new Map(updated.map((el) => [el.id, el]));
    return elements.map((el) => byId.get(el.id) ?? el);
  };

  /**
   * Imported artwork arrives as many elements that are one drawing, so they get
   * a shared group id: selecting any part selects the piece, and it moves and
   * scales as a unit instead of a hundred fragments.
   */
  const withGroup = (elements, group = `svg-${Math.random().toString(36).slice(2, 10)}`) =>
    elements.map((el) => ({ ...el, groupIds: [...(el.groupIds ?? []), group] }));

  /**
   * Last state we saw for a scene, keyed by id, most-recent few only.
   *
   * This is the backstop for an agent that edits a .excalidraw file directly
   * instead of coming through here: the file watcher spots the change after the
   * fact, by which point the previous state is gone from disk - but not from
   * here, so it can still be snapshotted. Bounded because scenes run to
   * megabytes.
   */
  const LAST_KNOWN_MAX = 5;
  const lastKnown = new Map();
  const remember = (id, payload) => {
    lastKnown.delete(id);
    lastKnown.set(id, { elements: payload.elements, appState: payload.appState });
    while (lastKnown.size > LAST_KNOWN_MAX) {
      lastKnown.delete(lastKnown.keys().next().value);
    }
  };

  /** Rounded, default-stripped view of one element. Full fidelity is noise. */
  const describe = (el) => {
    const out = {
      id: el.id,
      type: el.type,
      x: Math.round(el.x),
      y: Math.round(el.y),
      width: Math.round(el.width),
      height: Math.round(el.height),
    };
    if (el.text) out.text = el.text;
    if (el.containerId) out.containerId = el.containerId;
    if (el.strokeColor && el.strokeColor !== "#1e1e1e") out.strokeColor = el.strokeColor;
    if (el.backgroundColor && el.backgroundColor !== "transparent") {
      out.backgroundColor = el.backgroundColor;
    }
    if (el.fontSize) out.fontSize = Math.round(el.fontSize);
    if (el.angle) out.angle = Number(el.angle.toFixed(3));
    if (el.opacity !== undefined && el.opacity !== 100) out.opacity = el.opacity;
    if (el.strokeWidth && el.strokeWidth !== 2) out.strokeWidth = el.strokeWidth;
    if (el.groupIds?.length) out.groupIds = el.groupIds;
    if (el.startBinding || el.endBinding) {
      out.binding = {
        start: el.startBinding?.elementId ?? null,
        end: el.endBinding?.elementId ?? null,
      };
    }
    if (el.type === "freedraw" || el.type === "line" || el.type === "arrow") {
      out.pointCount = el.points?.length ?? 0;
    }
    return out;
  };

  /**
   * What a caller needs to refer back to something it just drew: the id, what
   * it is, and enough text to tell one label from another. Bare id lists are
   * how a follow-up patch lands on the wrong element.
   */
  const brief = (el) => {
    const out = { id: el.id, type: el.type };
    if (el.text) out.text = String(el.text).replace(/\s+/g, " ").slice(0, 48);
    if (el.containerId) out.containerId = el.containerId;
    return out;
  };

  const bounds = (elements) => {
    if (!elements.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const el of elements) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + (el.width ?? 0));
      maxY = Math.max(maxY, el.y + (el.height ?? 0));
    }
    return {
      x: Math.round(minX),
      y: Math.round(minY),
      width: Math.round(maxX - minX),
      height: Math.round(maxY - minY),
    };
  };

  /**
   * Scenes are addressable by id, exact name, or a distinguishing fragment of a
   * name. A fragment that fits more than one scene is an error listing the
   * candidates, not a silent pick: guessing here means confidently drawing on
   * the wrong canvas.
   */
  const resolve = async (idOrName) => {
    const list = await store.list();
    const byId = list.find((meta) => meta.id === idOrName);
    if (byId) return byId;

    const needle = String(idOrName ?? "").toLowerCase();
    const exact = list.filter((meta) => meta.name.toLowerCase() === needle);
    if (exact.length === 1) return exact[0];

    const partial = exact.length
      ? exact
      : list.filter((meta) => meta.name.toLowerCase().includes(needle));

    if (partial.length === 1) return partial[0];
    if (partial.length === 0) throw new Error(`no scene matching "${idOrName}"`);

    const candidates = partial
      .map((meta) => `  ${meta.id}  ${meta.name}`)
      .join("\n");
    throw new Error(
      `"${idOrName}" matches ${partial.length} scenes. Use an id:\n${candidates}`,
    );
  };

  /**
   * Every mutation goes through here. The snapshot is written before the change
   * so a bad result is always one click from being undone, and the label is the
   * agent's own description of what it was about to do.
   */
  const mutate = async (idOrName, label, apply, attempt = 0) => {
    // enforced here, not only in the tool schema, so REST and Node callers
    // are held to the same contract: an unlabelled snapshot is one the user
    // cannot judge in the history sidebar
    if (!label || !String(label).trim()) {
      throw Object.assign(
        new Error("label is required: a short description of this change, e.g. 'add the dog illustration'"),
        { status: 400 },
      );
    }
    const meta = await resolve(idOrName);
    const payload = await store.read(meta.id);
    // one snapshot per edit, not one per attempt: a conflicting save retries
    // on top of the newer file, and the state worth keeping is the first one
    if (attempt === 0) await history.take(meta.id, payload, { label });

    const next = await apply(payload, meta);
    const saved = {
      elements: next.elements,
      appState: next.appState ?? payload.appState,
      // never touched by the agent surface: the image map is append-only and
      // rewriting it is how embedded images get lost
      files: payload.files ?? {},
    };
    try {
      // conditional on the revision we read: if the app saved in between, the
      // change is re-applied on top of the newer file rather than over it
      await store.save(meta.id, saved, { ifRev: payload.rev });
    } catch (err) {
      if (err?.status === 409 && attempt < 3) return mutate(meta.id, label, apply, attempt + 1);
      throw err;
    }
    // mark the bytes as ours so the app's watcher does not read this back as an
    // outside edit and snapshot it a second time
    await history.claim(meta.id, store.scenePath(meta.id)).catch(() => {});
    remember(meta.id, saved);
    return { sceneId: meta.id, name: meta.name, ...next.result };
  };

  return {
    store,
    history,
    vault: store.vault,

    /** Record a state the server just saw, so an external edit can be undone. */
    observe: remember,

    async listScenes() {
      const list = await store.list();
      return list.map((meta) => ({
        id: meta.id,
        name: meta.name,
        elements: meta.elementCount,
        updatedAt: new Date(meta.updatedAt).toISOString(),
        starred: meta.starred ?? false,
      }));
    },

    /**
     * A scene as structure rather than pixels: what is on it, where, and how it
     * connects. Usually more useful for editing than a picture is.
     */
    async describeScene(idOrName, { limit = 400, type = null } = {}) {
      const meta = await resolve(idOrName);
      const payload = await store.read(meta.id);
      let elements = live(payload.elements);
      const total = elements.length;
      if (type) elements = elements.filter((el) => el.type === type);
      const shown = elements.slice(0, limit);

      const counts = {};
      for (const el of live(payload.elements)) {
        counts[el.type] = (counts[el.type] ?? 0) + 1;
      }

      return {
        id: meta.id,
        name: meta.name,
        updatedAt: new Date(meta.updatedAt).toISOString(),
        total,
        counts,
        bounds: bounds(live(payload.elements)),
        // the paper, and the ink anything drawn without a strokeColor will get
        background: paperOf(payload),
        ink: inkFor(paperOf(payload)),
        truncated: shown.length < elements.length,
        elements: shown.map(describe),
      };
    },

    /**
     * The scene exactly as stored, plus the path to the file holding it.
     *
     * `describeScene` is the summary; this is the real thing. An agent that
     * wants to do something no helper here covers - rewrite point arrays,
     * regroup, hand-place bindings, edit the file with its own tools - starts
     * from this. `files` is omitted by default because it is base64 image data
     * and routinely dwarfs everything else in the scene.
     */
    async readScene(idOrName, { includeFiles = false } = {}) {
      const meta = await resolve(idOrName);
      const payload = await store.read(meta.id);
      remember(meta.id, payload);
      return {
        id: meta.id,
        name: meta.name,
        path: store.scenePath(meta.id),
        vault: store.vault,
        elements: payload.elements,
        appState: payload.appState,
        ...(includeFiles
          ? { files: payload.files ?? {} }
          : { fileIds: Object.keys(payload.files ?? {}) }),
      };
    },

    /**
     * Replace the element array wholesale with whatever is handed over. Full
     * Excalidraw elements pass through verbatim; anything missing required
     * fields gets them filled in. This is the escape hatch that keeps the
     * narrower helpers from being a ceiling.
     */
    async writeScene(idOrName, { elements, appState, label } = {}) {
      return mutate(idOrName, label, (payload) => {
        const { elements: built, warnings } = buildElements(elements, {
          existing: [],
        });
        return {
          elements: built,
          appState: appState ? { ...payload.appState, ...appState } : payload.appState,
          result: { total: built.length, warnings },
        };
      });
    },

    /**
     * Stash the current state without changing anything. For an agent about to
     * edit the .excalidraw file directly with its own tools: take one of these
     * first and the change stays revertible from the history sidebar.
     */
    async snapshot(idOrName, label) {
      const meta = await resolve(idOrName);
      const payload = await store.read(meta.id);
      if (!label || !String(label).trim()) {
        throw Object.assign(new Error("label is required: say why this snapshot is being taken"), { status: 400 });
      }
      const entry = await history.take(meta.id, payload, { label });
      return { sceneId: meta.id, name: meta.name, snapshot: entry };
    },

    /** Where a scene lives, for agents that would rather use their own tools. */
    async scenePath(idOrName) {
      const meta = await resolve(idOrName);
      return {
        id: meta.id,
        name: meta.name,
        path: store.scenePath(meta.id),
        vault: store.vault,
      };
    },

    async createScene({ name = "Untitled", elements = [] } = {}) {
      const meta = await store.create({ name });
      if (elements.length) {
        const appState = freshAppState();
        const { elements: built, warnings } = buildElements(elements, {
          ink: inkFor(paperOf({ appState })),
        });
        await store.save(meta.id, {
          elements: built,
          appState,
          files: {},
        });
        return {
          sceneId: meta.id,
          name: meta.name,
          added: built.length,
          elements: built.map(brief),
          warnings,
        };
      }
      return { sceneId: meta.id, name: meta.name, added: 0, elements: [], warnings: [] };
    },

    async addElements(idOrName, elements, { label } = {}) {
      return mutate(idOrName, label, (payload) => {
        const { elements: built, warnings, updated } = buildElements(elements, {
          existing: payload.elements,
          ink: inkFor(paperOf(payload)),
        });
        return {
          elements: [...withUpdated(payload.elements, updated), ...built],
          result: {
            added: built.length,
            elements: built.map(brief),
            warnings,
          },
        };
      });
    },

    /**
     * Full elements, but only the ones asked for. The point of the filters is
     * that reading a 700-element scene to change two of them is the expensive
     * part of agent editing - not the file rewrite, which happens here on local
     * disk either way.
     */
    async readElements(idOrName, { ids, type, contains, region, limit = 100 } = {}) {
      const meta = await resolve(idOrName);
      const payload = await store.read(meta.id);
      remember(meta.id, payload);

      let elements = live(payload.elements);
      if (ids?.length) {
        const wanted = new Set(ids);
        elements = elements.filter((el) => wanted.has(el.id));
      }
      if (type) {
        const types = new Set([].concat(type));
        elements = elements.filter((el) => types.has(el.type));
      }
      if (contains) {
        const needle = String(contains).toLowerCase();
        elements = elements.filter((el) =>
          String(el.text ?? "").toLowerCase().includes(needle),
        );
      }
      if (region) {
        const { x = -Infinity, y = -Infinity, width = Infinity, height = Infinity } = region;
        elements = elements.filter(
          (el) =>
            el.x + el.width >= x &&
            el.y + el.height >= y &&
            el.x <= x + width &&
            el.y <= y + height,
        );
      }
      return {
        id: meta.id,
        name: meta.name,
        matched: elements.length,
        truncated: elements.length > limit,
        elements: elements.slice(0, limit),
      };
    },

    /**
     * Change named fields on named elements and leave everything else alone.
     * This is the cheap edit: send `{ id, x: 40 }`, not the whole scene.
     *
     * Two shapes are accepted - a list of patches each carrying its own `id`,
     * or `{ ids: [...], patch: {...} }` to apply one change across many.
     */
    async updateElements(idOrName, patches, { label, ids, patch } = {}) {
      const list =
        Array.isArray(patches) && patches.length
          ? patches
          : (ids ?? []).map((id) => ({ id, ...(patch ?? {}) }));

      return mutate(idOrName, label, (payload) => {
        const wanted = new Map(list.filter((p) => p?.id).map((p) => [p.id, p]));
        const touched = new Set();
        let elements = payload.elements.map((el) => {
          const next = wanted.get(el.id);
          if (!next) return el;
          touched.add(el.id);
          return patchElement(el, next);
        });
        // a label that re-wrapped taller needs its container to grow with it,
        // as it does when the text is edited in the app
        const grown = new Map();
        for (const el of elements) {
          if (!touched.has(el.id) || !el.containerId) continue;
          const container = elements.find((c) => c.id === el.containerId);
          if (!container) continue;
          const bigger = growContainerFor(el, container);
          if (bigger !== container) grown.set(container.id, bigger);
        }
        if (grown.size) elements = elements.map((el) => grown.get(el.id) ?? el);
        return {
          elements,
          result: {
            updated: touched.size,
            missing: [...wanted.keys()].filter((id) => !touched.has(id)),
          },
        };
      });
    },

    async deleteElements(idOrName, ids, { label } = {}) {
      return mutate(idOrName, label, (payload) => {
        const doomed = new Set(ids ?? []);
        // a label dies with its container, as it does when deleted in the app
        for (const el of payload.elements) {
          if (el.containerId && doomed.has(el.containerId)) doomed.add(el.id);
        }
        let removed = 0;
        // soft delete, which is what Excalidraw itself does, so the change
        // still syncs cleanly to an open editor
        const elements = payload.elements.map((el) => {
          if (el.isDeleted) return el;
          if (doomed.has(el.id)) {
            removed += 1;
            return { ...el, isDeleted: true, version: (el.version ?? 1) + 1 };
          }
          // an arrow bound to something that is gone would point at nothing
          const start = el.startBinding && doomed.has(el.startBinding.elementId);
          const end = el.endBinding && doomed.has(el.endBinding.elementId);
          const bound = (el.boundElements ?? []).some((b) => doomed.has(b.id));
          if (!start && !end && !bound) return el;
          return {
            ...el,
            ...(start ? { startBinding: null } : {}),
            ...(end ? { endBinding: null } : {}),
            ...(bound ? { boundElements: el.boundElements.filter((b) => !doomed.has(b.id)) } : {}),
            version: (el.version ?? 1) + 1,
          };
        });
        return { elements, result: { deleted: removed } };
      });
    },

    /**
     * Shift a set of elements by (dx, dy) in one write. Select by ids, by
     * group id, by a region box, or any mix; a container's bound label always
     * travels with it, and an arrow whose both ends are in the set keeps its
     * bindings because everything it is bound to moved the same way.
     *
     * This exists because rearranging a layout by hand is dozens of {id, x, y}
     * patches, each needing the old position first, and getting one wrong
     * tears a panel apart.
     */
    async moveElements(idOrName, { ids, groupIds, region, dx = 0, dy = 0, label } = {}) {
      return mutate(idOrName, label, (payload) => {
        const wantedIds = new Set(ids ?? []);
        const wantedGroups = new Set(groupIds ?? []);
        const box = region
          ? {
              x: region.x ?? -Infinity,
              y: region.y ?? -Infinity,
              width: region.width ?? Infinity,
              height: region.height ?? Infinity,
            }
          : null;
        const inBox = (el) =>
          box &&
          el.x + (el.width ?? 0) >= box.x &&
          el.y + (el.height ?? 0) >= box.y &&
          el.x <= box.x + box.width &&
          el.y <= box.y + box.height;

        const moving = new Set();
        for (const el of payload.elements) {
          if (el.isDeleted) continue;
          if (wantedIds.has(el.id) || inBox(el) || (el.groupIds ?? []).some((g) => wantedGroups.has(g))) {
            moving.add(el.id);
          }
        }
        // a label goes where its container goes, whether or not it was named
        for (const el of payload.elements) {
          if (el.containerId && moving.has(el.containerId)) moving.add(el.id);
        }

        const moved = [];
        let followed = 0;
        const elements = payload.elements.map((el) => {
          if (moving.has(el.id)) {
            const next = patchElement(el, { x: el.x + dx, y: el.y + dy });
            moved.push(next);
            return next;
          }
          /**
           * An arrow that stays put but is bound to something that moved
           * keeps that end on the shape, the way Excalidraw drags it along.
           * Without this the arrowhead is left pointing at empty paper, or
           * buried inside the shape's new position, and the render looks
           * right only until the editor opens the file.
           */
          if (el.type !== "arrow" || !Array.isArray(el.points) || el.points.length < 2) return el;
          const startFollows = !!el.startBinding && moving.has(el.startBinding.elementId);
          const endFollows = !!el.endBinding && moving.has(el.endBinding.elementId);
          if (!startFollows && !endFollows) return el;
          const points = el.points.map((p) => [p[0], p[1]]);
          let { x, y } = el;
          if (startFollows) {
            // the first point is always [0, 0]: move the origin and keep the
            // rest of the line where it was
            x += dx;
            y += dy;
            for (let i = 1; i < points.length; i += 1) {
              points[i][0] -= dx;
              points[i][1] -= dy;
            }
          }
          if (endFollows) {
            const last = points[points.length - 1];
            last[0] += dx;
            last[1] += dy;
          }
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          followed += 1;
          return patchElement(el, {
            x,
            y,
            points,
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          });
        });
        return {
          elements,
          result: {
            moved: moved.length,
            followed,
            missing: [...wantedIds].filter((id) => !moving.has(id)),
            bounds: bounds(moved),
          },
        };
      });
    },

    async replaceElements(idOrName, elements, { label } = {}) {
      return mutate(idOrName, label, (payload) => {
        const { elements: built, warnings } = buildElements(elements, {
          ink: inkFor(paperOf(payload)),
        });
        return {
          elements: built,
          result: { total: built.length, warnings },
        };
      });
    },

    /**
     * Draw by writing SVG.
     *
     * Placing a figure as hundreds of separate positioned shapes does not work -
     * every part comes out crisp and the whole thing comes out as a pile,
     * because nothing holds the proportions together. Writing the same figure as
     * SVG does work, because the curves are real and the whole drawing is
     * authored in one coordinate system.
     *
     * The result is not an embedded image: every path becomes a real element
     * that can be selected, moved and recoloured on the canvas.
     */
    async importSvg(idOrName, svg, options = {}) {
      // strokes the SVG leaves unspecified take the ink for this paper; the
      // conversion runs before mutate so a bad SVG fails before any snapshot
      const meta = await resolve(idOrName);
      const ink = inkFor(paperOf(await store.read(meta.id)));
      const converted = svgToSpecs(svg, { currentColor: ink, ...options });
      const result = await mutate(
        meta.id,
        options.label,
        (payload) => {
          const { elements: built, warnings, updated } = buildElements(converted.specs, {
            existing: payload.elements,
            ink,
          });
          const group = options.group === false ? null : `svg-${Math.random().toString(36).slice(2, 10)}`;
          const grouped = group ? withGroup(built, group) : built;
          return {
            elements: [...withUpdated(payload.elements, updated), ...grouped],
            result: {
              added: grouped.length,
              // the handle for moving or deleting the piece as one thing
              groupId: group,
              ids: grouped.map((el) => el.id),
              warnings: [...converted.warnings, ...warnings],
            },
          };
        },
      );
      return { ...result, placed: converted.placed, source: converted.source };
    },

    async setBackground(idOrName, color, { label } = {}) {
      // the pen for hand drawing follows the paper, so the next stroke drawn in
      // the app is visible; existing elements are left exactly as they are
      return mutate(idOrName, label, (payload) => ({
        elements: payload.elements,
        appState: {
          ...payload.appState,
          viewBackgroundColor: color,
          currentItemStrokeColor: inkFor(color),
        },
        result: { background: color, ink: inkFor(color) },
      }));
    },

    /**
     * Layout problems, found by geometry rather than by looking. Cheap enough
     * to run after every batch of drawing.
     */
    async checkScene(idOrName, options = {}) {
      const meta = await resolve(idOrName);
      const payload = await store.read(meta.id);
      remember(meta.id, payload);
      return {
        id: meta.id,
        name: meta.name,
        ...inspectScene(payload.elements, options),
      };
    },

    /* ---- history ------------------------------------------------- */

    /**
     * A scene file changed without going through here - an agent edited it with
     * its own tools. The new state is already on disk, so the only chance to
     * capture the old one is from what was last seen. Returns the entry when it
     * managed to, null when the previous state was never observed (a fresh
     * server that has not read this scene yet).
     */
    async noteExternalChange(sceneId) {
      // the file is gone (deleted, or moved by hand): nothing to snapshot,
      // and taking one would recreate the history folder for a dead scene
      if ((await store.rev(sceneId)) === null) {
        lastKnown.delete(sceneId);
        return null;
      }
      // our own write, made from another process: already snapshotted
      if (await history.isClaimed(sceneId, store.scenePath(sceneId))) return null;
      const previous = lastKnown.get(sceneId);
      if (!previous) return null;
      const entry = await history
        .take(sceneId, previous, { label: "edited outside Sketchdex", origin: "external" })
        .catch(() => null);
      const fresh = await store.read(sceneId).catch(() => null);
      if (fresh) remember(sceneId, fresh);
      return entry;
    },

    async listHistory(idOrName) {
      const meta = await resolve(idOrName);
      const { entries, bytes } = await history.list(meta.id);
      return { sceneId: meta.id, name: meta.name, bytes, entries };
    },

    /**
     * Put a snapshot back on the canvas. This is itself a change, so it
     * snapshots the state it is replacing - reverting is never a one-way door.
     */
    async restoreSnapshot(idOrName, snapId) {
      const meta = await resolve(idOrName);
      const snap = await history.read(meta.id, snapId);
      return mutate(meta.id, "restore snapshot", (payload) => ({
        elements: snap.elements,
        appState: { ...payload.appState, ...(snap.appState ?? {}) },
        result: { restored: snapId, elements: snap.elements.length },
      }));
    },

    async discardSnapshot(idOrName, snapId) {
      const meta = await resolve(idOrName);
      return { entries: await history.discard(meta.id, snapId) };
    },

    async clearHistory(idOrName) {
      const meta = await resolve(idOrName);
      return { entries: await history.clear(meta.id) };
    },
  };
}
