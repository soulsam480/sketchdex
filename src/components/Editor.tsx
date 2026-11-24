import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  Footer,
  MainMenu,
  getSceneVersion,
  reconcileElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import { FontSize } from "./FontSize";
import { Wordmark } from "./Wordmark";
import History from "./History";
import Comments from "./Comments";
import CommentPopover from "./CommentPopover";
import {
  addComment,
  clearHistory,
  clientId,
  discardSnapshot,
  isConflict,
  loadComments,
  loadHistory,
  loadLibrary,
  loadScene,
  onVaultEvent,
  readSnapshot,
  renameScene,
  restoreSnapshot,
  saveLibrary,
  saveScene,
  saveThumb,
  slimAppState,
  updateComment,
  type Comment,
  type LibraryItem,
  type Snapshot,
} from "../lib/store";
import { renderThumbnail } from "../lib/thumbnail";
import { useToolShortcuts } from "../lib/toolbar";
import type { SceneMeta, ScenePayload } from "../lib/types";

const SAVE_DEBOUNCE = 700;
const VIEW_DEBOUNCE = 2500;
const THUMB_INTERVAL = 6000;
const RETRY_DELAY = 3000;

const UI_OPTIONS = {
  canvasActions: { toggleTheme: false },
} as const;

const signature = (items: readonly LibraryItem[]) =>
  items
    .map((item) => `${item.id}:${getSceneVersion(item.elements ?? [])}`)
    .sort()
    .join("|");

/**
 * Excalidraw restores its own copy of the library from browser storage and
 * merges it with the vault items, so the same id can arrive twice. The vault
 * keeps one entry per id.
 */
const dedupeLibrary = (items: readonly LibraryItem[]) => {
  const byId = new Map<string, LibraryItem>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
};

/**
 * The Excalidraw chrome is always dark to match the app. The canvas, though,
 * is never filtered: Excalidraw's dark theme normally draws the canvas through
 * invert(93%) hue-rotate(180deg), which shows a real hex as something else
 * (bright gold as brown, white as black). That is turned off in index.css, so
 * what is on screen is exactly what is in the file - a dark drawing is one
 * whose background and ink are actually dark and light in the data.
 */

type Props = {
  meta: SceneMeta;
  scenes: SceneMeta[];
  onBack: () => void;
  onOpen: (id: string) => void;
  onIndexChange: () => Promise<SceneMeta[]>;
  onOpenSwitcher: () => void;
};

export default function Editor({
  meta,
  scenes,
  onBack,
  onOpen,
  onIndexChange,
  onOpenSwitcher,
}: Props) {
  const [initial, setInitial] = useState<ScenePayload | null>(null);
  /**
   * "loading" and "failed" are kept apart from "an empty scene": a load that
   * comes back with nothing must never mount a blank canvas, because the first
   * save would then write that blank over the real file. "removed" is the
   * vault telling us the file is gone; saving would only recreate it.
   */
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "failed" | "removed"
  >("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [editingName, setEditingName] = useState(false);
  const [api, setApi] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [popover, setPopover] = useState<{
    element: { id: string; type: string; text?: string };
    point: { x: number; y: number };
  } | null>(null);
  const [panelElement, setPanelElement] = useState<{
    id: string;
    type: string;
    text?: string;
  } | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentTotals, setCommentTotals] = useState({ open: 0, resolved: 0 });
  const [selected, setSelected] = useState<string[]>([]);
  const selectionKey = useRef("");
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [historyBytes, setHistoryBytes] = useState(0);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [liveCount, setLiveCount] = useState(meta.elementCount);

  /**
   * While a snapshot is on screen, nothing is saved. The canvas is showing a
   * state that is deliberately not the file, and Excalidraw fires onChange for
   * the swap itself, so without this the preview would write itself to disk.
   */
  const previewRef = useRef<string | null>(null);

  // hand on 1, shapes shifted along, image unbound (see lib/toolbar.ts)
  useToolShortcuts(api);

  /**
   * Excalidraw fires onChange constantly. Routing that through React state
   * would re-render this component (and Excalidraw with it) on every stroke,
   * so the save indicator is written straight to the DOM instead.
   */
  const statusRef = useRef<HTMLSpanElement>(null);
  const setStatus = (
    text: "saving" | "saved" | "retrying" | "preview" | "not loaded" | "removed",
  ) => {
    if (statusRef.current) statusRef.current.textContent = text;
  };

  const latest = useRef<ScenePayload | null>(null);
  const timer = useRef<number | null>(null);
  const lastVersion = useRef(-1);
  /** Revision of the file this tab last loaded or wrote; saves are conditional on it. */
  const rev = useRef<string | null>(null);
  /** True once the file has actually been read; nothing is written before that. */
  const loaded = useRef(false);
  /** True once the vault reports the file gone; nothing is written after that. */
  const gone = useRef(false);
  /** The save currently on the wire, so a second flush joins it instead of racing it. */
  const inflight = useRef<Promise<void> | null>(null);
  const lastThumbAt = useRef(0);
  const viewDirty = useRef(false);
  const libraryRev = useRef<string | null>(null);
  const librarySignature = useRef("");
  const libraryTimer = useRef<number | null>(null);

  const [libraryItems] = useState(() =>
    loadLibrary()
      .then((r) => {
        if (r) {
          libraryRev.current = r.rev;
          librarySignature.current = signature(r.items);
        }
        return r?.items ?? [];
      })
      .catch(() => []),
  );

  // declared ahead of flush so the timer helpers and flush can reach each
  // other without recursing through a stale closure
  const flushRef = useRef<(immediate?: boolean, keepalive?: boolean) => Promise<void>>(
    async () => {},
  );
  const mergeFromDiskRef = useRef<() => Promise<void>>(async () => {});

  /**
   * One pending timer at a time, and `timer.current` is null whenever nothing
   * is pending. beforeunload relies on that to know whether an edit is still
   * unsaved.
   */
  const cancelPending = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const schedule = useCallback(
    (delay: number) => {
      cancelPending();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flushRef.current();
      }, delay);
    },
    [cancelPending],
  );
  /**
   * Excalidraw normalises the scene on load and fires onChange for it. Nothing
   * before the first real interaction counts as an edit, so opening a scene
   * never writes and never moves its "last edited" time.
   */
  const interacted = useRef(false);
  const markInteracted = () => {
    interacted.current = true;
  };

  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    loadScene(meta.id).then((payload) => {
      if (!alive) return;
      if (!payload) {
        // no canvas is mounted: mounting an empty one here is exactly how a
        // blank scene ends up saved over the real file
        setLoadState("failed");
        setStatus("not loaded");
        return;
      }
      lastVersion.current = getSceneVersion(payload.elements as any);
      rev.current = payload.rev ?? null;
      loaded.current = true;
      setInitial(payload);
      setLoadState("ready");
      setStatus("saved");
    });
    return () => {
      alive = false;
    };
  }, [meta.id, loadAttempt]);

  const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

  /** `immediate` means "we are leaving now": skip the thumbnail throttle and
   * refresh the library index. It never forces a write on its own. `keepalive`
   * is for the save fired as the page hides or closes (see saveScene). */
  const flush = useCallback(
    async (immediate = false, keepalive = false): Promise<void> => {
      // a second PUT while one is out would carry the same ifRev and be
      // refused as a conflict against our own write. Wait for the running
      // one, then look again: edits made meanwhile still need their turn,
      // and so does the leaving-now work
      if (inflight.current) {
        await inflight.current.catch(() => {});
        return flushRef.current(immediate, keepalive);
      }
      const run = (async () => {
        // never write a scene that was never read, or one the vault has
        // reported gone: both would put a canvas on disk that is not the file
        if (!loaded.current || gone.current) return;
        const payload = latest.current;
        if (!payload || previewRef.current !== null) return;
        const version = getSceneVersion(payload.elements as any);
        const contentChanged = version !== lastVersion.current;
        if (!contentChanged && !viewDirty.current) {
          setStatus("saved");
          return;
        }

        try {
          const saved = await saveScene(meta.id, payload, {
            touch: contentChanged,
            ifRev: rev.current,
            keepalive,
          });
          rev.current = saved.rev;
        } catch (err) {
          if (isConflict(err)) {
            // the file moved on under this tab (an agent wrote, most likely):
            // fold what is on disk into what is on the canvas, then save that
            await mergeFromDiskRef.current();
            return;
          }
          // the vault is unreachable: keep the change pending and try again,
          // never advance lastVersion or the edit would be dropped silently
          setStatus("retrying");
          schedule(RETRY_DELAY);
          return;
        }

        lastVersion.current = version;
        viewDirty.current = false;

        if (
          contentChanged &&
          (immediate || Date.now() - lastThumbAt.current > THUMB_INTERVAL)
        ) {
          lastThumbAt.current = Date.now();
          try {
            const svg = await renderThumbnail(payload);
            await saveThumb(meta.id, svg ?? "");
          } catch {
            // a missing preview is cosmetic; the scene itself is already saved
          }
        }
        setStatus("saved");
        if (immediate) await onIndexChange();
      })();
      inflight.current = run;
      try {
        await run;
      } finally {
        inflight.current = null;
      }
    },
    [meta.id, onIndexChange, schedule],
  );

  // lets the retry timer inside flush call the latest flush without recursing
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const onChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      if (previewRef.current !== null) return;
      latest.current = {
        elements,
        appState: slimAppState(appState),
        files,
      };
      const selectedIds = Object.keys(appState.selectedElementIds ?? {}).filter(
        (id) => appState.selectedElementIds[id],
      );
      const key = selectedIds.join(",");
      if (key !== selectionKey.current) {
        selectionKey.current = key;
        setSelected(selectedIds);
        setPanelElement(null);
      }
      const version = getSceneVersion(elements as any);

      // load-time normalisation: adopt it as the baseline, write nothing
      if (!interacted.current) {
        lastVersion.current = version;
        return;
      }

      if (version === lastVersion.current) {
        // pan, zoom, tool change: persisted quietly, without touching updatedAt
        viewDirty.current = true;
      } else {
        setStatus("saving");
      }
      schedule(version === lastVersion.current ? VIEW_DEBOUNCE : SAVE_DEBOUNCE);
    },
    [schedule],
  );

  const onLibraryChange = useCallback(
    (items: readonly LibraryItem[]) => {
      const deduped = dedupeLibrary(items);
      const next = signature(deduped);
      const duplicates = deduped.length !== items.length;
      if (next === librarySignature.current) {
        if (duplicates) {
          api?.updateLibrary({ libraryItems: deduped, merge: false });
        }
        return;
      }
      librarySignature.current = next;
      if (duplicates) {
        api?.updateLibrary({ libraryItems: deduped, merge: false });
      }
      if (libraryTimer.current !== null) window.clearTimeout(libraryTimer.current);
      libraryTimer.current = window.setTimeout(async () => {
        libraryTimer.current = null;
        try {
          const saved = await saveLibrary(deduped, libraryRev.current);
          libraryRev.current = saved.rev;
        } catch (err) {
          if (!isConflict(err)) return;
          const fresh = await loadLibrary();
          if (!fresh) return;
          libraryRev.current = fresh.rev;
          librarySignature.current = signature(fresh.items);
          api?.updateLibrary({ libraryItems: fresh.items, merge: true });
        }
      }, 600);
    },
    [api],
  );

  const refreshHistory = useCallback(async () => {
    const { entries, bytes } = await loadHistory(meta.id);
    setSnapshots(entries);
    setHistoryBytes(bytes);
    return entries;
  }, [meta.id]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const refreshComments = useCallback(async () => {
    const list = await loadComments(meta.id).catch(() => null);
    if (!list) return;
    setComments(list.comments);
    setCommentTotals({ open: list.open, resolved: list.resolved });
  }, [meta.id]);

  useEffect(() => {
    refreshComments();
  }, [refreshComments]);

  useEffect(() => setLiveCount(meta.elementCount), [meta.elementCount]);

  /** Put a set of elements on the canvas without going through a remount. */
  const paint = useCallback(
    (payload: ScenePayload) => {
      if (!api) return;
      api.updateScene({
        elements: payload.elements as any,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setLiveCount(payload.elements.filter((el: any) => !el.isDeleted).length);
    },
    [api],
  );

  /**
   * Something changed this scene from outside this tab. Almost always an agent
   * writing to the vault: the file on disk is now ahead of what is in memory,
   * and the next local save would overwrite it, so adopt it instead.
   */
  const adoptFromDisk = useCallback(async () => {
    if (previewRef.current !== null) return;
    // edits typed in the last second or two are not on disk yet; folding the
    // outside change into them beats throwing either side away
    const dirty =
      latest.current && getSceneVersion(latest.current.elements as any) !== lastVersion.current;
    if (dirty) return mergeFromDiskRef.current();
    const payload = await loadScene(meta.id);
    if (!payload) return;
    cancelPending();
    lastVersion.current = getSceneVersion(payload.elements as any);
    rev.current = payload.rev ?? null;
    latest.current = payload;
    viewDirty.current = false;
    paint(payload);
    setStatus("saved");
    // the card preview is now stale, and this tab is the thing that can redraw it
    renderThumbnail(payload)
      .then((svg) => saveThumb(meta.id, svg ?? ""))
      .then(() => onIndexChange())
      .catch(() => {});
  }, [meta.id, paint, onIndexChange, cancelPending]);

  /**
   * A save was refused because the file changed under this tab. Rather than
   * pick a side, merge: Excalidraw elements carry a version, so per element the
   * newer edit wins and anything new on either side is kept. The merged result
   * goes on the canvas and is saved against the revision now on disk. What can
   * be lost is only the loser of a same-element tie, never a whole drawing.
   */
  const mergeFromDisk = useCallback(async () => {
    const disk = await loadScene(meta.id);
    const local = latest.current;
    if (!local || previewRef.current !== null) return;
    if (!disk) {
      // the vault refused the save a moment ago and now cannot be read either:
      // the edit stays pending and gets another go, the same as an outage.
      // Returning here would strand it with nothing scheduled to save it.
      setStatus("retrying");
      schedule(RETRY_DELAY);
      return;
    }
    const merged = reconcileElements(
      local.elements as any,
      disk.elements as any,
      (api?.getAppState?.() ?? local.appState) as any,
    );
    const payload: ScenePayload = {
      elements: merged,
      appState: local.appState,
      files: { ...(disk.files ?? {}), ...(local.files ?? {}) },
      rev: disk.rev,
    };
    rev.current = disk.rev ?? null;
    latest.current = payload;
    // the merged state is what the canvas shows from now on; version differs
    // from what disk holds, so the next flush writes it (against disk's rev)
    lastVersion.current = getSceneVersion(disk.elements as any);
    paint(payload);
    schedule(SAVE_DEBOUNCE);
    setStatus("saving");
  }, [meta.id, api, paint, schedule]);
  useEffect(() => {
    mergeFromDiskRef.current = mergeFromDisk;
  }, [mergeFromDisk]);

  useEffect(
    () =>
      onVaultEvent((event) => {
        if (event.type === "library") {
          loadLibrary().then((fresh) => {
            if (!fresh) return;
            libraryRev.current = fresh.rev;
            librarySignature.current = signature(fresh.items);
            Promise.resolve(
              api?.updateLibrary({ libraryItems: fresh.items, merge: true }),
            ).catch(() => {});
          });
          return;
        }
        if (event.id !== meta.id) return;
        if (event.type === "history") {
          refreshHistory();
          refreshComments();
          return;
        }
        if (event.type === "removed") {
          // the file was deleted or moved out of the vault. Autosave stops
          // here: a write now would quietly recreate it from memory
          gone.current = true;
          cancelPending();
          setLoadState("removed");
          setStatus("removed");
          return;
        }
        if (event.by === clientId) return; // our own save, echoed back
        adoptFromDisk();
        refreshHistory();
        refreshComments();
      }),
    [meta.id, adoptFromDisk, refreshHistory, refreshComments, cancelPending, api],
  );

  const preview = useCallback(
    async (snapId: string | null) => {
      if (snapId === null) {
        previewRef.current = null;
        setPreviewing(null);
        const payload = await loadScene(meta.id);
        if (payload) {
          lastVersion.current = getSceneVersion(payload.elements as any);
          rev.current = payload.rev ?? null;
          latest.current = payload;
          paint(payload);
        }
        return;
      }
      // strokes from the last debounce window are still only in memory; write
      // them first, or leaving the preview reloads the file without them
      cancelPending();
      await flush();
      // freeze saving before painting, or the swap saves itself over the file
      cancelPending();
      previewRef.current = snapId;
      setPreviewing(snapId);
      setStatus("preview");
      const snap = await readSnapshot(meta.id, snapId).catch(() => null);
      if (snap) paint({ elements: snap.elements, appState: snap.appState, files: null });
    },
    [meta.id, paint, flush, cancelPending],
  );

  /** The end of a review: this state is the one, and the rest can go. */
  const keep = useCallback(
    async (snapId: string | null) => {
      previewRef.current = null;
      setPreviewing(null);
      if (snapId) await restoreSnapshot(meta.id, snapId).catch(() => {});
      await clearHistory(meta.id).catch(() => {});
      await refreshHistory();
      await adoptFromDisk();
    },
    [meta.id, refreshHistory, adoptFromDisk],
  );

  const discard = useCallback(
    async (snapId: string) => {
      if (previewRef.current === snapId) await preview(null);
      await discardSnapshot(meta.id, snapId).catch(() => {});
      await refreshHistory();
    },
    [meta.id, preview, refreshHistory],
  );

  /** An element's name as the person reads it: its text, or its label's text. */
  const elementName = useCallback(
    (elements: any[], element: any) => {
      const label =
        element.text ??
        elements.find((el) => el.containerId === element.id && !el.isDeleted)?.text;
      return typeof label === "string" && label.trim().length > 0
        ? label.trim()
        : undefined;
    },
    [],
  );

  const describeElement = useCallback(
    (element: any) => {
      const elements: any[] = api?.getSceneElements?.() ?? [];
      return {
        id: element.id as string,
        type: element.type as string,
        text: elementName(elements, element),
      };
    },
    [api, elementName],
  );

  const selectedElement = (() => {
    if (!api || selected.length !== 1) return null;
    const elements: any[] = api.getSceneElements();
    const element = elements.find((el) => el.id === selected[0] && !el.isDeleted);
    return element ? describeElement(element) : null;
  })();

  /**
   * Comment mode does not lean on Excalidraw's selection: a capture-phase
   * pointer handler swallows the click, so entering the mode cannot move or
   * edit anything, and the element under the cursor is found by geometry.
   */
  const elementAt = useCallback(
    (clientX: number, clientY: number, host: HTMLElement) => {
      if (!api) return null;
      const app = api.getAppState();
      const zoom = app.zoom?.value ?? 1;
      const box = host.getBoundingClientRect();
      const x = (clientX - box.left) / zoom - app.scrollX;
      const y = (clientY - box.top) / zoom - app.scrollY;
      const elements: any[] = api.getSceneElements();
      const byId = new Map(elements.map((el) => [el.id, el]));
      const pad = 6 / zoom;
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        const element = elements[index];
        if (element.isDeleted || element.type === "frame") continue;
        const width = Math.max(element.width ?? 0, 8);
        const height = Math.max(element.height ?? 0, 8);
        if (
          x < element.x - pad ||
          x > element.x + width + pad ||
          y < element.y - pad ||
          y > element.y + height + pad
        ) {
          continue;
        }
        if (element.containerId) {
          const parent = byId.get(element.containerId);
          if (parent && !parent.isDeleted) return parent;
          continue;
        }
        // a bare text sitting on a shape is its label in everything but the
        // data: commenting should land on the shape
        if (element.type === "text") {
          const centreX = element.x + width / 2;
          const centreY = element.y + height / 2;
          for (let below = index - 1; below >= 0; below -= 1) {
            const host = elements[below];
            if (host.isDeleted || host.type in ["text", "frame"]) continue;
            const hostWidth = Math.max(host.width ?? 0, 0);
            const hostHeight = Math.max(host.height ?? 0, 0);
            if (
              centreX >= host.x &&
              centreX <= host.x + hostWidth &&
              centreY >= host.y &&
              centreY <= host.y + hostHeight
            ) {
              return host;
            }
          }
        }
        return element;
      }
      return null;
    },
    [api],
  );

  const insidePopover = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-comment-popover]") !== null;

  const canvasHost = useRef<HTMLDivElement>(null);

  /**
   * Native capture listeners, not React props: the canvas is Excalidraw's own
   * DOM, and a click swallowed here has to be swallowed before Excalidraw sees
   * it or the mode would move and select things.
   */
  useEffect(() => {
    const node = canvasHost.current;
    if (!node || !commentMode) return;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || insidePopover(event.target)) return;
      event.stopPropagation();
      pressAt.current = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (!pressAt.current || insidePopover(event.target)) return;
      event.stopPropagation();
      const start = pressAt.current;
      pressAt.current = null;
      // a drag is a pan attempt, not a click on a shape
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const element = elementAt(event.clientX, event.clientY, node);
      if (!element) {
        setPopover(null);
        return;
      }
      setPopover({
        element: describeElement(element),
        point: { x: event.clientX, y: event.clientY },
      });
    };
    node.addEventListener("pointerdown", onDown, true);
    node.addEventListener("pointerup", onUp, true);
    return () => {
      node.removeEventListener("pointerdown", onDown, true);
      node.removeEventListener("pointerup", onUp, true);
    };
  }, [commentMode, elementAt, describeElement]);

  useEffect(() => {
    if (!commentMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popover) setPopover(null);
      else setCommentMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commentMode, popover]);

  const leaveCommentMode = useCallback(() => {
    setCommentMode(false);
    setPopover(null);
  }, []);

  /**
   * Comment writes go through the agent surface, not the canvas save. The file
   * comes back with a new revision, so adopt it: otherwise the next local save
   * would be refused and have to merge for no reason.
   */
  const writeComment = useCallback(
    async (body: string, target: { id: string } | null) => {
      if (!target) return;
      await addComment(meta.id, target.id, body);
      await refreshComments();
      await refreshHistory();
      await adoptFromDisk();
    },
    [meta.id, refreshComments, refreshHistory, adoptFromDisk],
  );

  const panelTarget = panelElement ?? selectedElement;

  const changeComment = useCallback(
    async (comment: Comment, action: "resolve" | "reopen" | "delete") => {
      await updateComment(meta.id, comment.elementId, comment.id, action, comment.body);
      await refreshComments();
      await refreshHistory();
      await adoptFromDisk();
    },
    [meta.id, refreshComments, refreshHistory, adoptFromDisk],
  );

  // save on unmount, tab hide, and window close
  useEffect(() => {
    const onHide = () => {
      // keepalive so the request survives the page going away with it
      if (document.visibilityState === "hidden") flush(true, true);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // only while an edit is actually unsaved: a debounce still waiting or
      // a PUT on the wire. Fire the pending one now so the hold is short.
      const pending = timer.current !== null;
      if (!pending && !inflight.current) return;
      if (pending) {
        cancelPending();
        flush(true, true);
      }
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      cancelPending();
      flush(true);
    };
  }, [flush, cancelPending]);

  const leave = useCallback(async () => {
    cancelPending();
    await flush(true);
    onBack();
  }, [flush, onBack, cancelPending]);

  // page order, oldest first, so ‹ › reads like leafing through a book and
  // never reshuffles as scenes get edited
  const ordered = [...scenes].sort((a, b) => a.createdAt - b.createdAt);
  const index = ordered.findIndex((scene) => scene.id === meta.id);
  const step = async (delta: number) => {
    const next = ordered[index + delta];
    if (!next) return;
    cancelPending();
    await flush(true);
    onOpen(next.id);
  };

  const exportFile = () => {
    const payload = latest.current ?? initial;
    if (!payload) return;
    const json = serializeAsJSON(
      payload.elements as any,
      payload.appState as any,
      (payload.files ?? {}) as any,
      "local",
    );
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${meta.name}.excalidraw`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="hairline-b flex items-center gap-3 px-4 py-2.5">
        <button
          onClick={leave}
          title="All scenes"
          className="flex items-center gap-2 rounded-md px-1.5 py-1 text-graphite transition-colors hover:text-chalk"
        >
          <Wordmark compact />
          <span className="text-xs">All scenes</span>
        </button>

        <span className="text-graphite/40">/</span>

        {editingName ? (
          <input
            autoFocus
            defaultValue={meta.name}
            onBlur={async (event) => {
              await renameScene(meta.id, event.target.value);
              await onIndexChange();
              setEditingName(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setEditingName(false);
            }}
            className="rounded bg-ink-800 px-2 py-0.5 text-sm text-chalk outline-none"
          />
        ) : (
          <button
            onDoubleClick={() => setEditingName(true)}
            onClick={() => setEditingName(true)}
            title="Rename"
            className="max-w-[40vw] truncate text-sm text-chalk"
          >
            {meta.name}
          </button>
        )}

        <span ref={statusRef} className="label-mono normal-case">
          saved
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => step(-1)}
            disabled={index <= 0}
            title="Previous scene"
            className="rounded px-2 py-1 text-sm text-graphite transition-colors hover:text-chalk disabled:opacity-25 disabled:hover:text-graphite"
          >
            ‹
          </button>
          <span className="label-mono w-16 text-center normal-case">
            {index + 1} / {ordered.length}
          </span>
          <button
            onClick={() => step(1)}
            disabled={index === ordered.length - 1}
            title="Next scene"
            className="rounded px-2 py-1 text-sm text-graphite transition-colors hover:text-chalk disabled:opacity-25 disabled:hover:text-graphite"
          >
            ›
          </button>
          <button
            onClick={() => {
              setCommentsOpen(false);
              setPanelElement(null);
              setPopover(null);
              setCommentMode((on) => !on);
            }}
            title="Comment on the canvas: click a shape (Esc to leave)"
            className={`hairline ml-2 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              commentMode
                ? "bg-ink-800 text-chalk"
                : "bg-ink-900 text-graphite hover:text-chalk"
            }`}
          >
            Comments
            {commentTotals.open > 0 && (
              <span className="rounded bg-violet/25 px-1 font-mono text-[10px] text-chalk">
                {commentTotals.open}
              </span>
            )}
          </button>

          <button
            onClick={() => setHistoryOpen((open) => !open)}
            title="Snapshots taken before changes made outside Sketchdex"
            className={`hairline ml-1 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              historyOpen
                ? "bg-ink-800 text-chalk"
                : "bg-ink-900 text-graphite hover:text-chalk"
            }`}
          >
            History
            {snapshots.length > 0 && (
              <span className="rounded bg-violet/25 px-1 font-mono text-[10px] text-chalk">
                {snapshots.length}
              </span>
            )}
          </button>

          <button
            onClick={onOpenSwitcher}
            title="Jump to a scene (⌘K, or ⌥K)"
            className="hairline ml-1 rounded-md bg-ink-900 px-2.5 py-1 font-mono text-[11px] text-graphite transition-colors hover:text-chalk"
          >
            ⌘K
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      <div
        ref={canvasHost}
        className={`excalidraw-wrapper relative min-w-0 flex-1 ${
          commentMode ? "cursor-crosshair" : ""
        }`}
        onPointerDownCapture={markInteracted}
        onWheelCapture={markInteracted}
        onKeyDownCapture={markInteracted}
      >
        {commentMode && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-ink-800/95 px-3 py-1 text-[11px] text-graphite">
            Click a shape to comment · Esc to leave
          </div>
        )}
        {(loadState === "failed" || loadState === "removed") && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="hairline flex flex-col items-center gap-3 rounded-lg bg-ink-900 px-6 py-5 text-center">
              <span className="label-mono">
                {loadState === "removed" ? "scene gone" : "not loaded"}
              </span>
              <p className="text-sm text-chalk">
                {loadState === "removed"
                  ? "This scene was removed."
                  : "Couldn't load this scene."}
              </p>
              <p className="text-xs text-graphite">
                {loadState === "removed"
                  ? "The file is no longer in the vault, so nothing more is saved here."
                  : "Nothing is saved until it loads, so the file is untouched."}
              </p>
              {loadState === "failed" && (
                <button
                  onClick={retryLoad}
                  className="hairline rounded-md bg-ink-900 px-2.5 py-1 font-mono text-[11px] text-graphite transition-colors hover:text-chalk"
                >
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
        {loadState === "ready" && initial && (
          <Excalidraw
            theme="dark"
            initialData={{
              elements: initial.elements as any,
              appState: initial.appState,
              files: (initial.files ?? {}) as any,
              libraryItems: libraryItems as any,
              scrollToContent: initial.appState?.scrollX === undefined,
            }}
            onChange={onChange}
            onLibraryChange={onLibraryChange}
            excalidrawAPI={setApi}
            UIOptions={UI_OPTIONS as any}
            name={meta.name}
            libraryReturnUrl={`${window.location.origin}${window.location.pathname}?scene=${meta.id}`}
          >
            <Footer>
              <FontSize api={api} />
            </Footer>
            <MainMenu>
              <MainMenu.Item onSelect={leave}>All scenes</MainMenu.Item>
              <MainMenu.Item onSelect={onOpenSwitcher}>
                Jump to scene…
              </MainMenu.Item>
              <MainMenu.Separator />
              <MainMenu.Item onSelect={exportFile}>
                Export .excalidraw
              </MainMenu.Item>
              <MainMenu.DefaultItems.SaveAsImage />
              <MainMenu.DefaultItems.ChangeCanvasBackground />
              <MainMenu.Separator />
              <MainMenu.DefaultItems.ClearCanvas />
            </MainMenu>
          </Excalidraw>
        )}
      </div>

        {popover && (
          <CommentPopover
            element={popover.element}
            comments={comments.filter(
              (comment) => comment.elementId === popover.element.id,
            )}
            point={popover.point}
            onAdd={(body) => writeComment(body, popover.element)}
            onUpdate={changeComment}
            onOpenPanel={() => {
              setPanelElement(popover.element);
              setCommentsOpen(true);
              leaveCommentMode();
            }}
            onClose={() => setPopover(null)}
          />
        )}

        {commentsOpen && (
          <Comments
            element={panelTarget}
            comments={
              panelTarget
                ? comments.filter((comment) => comment.elementId === panelTarget.id)
                : []
            }
            sceneOpen={commentTotals.open}
            onAdd={(body) => writeComment(body, panelTarget)}
            onUpdate={changeComment}
            onClose={() => {
              setCommentsOpen(false);
              setPanelElement(null);
            }}
          />
        )}

        {historyOpen && (
          <History
            entries={snapshots}
            bytes={historyBytes}
            previewing={previewing}
            currentCount={liveCount}
            onPreview={preview}
            onKeep={keep}
            onDiscard={discard}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
