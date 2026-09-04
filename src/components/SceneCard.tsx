import { useEffect, useRef, useState } from "react";
import { loadScene, loadThumb, saveThumb } from "../lib/store";
import { renderThumbnail, svgToDataUrl } from "../lib/thumbnail";
import { plural, relativeTime } from "../lib/format";
import type { SceneMeta } from "../lib/types";

type Props = {
  meta: SceneMeta;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleStar: () => void;
};

export default function SceneCard({
  meta,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onToggleStar,
}: Props) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const svg = await loadThumb(meta.id);
      if (alive) setThumb(svg ? svgToDataUrl(svg) : null);
      /**
       * Previews are drawn by whichever tab last saved the scene. A scene that
       * changed while no tab had it open - an agent write, a paper change - is
       * newer than its preview, so redraw it here. Only this card pays, only
       * once, and the result is stored for every card after it.
       */
      const stale = !svg || !meta.thumbAt || meta.thumbAt < meta.updatedAt;
      if (!stale) return;
      const payload = await loadScene(meta.id);
      if (!payload || !alive) return;
      const fresh = await renderThumbnail(payload);
      if (!fresh) return;
      await saveThumb(meta.id, fresh).catch(() => {});
      if (alive) setThumb(svgToDataUrl(fresh));
    })();
    return () => {
      alive = false;
    };
    // updatedAt in deps so the preview refreshes after an edit
  }, [meta.id, meta.updatedAt, meta.thumbAt]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  return (
    <div className="group hairline relative overflow-hidden rounded-lg bg-ink-900 transition-colors hover:border-white/20">
      <button
        onClick={onOpen}
        className="relative block aspect-[4/3] w-full overflow-hidden bg-ink-850"
        aria-label={`Open ${meta.name}`}
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            className="h-full w-full object-contain p-2"
            draggable={false}
          />
        ) : (
          <span className="label-mono absolute inset-0 flex items-center justify-center">
            blank
          </span>
        )}
      </button>
      {/* a sibling of the open button, laid over its corner: a button inside
          a button is invalid markup and unreachable from the keyboard */}
      <button
        type="button"
        onClick={onToggleStar}
        aria-label={meta.starred ? "Unpin" : "Pin"}
        title={meta.starred ? "Unpin" : "Pin"}
        className={`absolute top-2 right-2 rounded p-1 text-xs leading-none transition-opacity focus-visible:opacity-100 ${
          meta.starred
            ? "text-violet opacity-100"
            : "text-graphite opacity-0 group-hover:opacity-100 hover:text-chalk"
        }`}
      >
        {meta.starred ? "★" : "☆"}
      </button>

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              defaultValue={meta.name}
              onBlur={(event) => {
                onRename(event.target.value);
                setEditing(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setEditing(false);
              }}
              className="w-full rounded bg-ink-800 px-1.5 py-0.5 text-sm text-chalk outline-none"
            />
          ) : (
            <p
              onDoubleClick={() => setEditing(true)}
              title={meta.name}
              className="truncate text-sm text-chalk"
            >
              {meta.name}
            </p>
          )}
          <p className="label-mono mt-1 normal-case">
            {relativeTime(meta.updatedAt)} · {plural(meta.elementCount, "item")}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton title="Rename" onClick={() => setEditing(true)}>
            ✎
          </IconButton>
          <IconButton title="Duplicate" onClick={onDuplicate}>
            ⧉
          </IconButton>
          {confirming ? (
            <button
              onClick={onDelete}
              className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-500/25"
            >
              sure?
            </button>
          ) : (
            <IconButton title="Delete" onClick={() => setConfirming(true)}>
              <TrashIcon />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline so the card needs no icon dependency, and renders identically everywhere. */
function TrashIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 3.5h10" />
      <path d="M5.5 3.5V2.4a.9.9 0 0 1 .9-.9h1.2a.9.9 0 0 1 .9.9V3.5" />
      <path d="M3.4 3.5l.5 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.5-8" />
      <path d="M6 6v4M8 6v4" />
    </svg>
  );
}

function IconButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
    >
      {children}
    </button>
  );
}
