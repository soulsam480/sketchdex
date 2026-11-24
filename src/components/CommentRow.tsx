import type { Comment } from "../lib/store";
import { relativeTime } from "../lib/format";

/** One comment, in the panel and in the canvas popover. */
export default function CommentRow({
  comment,
  busy,
  onUpdate,
}: {
  comment: Comment;
  busy: boolean;
  onUpdate: (comment: Comment, action: "resolve" | "reopen" | "delete") => void;
}) {
  return (
    <div className="group hairline-b px-3 py-2.5">
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
          {comment.author.kind === "agent" ? " · agent" : ""} ·{" "}
          {relativeTime(comment.createdAt)}
        </span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
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
