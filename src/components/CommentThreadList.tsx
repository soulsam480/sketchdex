import { useEffect, useRef, useState } from "react";

import { filterThreads, type Thread, type ThreadFilter } from "../lib/commentThreads";
import { relativeTime } from "../lib/format";

type Props = {
  threads: Thread[];
  filter: ThreadFilter;
  query: string;
  counts: Record<ThreadFilter, number>;
  activeElementId: string | null;
  truncated: boolean;
  onFilter: (f: ThreadFilter) => void;
  onQuery: (q: string) => void;
  onSelect: (elementId: string) => void;
  onCommentMode: () => void;
};

const FILTERS: ThreadFilter[] = ["all", "open", "resolved"];

export default function CommentThreadList({
  threads,
  filter,
  query,
  counts,
  activeElementId,
  truncated,
  onFilter,
  onQuery,
  onSelect,
  onCommentMode,
}: Props) {
  const rows = filterThreads(threads, filter, query);
  const [cursor, setCursor] = useState(-1);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => setCursor(-1), [filter, query]);

  const initialIndex = useRef(
    activeElementId
      ? rows.findIndex((thread) => thread.elementId === activeElementId)
      : -1,
  );
  useEffect(() => {
    if (initialIndex.current < 0) return;
    setCursor(initialIndex.current);
    rowRefs.current[initialIndex.current]?.focus();
  }, []);

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setCursor(next);
    rowRefs.current[next]?.focus();
  };

  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(rows.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onSelect(rows[index].elementId);
    }
  };

  return (
    <>
      <div className="hairline-b px-3.5 py-2">
        <div className="flex items-center gap-1">
          {FILTERS.map((item) => (
            <button
              key={item}
              onClick={() => onFilter(item)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                filter === item
                  ? "bg-ink-800 text-chalk"
                  : "text-graphite hover:text-chalk"
              }`}
            >
              {item} {counts[item]}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter comments"
          aria-label="Filter comments"
          className="mt-2 w-full rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk outline-none placeholder:text-graphite/70"
        />
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        {rows.map((thread, index) => {
          const active = thread.elementId === activeElementId || cursor === index;
          return (
            <button
              key={thread.elementId}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              onClick={() => onSelect(thread.elementId)}
              onKeyDown={(event) => rowKey(event, index)}
              tabIndex={cursor === index || (cursor === -1 && index === 0) ? 0 : -1}
              className={`group hairline-b block w-full px-3.5 py-2.5 text-left transition-colors ${
                active ? "bg-ink-800" : "hover:bg-ink-850"
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="label-mono">{thread.elementType}</span>
                <span className="label-mono ml-auto normal-case">
                  {thread.status === "open"
                    ? `${thread.openCount} open`
                    : "resolved"}
                </span>
              </span>
              <span className="mt-1 block truncate text-xs text-chalk">
                {thread.name}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-graphite">
                {thread.snippet}
              </span>
              <span className="mt-1 flex items-center gap-1.5 text-[10px] text-graphite">
                {thread.authorName}
                {thread.authorKind === "agent" ? " · agent" : ""}
                {" · "}
                {relativeTime(thread.createdAt)}
                <span className="ml-auto font-mono">{thread.count}</span>
              </span>
            </button>
          );
        })}

        {threads.length === 0 && (
          <div className="px-3.5 py-3">
            <p className="text-xs leading-relaxed text-graphite">
              No comments in this scene yet.
            </p>
            <button
              onClick={onCommentMode}
              className="mt-2 rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk transition-opacity hover:opacity-80"
            >
              Comment on canvas
            </button>
          </div>
        )}

        {threads.length > 0 && rows.length === 0 && (
          <div className="px-3.5 py-3">
            <p className="text-xs leading-relaxed text-graphite">No comments match.</p>
            <button
              onClick={() => {
                onFilter("all");
                onQuery("");
              }}
              className="mt-2 rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk transition-opacity hover:opacity-80"
            >
              Clear filter
            </button>
          </div>
        )}

        {truncated && (
          <p className="hairline-t px-3.5 py-2 text-[11px] text-graphite">
            Showing the first 500 comments.
          </p>
        )}
      </div>
    </>
  );
}
