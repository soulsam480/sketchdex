import { useLayoutEffect, useRef, useState } from "react";

import type { Comment } from "../lib/store";
import { capitalise } from "../lib/format";
import CommentRow from "./CommentRow";

/**
 * The comment you get from clicking a shape while comment mode is on: a card at
 * the cursor, not a sidebar. It carries the same rows and the same write path as
 * the panel; the panel is one link away when the element has more history than
 * fits here.
 */
export default function CommentPopover({
  element,
  comments,
  point,
  onAdd,
  onUpdate,
  onOpenPanel,
  onClose,
}: {
  element: { id: string; type: string; text?: string };
  comments: Comment[];
  point: { x: number; y: number };
  onAdd: (body: string) => Promise<void>;
  onUpdate: (comment: Comment, action: "resolve" | "reopen" | "delete") => Promise<void>;
  onOpenPanel: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: point.x + 14, top: point.y + 10 });

  useLayoutEffect(() => {
    const node = card.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    // stay inside the canvas, not the window: a card that flips over the app
    // header or the toolbar reads as broken chrome
    const host = document
      .querySelector(".excalidraw-wrapper")
      ?.getBoundingClientRect();
    const left0 = point.x + 14;
    const left =
      left0 + box.width > window.innerWidth - 10
        ? Math.max(10, point.x - box.width - 14)
        : left0;
    const minTop = (host?.top ?? 0) + 8;
    const maxTop = (host?.bottom ?? window.innerHeight) - box.height - 8;
    const top = Math.min(
      Math.max(point.y - box.height / 2, minTop),
      Math.max(minTop, maxTop),
    );
    setAt({ left, top });
  }, [point.x, point.y, comments.length]);

  const open = comments.filter((comment) => comment.status === "open");
  const resolved = comments.filter((comment) => comment.status === "resolved");

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(body);
      setDraft("");
    } catch (err) {
      setError((err as Error).message || "Could not save the comment.");
    } finally {
      setBusy(false);
    }
  };

  const act = async (comment: Comment, action: "resolve" | "reopen" | "delete") => {
    setBusy(true);
    setError(null);
    try {
      await onUpdate(comment, action);
    } catch (err) {
      setError((err as Error).message || "Could not update the comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={card}
      data-comment-popover
      className="fixed z-50 flex w-[300px] flex-col overflow-hidden rounded-lg border border-white/10 bg-ink-900 shadow-2xl"
      style={{ left: at.left, top: at.top }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="hairline-b flex items-center gap-2 px-3 py-2">
        <span className="truncate text-xs text-chalk">
          {element.text?.trim() || capitalise(element.type)}
        </span>
        <span className="label-mono ml-auto shrink-0 normal-case">
          {open.length ? `${open.length} open` : "none open"}
        </span>
        <button
          onClick={onClose}
          title="Close"
          className="rounded px-1 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
        >
          ✕
        </button>
      </header>

      {(open.length > 0 || resolved.length > 0) && (
        <div className="scrollbar-thin max-h-[34vh] overflow-y-auto">
          {open.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              busy={busy}
              onUpdate={act}
            />
          ))}
          {resolved.length > 0 && (
            <div className="px-3 pb-1 pt-2">
              <span className="label-mono">resolved ({resolved.length})</span>
            </div>
          )}
          {resolved.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              busy={busy}
              onUpdate={act}
            />
          ))}
        </div>
      )}

      <form
        className="hairline-t px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Add a comment"
          className="w-full resize-none rounded-md bg-ink-800 px-2 py-1.5 text-xs leading-relaxed text-chalk outline-none placeholder:text-graphite/70"
        />
        {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
        <div className="mt-1.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenPanel}
            className="label-mono normal-case transition-colors hover:text-chalk"
          >
            All comments
          </button>
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            className="ml-auto rounded-md bg-violet px-2.5 py-1 text-[11px] text-white transition-opacity hover:opacity-85 disabled:opacity-35"
          >
            {busy ? "saving" : "Comment"}
          </button>
        </div>
      </form>
    </div>
  );
}
