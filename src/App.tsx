import { useCallback, useEffect, useRef, useState } from "react";
import Library from "./components/Library";
import Editor from "./components/Editor";
import Switcher from "./components/Switcher";
import NewScene from "./components/NewScene";
import {
  createScene,
  installLibrary,
  loadIndex,
  onStorageStatus,
  onVaultEvent,
} from "./lib/store";
import { migrateLegacyScenes } from "./lib/migrate";
import { useTheme } from "./lib/theme";
import type { SceneMeta } from "./lib/types";

const routeFromLocation = () => {
  const match = window.location.hash.match(/^#\/s\/(.+)$/);
  return match ? match[1] : null;
};

export default function App() {
  const { theme } = useTheme();
  const scenesRef = useRef<SceneMeta[]>([]);
  const [scenes, setScenes] = useState<SceneMeta[]>([]);
  const [ready, setReady] = useState(false);
  const [openId, setOpenId] = useState<string | null>(routeFromLocation);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  /** What the New scene modal opens with; the switcher hands its query over. */
  const [newName, setNewName] = useState("");
  const [vaultDown, setVaultDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const installStarted = useRef(false);

  const refresh = useCallback(async () => {
    const list = await loadIndex().catch(() => scenesRef.current);
    scenesRef.current = list;
    setScenes(list);
    return list;
  }, []);

  useEffect(() => {
    migrateLegacyScenes()
      .catch(() => 0)
      .then(refresh)
      .catch(() => [])
      .finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => onStorageStatus(setVaultDown), []);

  /**
   * An agent adding or changing a scene should show up in the library without a
   * reload. The editor handles its own open scene; this keeps the index honest.
   */
  useEffect(
    () =>
      onVaultEvent((event) => {
        // a removed file drops its card the same way a new one gains it
        if (event.type === "scene" || event.type === "removed") refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    const onPop = () => setOpenId(routeFromLocation());
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onPop);
    };
  }, []);

  const open = useCallback((id: string | null) => {
    const url = id ? `#/s/${id}` : window.location.pathname;
    window.history.pushState(null, "", url);
    setOpenId(id);
    setSwitcherOpen(false);
  }, []);

  useEffect(() => {
    if (installStarted.current) return;
    installStarted.current = true;
    const query = new URLSearchParams(window.location.search);
    const library =
      new URLSearchParams(window.location.hash.slice(1)).get("addLibrary") ??
      query.get("addLibrary");
    if (!library) return;
    const scene = query.get("scene");
    window.history.replaceState(
      null,
      "",
      scene ? `#/s/${scene}` : window.location.pathname,
    );
    setNotice("Installing library...");
    installLibrary(library)
      .then((result) => {
        setNotice(
          result.added === 0
            ? `Already installed from ${result.name}`
            : `Added ${result.added} items from ${result.name}`,
        );
        if (scene) open(scene);
      })
      .catch((err) => {
        const body = (err as { body?: { error?: string } })?.body;
        setNotice(body?.error ?? (err instanceof Error ? err.message : String(err)));
      });
  }, [open]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const createNamed = useCallback(
    async (name: string) => {
      let meta: SceneMeta;
      try {
        meta = await createScene(name, theme === "light" ? "#ffffff" : "#121212");
      } catch (err) {
        // rethrown with a reason the modal can show; without this the
        // failure was an unhandled rejection and a button stuck on Creating
        const status = (err as { status?: number })?.status;
        throw new Error(
          status && status < 500
            ? `The vault refused to create the scene (${status}).`
            : "Vault unreachable. Check that the sketchdex server is running.",
        );
      }
      await refresh();
      setNewOpen(false);
      open(meta.id);
    },
    [open, refresh, theme],
  );

  const promptNewScene = useCallback((name = "") => {
    setSwitcherOpen(false);
    setNewName(name);
    setNewOpen(true);
  }, []);

  useEffect(() => {
    // event.code, not event.key: survives layouts and Option-modified chars
    const isSwitcherKey = (event: KeyboardEvent) =>
      event.code === "KeyK" &&
      (event.metaKey || event.ctrlKey || event.altKey);

    /**
     * New scene on ⌥N only. ⌘N is a Chrome accelerator ("New Window") handled
     * in the browser process, so it never reaches the page and cannot be
     * preventDefault-ed - binding it just meant a shortcut that looked
     * available and silently did nothing.
     */
    const isNewKey = (event: KeyboardEvent) =>
      event.code === "KeyN" && event.altKey && !event.shiftKey && !event.metaKey;

    const handledAt = { current: 0 };
    const newHandledAt = { current: 0 };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isNewKey(event)) {
        newHandledAt.current = Date.now();
        event.preventDefault();
        event.stopPropagation();
        setNewName("");
        setNewOpen(true);
        return;
      }
      if (!isSwitcherKey(event)) return;
      handledAt.current = Date.now();
      event.preventDefault();
      event.stopPropagation();
      setSwitcherOpen((prev) => !prev);
    };

    /**
     * Extensions that claim ⌘K (Grammarly, AI sidebars, Raycast Companion)
     * install a document_start capture listener and kill the keydown before
     * any page code runs. They almost never touch keyup, so this catches the
     * shortcut anyway. Skipped when the keydown already came through.
     */
    const onKeyUp = (event: KeyboardEvent) => {
      if (isNewKey(event)) {
        if (Date.now() - newHandledAt.current < 2000) return;
        event.preventDefault();
        event.stopPropagation();
        setNewName("");
        setNewOpen(true);
        return;
      }
      if (!isSwitcherKey(event)) return;
      if (Date.now() - handledAt.current < 2000) return;
      event.preventDefault();
      event.stopPropagation();
      setSwitcherOpen((prev) => !prev);
    };

    // capture phase so Excalidraw's own shortcut handling doesn't swallow it
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);

  const active = openId
    ? (scenes.find((scene) => scene.id === openId) ?? null)
    : null;

  useEffect(() => {
    // scene id in the URL no longer exists (deleted, or another browser)
    if (ready && openId && !active) {
      window.history.replaceState(null, "", window.location.pathname);
      setOpenId(null);
    }
  }, [ready, openId, active]);

  if (!ready) {
    return <div className="h-full bg-ink-950" />;
  }

  return (
    <div className="h-full bg-ink-950">
      {active ? (
        <Editor
          key={active.id}
          meta={active}
          scenes={scenes}
          onBack={() => open(null)}
          onOpen={open}
          onIndexChange={refresh}
          onOpenSwitcher={() => setSwitcherOpen(true)}
        />
      ) : (
        <Library
          scenes={scenes}
          onOpen={open}
          onRefresh={refresh}
          onNew={() => promptNewScene()}
          onOpenSwitcher={() => setSwitcherOpen(true)}
        />
      )}

      {vaultDown && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="hairline flex items-center gap-2 rounded-lg bg-ink-900 px-3.5 py-2 text-xs text-chalk shadow-xl">
            <span className="size-1.5 rounded-full bg-[var(--sd-error)]" />
            Vault unreachable. Edits are held and retried, not saved. Check that
            the sketchdex server is running.
          </div>
        </div>
      )}

      {notice && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-ink-700 bg-ink-800/95 px-3 py-1 text-[11px] text-graphite">
          {notice}
        </div>
      )}

      {newOpen && (
        <NewScene
          initialName={newName}
          onClose={() => setNewOpen(false)}
          onCreate={createNamed}
        />
      )}

      {switcherOpen && (
        <Switcher
          scenes={scenes}
          activeId={openId}
          onClose={() => setSwitcherOpen(false)}
          onOpen={open}
          onNew={promptNewScene}
        />
      )}
    </div>
  );
}
