import { useEffect } from "react";

/**
 * Toolbar retune.
 *
 * Excalidraw ships fixed number shortcuts and a fixed tool order, and the
 * package exposes no API for either (UIOptions.tools only toggles image on or
 * off). But the toolbar is a grid of labelled radios and the imperative API can
 * set the active tool, so the order is re-sequenced in CSS (see index.css) and
 * the digits are re-bound here.
 *
 * Select keeps slot 1 and hand takes 2, which shifts every shape along by one
 * and lands text on 9 with eraser still on 0. Image keeps no digit at all.
 */
export const TOOL_KEYS: Record<string, string> = {
  "1": "selection",
  "2": "hand",
  "3": "rectangle",
  "4": "diamond",
  "5": "ellipse",
  "6": "arrow",
  "7": "line",
  "8": "freedraw",
  "9": "text",
  "0": "eraser",
};

type ToolSetter = { setActiveTool: (tool: { type: string }) => void } | null;

/** Typing anywhere means the digit is content, not a shortcut. */
const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

export function useToolShortcuts(api: ToolSetter) {
  useEffect(() => {
    if (!api) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isTyping()) return;

      const tool = TOOL_KEYS[event.key];
      if (!tool) return;

      // capture phase on window runs before Excalidraw's own container
      // listener, so stopping here is what keeps the native digit from
      // also firing and selecting the wrong tool
      event.preventDefault();
      event.stopPropagation();
      api.setActiveTool({ type: tool });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [api]);
}
