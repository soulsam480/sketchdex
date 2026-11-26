import { useEffect, useState } from "react";

import type { Comment } from "../lib/store";
import { capitalise } from "../lib/format";
import type { Thread, ThreadFilter } from "../lib/commentThreads";
import CommentRow from "./CommentRow";
import CommentThreadList from "./CommentThreadList";

/**
 * The scene-wide comment browser and the thread for one element share an aside.
 *
 * The list is the front door. A row opens the existing per-element thread, and
 * Back returns to the list without closing the panel, so a filter survives the
 * round trip. Nothing is drawn on the canvas: comments attach to the element
 * itself and every write goes through the agent surface, never a canvas save.
 */

type Props = {
  view: "list" | "detail";
  element: { id: string; type: string; text?: string } | null;
  comments: Comment[];
  sceneOpen: number;
  threads: Thread[];
  counts: Record<ThreadFilter, number>;
  filter: ThreadFilter;
  query: string;
  truncated: boolean;
  activeElementId: string | null;
  status: "loading" | "ready" | "error";
  onRetry: () => void;
  onFilter: (f: ThreadFilter) => void;
  onQuery: (q: string) => void;
  onSelectThread: (elementId: string) => void;
  onBack: () => void;
  onCommentMode: () => void;
  onAdd: (body: string) => Promise<void>;
  onUpdate: (comment: Comment, action: "resolve" | "reopen" | "delete") => Promise<void>;
  onClose: () => void;
};

export default function Comments({
  view,
  element,
  comments,
  sceneOpen,
  threads,
  counts,
  filter,
  query,
  truncated,
  activeElementId,
  status,
  onRetry,
  onFilter,
  onQuery,
  onSelectThread,
  onBack,
  onCommentMode,
  onAdd,
  onUpdate,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Editor keeps the panel and comment mode exclusive, so this listener is the
   * only one mounted while the panel is up. Detail backs out first; the list
   * closes the panel.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (view === "detail") onBack();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onBack, onClose]);

  const detailComments = element
    ? comments.filter((comment) => comment.elementId === element.id)
    : [];
  const open = detailComments.filter((comment) => comment.status === "open");
  const resolved = detailComments.filter((comment) => comment.status === "resolved");

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
    <aside className="hairline-l flex w-[292px] shrink-0 flex-col bg-ink-900">
      <header className="hairline-b flex items-center gap-2 px-3.5 py-2.5">
        {view === "detail" && (
          <button
            onClick={onBack}
            title="All comments"
            aria-label="All comments"
            className="rounded px-1 py-0.5 text-sm leading-none text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
          >
            ‹
          </button>
        )}
        <span className="label-mono">
          {view === "detail" ? "All comments" : "Comments"}
        </span>
        <span className="label-mono ml-auto normal-case">
          {sceneOpen ? `${sceneOpen} open` : "none open"}
        </span>
        <button
          onClick={onCommentMode}
          title="Comment on canvas"
          aria-label="Comment on canvas"
          className="rounded px-1.5 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
        >
          ✎
        </button>
        <button
          onClick={onClose}
          title="Close comments"
          className="rounded px-1.5 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
        >
          ✕
        </button>
      </header>

      {status === "loading" ? (
        <p className="px-3.5 py-3 text-xs leading-relaxed text-graphite">
          Loading comments
        </p>
      ) : status === "error" ? (
        <div className="px-3.5 py-3">
          <p className="text-xs leading-relaxed text-graphite">
            Could not load comments.
          </p>
          <button
            onClick={onRetry}
            className="mt-2 rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk transition-opacity hover:opacity-80"
          >
            Retry
          </button>
        </div>
      ) : view === "list" ? (
        <CommentThreadList
          threads={threads}
          filter={filter}
          query={query}
          counts={counts}
          activeElementId={activeElementId}
          truncated={truncated}
          onFilter={onFilter}
          onQuery={onQuery}
          onSelect={onSelectThread}
          onCommentMode={onCommentMode}
        />
      ) : element === null ? (
        <div className="px-3.5 py-3">
          <p className="text-xs leading-relaxed text-graphite">
            This element is no longer in the scene.
          </p>
          <button
            onClick={onBack}
            className="mt-2 rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk transition-opacity hover:opacity-80"
          >
            All comments
          </button>
        </div>
      ) : (
        <>
          <div className="hairline-b px-3.5 py-2">
            <div className="truncate text-xs text-chalk">
              {element.text?.trim() || capitalise(element.type)}
            </div>
            {element.text?.trim() ? (
              <span className="label-mono">{element.type}</span>
            ) : null}
          </div>

          <div className="scrollbar-thin flex-1 overflow-y-auto">
            {open.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                busy={busy}
                onUpdate={act}
              />
            ))}

            {resolved.length > 0 && (
              <div className="px-3.5 pb-1 pt-3">
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

            {detailComments.length === 0 && (
              <p className="px-3.5 py-3 text-xs leading-relaxed text-graphite">
                No comments on this element yet.
              </p>
            )}
          </div>

          <form
            className="hairline-t px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder="Add a comment"
              className="w-full resize-none rounded-md bg-ink-800 px-2 py-1.5 text-xs leading-relaxed text-chalk outline-none placeholder:text-graphite/70"
            />
            {error && <p className="mt-1 text-[11px] text-[var(--sd-error)]">{error}</p>}
            <div className="mt-1.5 flex items-center gap-2">
              <span className="label-mono normal-case">⌘↵ sends</span>
              <button
                type="submit"
                disabled={busy || draft.trim().length === 0}
                className="ml-auto rounded-md bg-violet px-2.5 py-1 text-[11px] text-white transition-opacity hover:opacity-85 disabled:opacity-35"
              >
                {busy ? "saving" : "Comment"}
              </button>
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
