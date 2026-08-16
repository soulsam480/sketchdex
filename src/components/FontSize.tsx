import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";

/**
 * Numeric font size.
 *
 * Excalidraw only ships S/M/L/XL (16/20/28/36) and exposes no API for a custom
 * size, so this sets `currentItemFontSize` for new text and rewrites the size
 * on any selected text element.
 *
 * Resizing a text element means its box has to change too, and the package's
 * own `redrawTextBoundingBox` is types-only at runtime. It isn't needed:
 * glyph metrics scale linearly with font size, so scaling width and height by
 * the same ratio is exact for already-wrapped text - no measuring, no drift.
 * Text bound to a container is left to the container to re-wrap.
 *
 * Only shown when it can do anything: a text element is selected, or the text
 * tool is armed so the size applies to whatever gets typed next.
 */

const MIN = 8;
const MAX = 400;
const PRESETS = [16, 20, 28, 36, 48, 64, 96];

type Api = {
  getSceneElements: () => readonly any[];
  getAppState: () => any;
  updateScene: (data: any) => void;
} | null;

export function FontSize({ api }: { api: Api }) {
  const [value, setValue] = useState(20);
  const [draft, setDraft] = useState("20");
  const [open, setOpen] = useState(false);
  const [relevant, setRelevant] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * "px" sits inside the field so the box reads as one value, but it is not
   * editable - clicking it (or the padding) drops the caret at the end of the
   * number instead of stranding it after the unit.
   */
  const focusNumber = (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest(".sd-fontsize__caret")) return;
    if (target === inputRef.current) return;
    event.preventDefault();
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  // follow the selection, so the field always shows what is actually selected
  useEffect(() => {
    if (!api) return;
    const sync = () => {
      // never while the field has focus, or the poll overwrites what is being
      // typed the moment the user pauses between keystrokes
      if (document.activeElement === inputRef.current) return;
      const state = api.getAppState();
      const selected = api
        .getSceneElements()
        .filter(
          (el: any) =>
            state.selectedElementIds?.[el.id] && el.type === "text" && !el.isDeleted,
        );
      const armed = state.activeTool?.type === "text";
      setRelevant(selected.length > 0 || armed);
      const next = selected.length
        ? Math.round(selected[0].fontSize)
        : Math.round(state.currentItemFontSize ?? 20);
      setValue(next);
      setDraft(String(next));
    };
    sync();
    const timer = setInterval(sync, 250);
    return () => clearInterval(timer);
  }, [api]);

  const apply = useCallback(
    (raw: number) => {
      if (!api || !Number.isFinite(raw)) return;
      const size = Math.min(MAX, Math.max(MIN, Math.round(raw)));
      const state = api.getAppState();
      const selectedIds = state.selectedElementIds ?? {};

      const elements = api.getSceneElements().map((el: any) => {
        if (!selectedIds[el.id] || el.type !== "text" || el.isDeleted) return el;
        const ratio = size / el.fontSize;
        return {
          ...el,
          fontSize: size,
          // linear in font size, so this is exact rather than an estimate
          width: el.containerId ? el.width : el.width * ratio,
          height: el.height * ratio,
          version: el.version + 1,
          versionNonce: Math.floor(Math.random() * 2 ** 31),
        };
      });

      api.updateScene({
        elements,
        appState: { currentItemFontSize: size },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      setValue(size);
      setDraft(String(size));
      setOpen(false);
    },
    [api],
  );

  useEffect(() => {
    if (!relevant) setOpen(false);
  }, [relevant]);

  if (!relevant) return null;

  const commitDraft = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed > 0) apply(parsed);
    else setDraft(String(value));
  };

  return (
    <div className="sd-fontsize" title="Font size">
      <span className="sd-fontsize__icon" aria-hidden="true">
        A
      </span>
      <button
        type="button"
        className="sd-fontsize__step"
        title="Smaller"
        onClick={() => apply(value - (value > 36 ? 4 : 2))}
      >
        −
      </button>

      <div className="sd-fontsize__field" onMouseDown={focusNumber}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitDraft();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") setDraft(String(value));
            // arrows nudge the size instead of escaping to the canvas
            if (event.key === "ArrowUp") {
              event.preventDefault();
              apply(value + 1);
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              apply(value - 1);
            }
          }}
          inputMode="numeric"
          aria-label="Font size in pixels"
        />
        <span className="sd-fontsize__unit">px</span>
        <button
          type="button"
          className="sd-fontsize__caret"
          title="Preset sizes"
          onClick={() => setOpen((prev) => !prev)}
        >
          ▾
        </button>
        {open && (
          <>
            <div className="sd-fontsize__scrim" onClick={() => setOpen(false)} />
            <div className="sd-fontsize__menu">
              {PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={preset === value ? "is-active" : ""}
                  onClick={() => apply(preset)}
                >
                  {preset}px
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        className="sd-fontsize__step"
        title="Larger"
        onClick={() => apply(value + (value >= 36 ? 4 : 2))}
      >
        +
      </button>
    </div>
  );
}
