import { useState } from "react";

import type { Comment } from "../lib/store";

/**
 * Comments on one element, opened from the scene header.
 *
 * Nothing is drawn on the canvas: a badge on every shape would turn a drawing
 * into a ticketing board. The panel follows the selection instead, reads the
 * comments that ride on that element, and writes through the agent surface so a
 * comment never races a geometry save.
 */

const capitalise = (value: string) =>
  value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;

const relative = (at: number) => {
  const delta = Date.now() - at;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
};

type Props = {
  element: { id: string; type: string; text?: string } | null;
  comments: Comment[];
  sceneOpen: number;
  onAdd: (body: string) => Promise<void>;
  onUpdate: (comment: Comment, action: "resolve" | "reopen" | "delete") => Promise<void>;
  onClose: () => void;
};

export default function Comments({
  element,
  comments,
  sceneOpen,
  onAdd,
  onUpdate,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <aside className="hairline-l flex w-[292px] shrink-0 flex-col bg-ink-900">
      <header className="hairline-b flex items-center gap-2 px-3.5 py-2.5">
        <span className="label-mono">Comments</span>
        <span className="label-mono ml-auto normal-case">
          {sceneOpen ? `${sceneOpen} open` : "none open"}
        </span>
        <button
          onClick={onClose}
          title="Close comments"
          className="rounded px-1.5 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
        >
          ✕
        </button>
      </header>

      {element === null ? (
        <p className="px-3.5 py-3 text-xs leading-relaxed text-graphite">
          Select one element to comment on it. Comments attach to the element
          itself, so they move, copy and undo with it.
        </p>
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
              <Row
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
              <Row
                key={comment.id}
                comment={comment}
                busy={busy}
                onUpdate={act}
              />
            ))}

            {comments.length === 0 && (
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
            {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
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

function Row({
  comment,
  busy,
  onUpdate,
}: {
  comment: Comment;
  busy: boolean;
  onUpdate: (comment: Comment, action: "resolve" | "reopen" | "delete") => void;
}) {
  const isAgent = comment.author.kind === "agent";
  return (
    <div className="group hairline-b px-3.5 py-2.5">
      <p
        className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${
          comment.status === "resolved" ? "text-graphite" : "text-chalk"
        }`}
      >
        {comment.body}
      </p>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-[10px] text-graphite">
          {comment.author.name}
          {isAgent ? " · agent" : ""} · {relative(comment.createdAt)}
        </span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            title={comment.status === "open" ? "Mark resolved" : "Reopen"}
            disabled={busy}
            onClick={() =>
              onUpdate(comment, comment.status === "open" ? "resolve" : "reopen")
            }
            className="rounded px-1.5 py-1 text-graphite transition-colors hover:bg-ink-700 hover:text-chalk disabled:opacity-30"
          >
            {comment.status === "open" ? <CheckIcon /> : <UndoIcon />}
          </button>
          <button
            title="Delete comment"
            disabled={busy}
            onClick={() => onUpdate(comment, "delete")}
            className="rounded px-1.5 py-1 text-graphite transition-colors hover:bg-ink-700 hover:text-chalk disabled:opacity-30"
          >
            <CrossIcon />
          </button>
        </span>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 5.5h4.5a2.5 2.5 0 010 5H5M4 5.5L6.5 3M4 5.5L6.5 8" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
    </svg>
  );
}
