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
import {
  clearHistory,
  clientId,
  discardSnapshot,
  isConflict,
  loadHistory,
  loadScene,
  onVaultEvent,
  readSnapshot,
  renameScene,
  restoreSnapshot,
  saveScene,
  saveThumb,
  slimAppState,
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
  const [editingName, setEditingName] = useState(false);
  const [api, setApi] = useState<any>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

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
  const setStatus = (text: "saving" | "saved" | "retrying" | "preview") => {
    if (statusRef.current) statusRef.current.textContent = text;
  };

  const latest = useRef<ScenePayload | null>(null);
  const timer = useRef<number | null>(null);
  const lastVersion = useRef(-1);
  /** Revision of the file this tab last loaded or wrote; saves are conditional on it. */
  const rev = useRef<string | null>(null);
  const lastThumbAt = useRef(0);
  const viewDirty = useRef(false);
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
    loadScene(meta.id).then((payload) => {
      if (!alive) return;
      const next = payload ?? { elements: [], appState: {}, files: {} };
      lastVersion.current = getSceneVersion(next.elements as any);
      rev.current = next.rev ?? null;
      setInitial(next);
    });
    return () => {
      alive = false;
    };
  }, [meta.id]);

  /** `immediate` means "we are leaving now": skip the thumbnail throttle and
   * refresh the library index. It never forces a write on its own. */
  const flush = useCallback(
    async (immediate = false) => {
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
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flushRef.current(), RETRY_DELAY);
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
    },
    [meta.id, onIndexChange],
  );

  // lets the retry timer inside flush call the latest flush without recursing
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  const mergeFromDiskRef = useRef<() => Promise<void>>(async () => {});

  const onChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      if (previewRef.current !== null) return;
      latest.current = {
        elements,
        appState: slimAppState(appState),
        files,
      };
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
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => flush(),
        version === lastVersion.current ? VIEW_DEBOUNCE : SAVE_DEBOUNCE,
      );
    },
    [flush],
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
    if (timer.current) window.clearTimeout(timer.current);
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
  }, [meta.id, paint, onIndexChange]);

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
    if (!disk || !local || previewRef.current !== null) return;
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
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flushRef.current(), SAVE_DEBOUNCE);
    setStatus("saving");
  }, [meta.id, api, paint]);
  useEffect(() => {
    mergeFromDiskRef.current = mergeFromDisk;
  }, [mergeFromDisk]);

  useEffect(
    () =>
      onVaultEvent((event) => {
        if (event.id !== meta.id) return;
        if (event.type === "history") {
          refreshHistory();
          return;
        }
        if (event.by === clientId) return; // our own save, echoed back
        adoptFromDisk();
        refreshHistory();
      }),
    [meta.id, adoptFromDisk, refreshHistory],
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
      // freeze saving before painting, or the swap saves itself over the file
      if (timer.current) window.clearTimeout(timer.current);
      previewRef.current = snapId;
      setPreviewing(snapId);
      setStatus("preview");
      const snap = await readSnapshot(meta.id, snapId).catch(() => null);
      if (snap) paint({ elements: snap.elements, appState: snap.appState, files: null });
    },
    [meta.id, paint],
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

  // save on unmount, tab hide, and window close
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      if (timer.current) window.clearTimeout(timer.current);
      flush(true);
    };
  }, [flush]);

  const leave = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    await flush(true);
    onBack();
  }, [flush, onBack]);

  // page order, oldest first, so ‹ › reads like leafing through a book and
  // never reshuffles as scenes get edited
  const ordered = [...scenes].sort((a, b) => a.createdAt - b.createdAt);
  const index = ordered.findIndex((scene) => scene.id === meta.id);
  const step = async (delta: number) => {
    const next = ordered[index + delta];
    if (!next) return;
    if (timer.current) window.clearTimeout(timer.current);
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
      <header className="app-drag titlebar-inset hairline-b flex items-center gap-3 px-4 py-2.5">
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
            onClick={() => setHistoryOpen((open) => !open)}
            title="Snapshots taken before changes made outside Sketchdex"
            className={`hairline ml-2 flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors ${
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
        className="excalidraw-wrapper min-w-0 flex-1"
        onPointerDownCapture={markInteracted}
        onWheelCapture={markInteracted}
        onKeyDownCapture={markInteracted}
      >
        {initial && (
          <Excalidraw
            theme="dark"
            initialData={{
              elements: initial.elements as any,
              appState: initial.appState,
              files: (initial.files ?? {}) as any,
              scrollToContent: initial.appState?.scrollX === undefined,
            }}
            onChange={onChange}
            excalidrawAPI={setApi}
            UIOptions={UI_OPTIONS as any}
            name={meta.name}
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
