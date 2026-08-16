import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/format";
import type { SceneMeta } from "../lib/types";

type Props = {
  scenes: SceneMeta[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
};

export default function Switcher({
  scenes,
  activeId,
  onOpen,
  onNew,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? scenes.filter((scene) => scene.name.toLowerCase().includes(needle))
      : [...scenes].sort((a, b) => b.updatedAt - a.updatedAt);
    return list.slice(0, 40);
  }, [scenes, query]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setCursor((prev) => Math.min(prev + 1, results.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((prev) => Math.max(prev - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const target = results[cursor];
        if (target) onOpen(target.id);
        else if (query.trim()) onNew();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [results, cursor, query, onOpen, onNew, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="hairline w-[min(560px,92vw)] overflow-hidden rounded-xl bg-ink-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Jump to a scene"
          className="hairline-b w-full bg-transparent px-4 py-3.5 text-sm text-chalk outline-none placeholder:text-graphite/70"
        />

        <div className="scrollbar-thin max-h-[46vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <button
              onClick={onNew}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-graphite hover:bg-ink-800 hover:text-chalk"
            >
              New scene {query.trim() && <span>· “{query.trim()}”</span>}
            </button>
          ) : (
            results.map((scene, i) => (
              <button
                key={scene.id}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onOpen(scene.id)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left ${
                  i === cursor ? "bg-ink-800" : ""
                }`}
              >
                <span className="w-3 shrink-0 text-center text-xs text-violet">
                  {scene.id === activeId ? "•" : ""}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-chalk">
                  {scene.name}
                </span>
                <span className="label-mono shrink-0 normal-case">
                  {relativeTime(scene.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="hairline-t flex items-center gap-4 px-4 py-2">
          <span className="label-mono">↑↓ move</span>
          <span className="label-mono">↵ open</span>
          <span className="label-mono">esc close</span>
        </div>
      </div>
    </div>
  );
}
