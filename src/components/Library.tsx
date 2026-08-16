import { useMemo, useRef, useState } from "react";
import SceneCard from "./SceneCard";
import { Wordmark } from "./Wordmark";
import {
  deleteScene,
  duplicateScene,
  importScene,
  renameScene,
  toggleStar,
} from "../lib/store";
import { plural } from "../lib/format";
import type { SceneMeta } from "../lib/types";

type Sort = "updated" | "created" | "name";

const SORTS: { key: Sort; label: string }[] = [
  { key: "updated", label: "Edited" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

type Props = {
  scenes: SceneMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRefresh: () => Promise<SceneMeta[]>;
  onOpenSwitcher: () => void;
};

export default function Library({
  scenes,
  onOpen,
  onNew,
  onRefresh,
  onOpenSwitcher,
}: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const fileInput = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? scenes.filter((scene) => scene.name.toLowerCase().includes(needle))
      : scenes;
    const sorted = [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return sorted.sort(
      (a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)),
    );
  }, [scenes, query, sort]);

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      try {
        const raw = JSON.parse(await file.text());
        await importScene(file.name.replace(/\.(excalidraw|json)$/i, ""), {
          elements: raw.elements ?? [],
          appState: { viewBackgroundColor: raw.appState?.viewBackgroundColor },
          files: raw.files ?? {},
        });
      } catch {
        // ignore files that aren't valid scenes
      }
    }
    await onRefresh();
    if (fileInput.current) fileInput.current.value = "";
  };

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag titlebar-inset hairline-b flex items-center gap-4 px-6 py-4">
        <Wordmark />
        <span className="label-mono hidden sm:inline">
          {plural(scenes.length, "scene")}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search scenes"
            className="hairline w-44 rounded-md bg-ink-900 px-3 py-1.5 text-sm text-chalk outline-none placeholder:text-graphite/70 focus:border-white/20 md:w-64"
          />
          <div className="hairline hidden rounded-md bg-ink-900 p-0.5 sm:flex">
            {SORTS.map((option) => (
              <button
                key={option.key}
                onClick={() => setSort(option.key)}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  sort === option.key
                    ? "bg-ink-700 text-chalk"
                    : "text-graphite hover:text-chalk"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            onClick={onOpenSwitcher}
            title="Jump to a scene (⌘K, or ⌥K)"
            className="hairline rounded-md bg-ink-900 px-3 py-1.5 text-sm text-graphite transition-colors hover:text-chalk"
          >
            Jump{" "}
            <span className="font-mono text-[11px] opacity-60">
              ⌘K
            </span>
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            className="hairline rounded-md bg-ink-900 px-3 py-1.5 text-sm text-graphite transition-colors hover:text-chalk"
          >
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".excalidraw,.json,application/json"
            multiple
            hidden
            onChange={(event) => onImport(event.target.files)}
          />
          <button
            onClick={onNew}
            className="rounded-md bg-chalk px-3 py-1.5 text-sm font-medium text-ink-950 transition-opacity hover:opacity-85"
          >
            New scene
          </button>
        </div>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-6 py-6">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-graphite">
              {scenes.length === 0
                ? "No scenes yet. The sketchdex is empty."
                : "Nothing matches that search."}
            </p>
            {scenes.length === 0 && (
              <button
                onClick={onNew}
                className="hairline rounded-md bg-ink-900 px-3 py-1.5 text-sm text-chalk hover:border-white/20"
              >
                Draw the first one
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
            {visible.map((scene) => (
              <SceneCard
                key={scene.id}
                meta={scene}
                onOpen={() => onOpen(scene.id)}
                onRename={async (name) => {
                  await renameScene(scene.id, name);
                  await onRefresh();
                }}
                onDuplicate={async () => {
                  await duplicateScene(scene.id);
                  await onRefresh();
                }}
                onDelete={async () => {
                  await deleteScene(scene.id);
                  await onRefresh();
                }}
                onToggleStar={async () => {
                  await toggleStar(scene.id);
                  await onRefresh();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
