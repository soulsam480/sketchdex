import { useEffect, useState } from "react";

/**
 * Name-then-create, opened with ⌥N. Same shape as the ⌘K switcher so the two
 * read as one family: type, press enter, you are in the scene.
 */
export default function NewScene({
  initialName = "",
  onClose,
  onCreate,
}: {
  /** Prefilled from the switcher query, so the typed name is not typed twice. */
  initialName?: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // an empty name is fine, and matches what the New scene button does
      await onCreate(name.trim() || "Untitled");
    } catch (err) {
      // the modal stays up with the reason, and the button comes back so the
      // same name can be tried again once the vault answers
      setError(err instanceof Error ? err.message : "Couldn't create the scene.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="hairline w-[min(460px,92vw)] overflow-hidden rounded-xl bg-ink-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
          placeholder="Name your scene"
          spellCheck={false}
          className="hairline-b w-full bg-transparent px-4 py-3.5 text-sm text-chalk outline-none placeholder:text-graphite/70"
        />

        {error && (
          <p className="hairline-b px-4 py-2 text-xs text-[var(--sd-error)]">{error}</p>
        )}

        <div className="hairline-t flex items-center justify-between gap-4 px-4 py-2">
          <div className="flex items-center gap-4">
            <span className="label-mono">↵ create</span>
            <span className="label-mono">esc cancel</span>
          </div>
          <button
            onClick={create}
            disabled={busy}
            className="rounded-md bg-chalk px-2.5 py-1 text-xs font-medium text-ink-950 transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create scene"}
          </button>
        </div>
      </div>
    </div>
  );
}
