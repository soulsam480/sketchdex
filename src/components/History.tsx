import type { Snapshot } from "../lib/store";

/**
 * The undo you get for changes Sketchdex did not make.
 *
 * Drawing by hand has Excalidraw's undo stack. An agent editing the vault does
 * not, so every agent write stashes the previous state and it shows up here,
 * newest first, until you say what should happen to it. Nothing expires on its
 * own: leave a stack of them sitting for a week and they will still be here.
 *
 * Keep is the deliberate end of a review - it makes that state the live one and
 * clears the rest, because once you have decided there is nothing left to hold.
 */

const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const day = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

type Props = {
  entries: Snapshot[];
  bytes: number;
  previewing: string | null;
  currentCount: number;
  onPreview: (snapId: string | null) => void;
  onKeep: (snapId: string | null) => void;
  onDiscard: (snapId: string) => void;
  onClose: () => void;
};

export default function History({
  entries,
  bytes,
  previewing,
  currentCount,
  onPreview,
  onKeep,
  onDiscard,
  onClose,
}: Props) {
  return (
    <aside className="hairline-l flex w-[292px] shrink-0 flex-col bg-ink-900">
      <header className="hairline-b flex items-center gap-2 px-3.5 py-2.5">
        <span className="label-mono">History</span>
        <span className="label-mono ml-auto normal-case">
          {entries.length ? `${entries.length} · ${size(bytes)}` : "empty"}
        </span>
        <button
          onClick={onClose}
          title="Close history"
          className="rounded px-1.5 py-0.5 text-xs text-graphite transition-colors hover:bg-ink-800 hover:text-chalk"
        >
          ✕
        </button>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <Row
          active={previewing === null}
          onClick={() => onPreview(null)}
          title="Now"
          subtitle={`${currentCount} item${currentCount === 1 ? "" : "s"} on the canvas`}
          badge="live"
          actions={
            entries.length ? (
              <Action
                title="Keep this and clear the history"
                onClick={() => onKeep(null)}
              >
                <CheckIcon />
              </Action>
            ) : null
          }
        />

        {entries.map((entry) => (
          <Row
            key={entry.id}
            active={previewing === entry.id}
            onClick={() => onPreview(entry.id)}
            title={`${time.format(entry.at)} · ${day.format(entry.at)}`}
            subtitle={entry.label}
            meta={`${entry.elementCount} item${
              entry.elementCount === 1 ? "" : "s"
            } · ${size(entry.bytes)}`}
            actions={
              <>
                <Action
                  title="Restore this state and clear the history"
                  onClick={() => onKeep(entry.id)}
                >
                  <CheckIcon />
                </Action>
                <Action title="Discard this snapshot" onClick={() => onDiscard(entry.id)}>
                  <CrossIcon />
                </Action>
              </>
            }
          />
        ))}

        {entries.length === 0 && (
          <p className="px-3.5 py-3 text-xs leading-relaxed text-graphite">
            Snapshots land here whenever something outside Sketchdex changes this
            scene. Your own drawing is covered by undo, so it is not recorded.
          </p>
        )}
      </div>

      {previewing !== null && (
        <div className="hairline-t flex items-center gap-2 px-3.5 py-2.5">
          <span className="label-mono normal-case text-violet">Previewing</span>
          <button
            onClick={() => onPreview(null)}
            className="ml-auto rounded-md bg-ink-800 px-2 py-1 text-xs text-chalk transition-opacity hover:opacity-80"
          >
            Back to now
          </button>
        </div>
      )}
    </aside>
  );
}

function Row({
  active,
  onClick,
  title,
  subtitle,
  meta,
  badge,
  actions,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle?: string;
  meta?: string;
  badge?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`group hairline-b flex items-start gap-2 px-3.5 py-2.5 transition-colors ${
        active ? "bg-ink-800" : "hover:bg-ink-850"
      }`}
    >
      <button onClick={onClick} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-xs text-chalk">{title}</span>
          {badge && <span className="label-mono text-violet">{badge}</span>}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-[11px] text-graphite">
            {subtitle}
          </span>
        )}
        {meta && (
          <span className="label-mono mt-1 block normal-case">{meta}</span>
        )}
      </button>
      {actions && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}

function Action({
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
      className="rounded px-1.5 py-1 text-graphite transition-colors hover:bg-ink-700 hover:text-chalk"
    >
      {children}
    </button>
  );
}

/** Inline so the panel needs no icon dependency, matching SceneCard's bin. */
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
