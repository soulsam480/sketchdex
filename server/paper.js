/**
 * Paper and ink.
 *
 * A scene's background is real data - `viewBackgroundColor` in the file - and
 * so is every colour drawn on it. Nothing is ever inverted for display: the
 * canvas shows the hexes as they are (see the theme-filter override in
 * src/index.css). So "dark mode" is not a view setting here, it is a property
 * of the drawing: dark paper, light ink, in the data.
 *
 * New scenes get dark paper. Anything drawn without an explicit strokeColor
 * gets ink that contrasts with whatever paper the scene actually has, so an
 * agent that just says `{type:"text", text:"hi"}` is legible on either.
 */

export const DARK_PAPER = "#121212";
export const LIGHT_PAPER = "#ffffff";
export const DEFAULT_PAPER = DARK_PAPER;

export const INK_ON_DARK = "#e9ecef";
export const INK_ON_LIGHT = "#1e1e1e";

const channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16) / 255;

/** Relative luminance, 0 black to 1 white. Non-hex or transparent reads as light. */
export const luminance = (color) => {
  const hex = String(color ?? "").trim().toLowerCase();
  const long = /^#[0-9a-f]{6}$/.test(hex)
    ? hex
    : /^#[0-9a-f]{3}$/.test(hex)
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : null;
  if (!long) return 1;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(channel(long, 1)) + 0.7152 * lin(channel(long, 3)) + 0.0722 * lin(channel(long, 5));
};

export const isDarkPaper = (color) => luminance(color) < 0.4;

/** The default ink for a given paper colour. */
export const inkFor = (paper) => (isDarkPaper(paper) ? INK_ON_DARK : INK_ON_LIGHT);

/** The paper of a scene payload, falling back to what Excalidraw assumes. */
export const paperOf = (payload) => payload?.appState?.viewBackgroundColor ?? LIGHT_PAPER;

/** appState for a fresh scene: paper plus a matching pen for hand drawing. */
export const freshAppState = (paper = DEFAULT_PAPER) => ({
  viewBackgroundColor: paper,
  currentItemStrokeColor: inkFor(paper),
});
