import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { expandSpecs } from "./geometry.js";

/**
 * Turns short, hand-writable specs into real Excalidraw elements.
 *
 * An agent should be able to say `{ type: "rectangle", x: 0, y: 0, width: 200,
 * height: 100, label: "Auth" }` and get back the ~30-field object Excalidraw
 * actually stores. Everything below exists to close that gap: identity, z-order,
 * the roughjs seed, arrow bindings, and container labels.
 *
 * The package's own `convertToExcalidrawElements` does this job in the browser,
 * but @excalidraw/excalidraw is a React bundle that touches `window` on import,
 * so it cannot run in the MCP process. This is the Node-side equivalent.
 */

const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** 21 chars, matching the nanoid Excalidraw uses, so ids look native. */
export const newId = () => {
  const bytes = crypto.randomBytes(21);
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte & 63];
  return out;
};

const nonce = () => Math.floor(Math.random() * 2 ** 31);

/* ------------------------------------------------------------------ *
 * Fractional indices
 *
 * Excalidraw stores z-order as a fractional index string ("a0", "a1", …)
 * that sorts lexicographically. Every element in a scene carries one, and
 * an element without a valid index can land in the wrong layer or trip
 * validation, so new elements get properly-formed keys continuing from the
 * highest one already in the scene.
 * ------------------------------------------------------------------ */

const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** One step up the integer ladder, carrying into a wider head when it fills. */
const incrementInteger = (key) => {
  const head = key[0];
  let digits = key.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; i >= 0 && carry; i--) {
    const next = DIGITS.indexOf(digits[i]) + 1;
    if (next === DIGITS.length) {
      digits[i] = "0";
    } else {
      digits[i] = DIGITS[next];
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");

  // the digit block is exhausted: move to the next head, which is one digit
  // wider on the positive side and one narrower on the negative side
  if (head === "z") return null;
  const nextHead = DIGITS[DIGITS.indexOf(head) + 1];
  if (nextHead > "a") return nextHead + digits.join("") + "0";
  return nextHead + digits.slice(1).join("");
};

const isIndex = (value) => typeof value === "string" && /^[A-Za-z][0-9A-Za-z]*$/.test(value);

/**
 * A generator that hands out ascending indices after everything in `existing`.
 * Lexicographic order is the real order, so the largest string is the top.
 */
export const indexFactory = (existing = []) => {
  const taken = existing.map((el) => el?.index).filter(isIndex).sort();
  let current = taken.length ? taken[taken.length - 1] : null;
  return () => {
    current = current ? incrementInteger(current) : "a0";
    // z overflow is unreachable in practice; fall back rather than emit null
    if (!current) current = "a0";
    return current;
  };
};

/* ------------------------------------------------------------------ *
 * Text metrics
 *
 * Excalidraw measures text in a canvas context that does not exist here, so
 * width is estimated. The table below sets *relative* character widths; the
 * absolute scale comes from FONT_FACTOR, which was fitted against the text
 * elements already in the vault (median width / (chars x fontSize): 0.51 for
 * Excalifont, 0.53 for Virgil). Normalising the table against a reference
 * string keeps the two independent - adjust letter shapes without moving the
 * overall size, or vice versa.
 *
 * Height is exact: Excalidraw lays text out at lineHeight x fontSize per line.
 * Width is exact too where font-metrics.json covers the glyphs, and estimated
 * beyond that.
 * ------------------------------------------------------------------ */

export const LINE_HEIGHT = 1.25;

const NARROW = new Set([..."iljtfrI|!.,;:'`()[]{}"]);
const WIDE = new Set([..."mwMW@%"]);
const UPPER = new Set([..."ABCDEFGHJKLNOPQRSTUVXYZ"]);

const charWeight = (ch) => {
  if (ch === " ") return 0.5;
  if (NARROW.has(ch)) return 0.45;
  if (WIDE.has(ch)) return 1.45;
  if (UPPER.has(ch)) return 1.1;
  if (ch >= "0" && ch <= "9") return 1.0;
  // anything outside latin (CJK, emoji) is roughly square
  if (ch.codePointAt(0) > 0x2e80) return 2.0;
  return 0.95;
};

const REFERENCE = "the quick brown fox jumps over the lazy dog, 0123456789 THE QUICK";
const referenceMean =
  [...REFERENCE].reduce((sum, ch) => sum + charWeight(ch), 0) / REFERENCE.length;

/** Fitted from the vault; keyed by Excalidraw's fontFamily ids. */
const FONT_FACTOR = {
  1: 0.53, // Virgil
  2: 0.5, // Helvetica / Assistant
  3: 0.6, // Cascadia (monospace, exact)
  5: 0.51, // Excalifont (the default)
  6: 0.5, // Nunito
  7: 0.55, // Lilita
  8: 0.53, // Comic Shanns
};

const widthScale = (fontFamily) =>
  (FONT_FACTOR[fontFamily] ?? 0.51) / referenceMean;

/**
 * Real advance widths, measured from Excalidraw's own font files in its own
 * Chromium (scripts/measure-fonts.mjs writes font-metrics.json). Per px of
 * font size, keyed by fontFamily id then character. The heuristic above is the
 * fallback for a family or character the table does not have.
 */
const METRICS = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./font-metrics.json", import.meta.url), "utf8"));
  } catch {
    return {};
  }
})();

const lineWidth = (line, fontSize, fontFamily) => {
  const table = METRICS[fontFamily];
  if (table) {
    let run = 0;
    for (const ch of line) {
      const advance = table.advance[ch];
      // an unmeasured glyph (CJK, emoji) is roughly square in every font here
      run += advance !== undefined ? advance : ch.codePointAt(0) > 0x2e80 ? 1 : table.mean;
    }
    return run * fontSize;
  }
  let run = 0;
  for (const ch of line) run += charWeight(ch);
  return run * widthScale(fontFamily) * fontSize;
};

export const measureText = (text, fontSize, fontFamily = 5) => {
  const lines = String(text ?? "").split("\n");
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, lineWidth(line, fontSize, fontFamily));
  }
  return {
    width: Math.max(width, fontSize * 0.5),
    height: lines.length * fontSize * LINE_HEIGHT,
  };
};

/** Excalidraw's own inset between a container's edge and its label. */
export const BOUND_TEXT_PADDING = 5;

/**
 * Break text to fit a width, the way Excalidraw does when you resize a text
 * box: greedy on whitespace, and a word longer than the line gets split rather
 * than allowed to overhang.
 *
 * Excalidraw stores both forms - `text` carries the inserted breaks and
 * `originalText` is what was typed - so unwrapping later stays possible. Callers
 * that hand over a width get this automatically, which is the difference
 * between a labelled box and a label lying across three other shapes.
 */
export const wrapText = (text, maxWidth, fontSize, fontFamily = 5) => {
  if (!(maxWidth > 0)) return String(text ?? "");
  const out = [];

  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    const push = () => {
      out.push(line);
      line = "";
    };

    for (const word of paragraph.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (lineWidth(candidate, fontSize, fontFamily) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) push();

      // a single word wider than the line: cut it at the last character that fits
      let rest = word;
      while (lineWidth(rest, fontSize, fontFamily) > maxWidth && rest.length > 1) {
        let cut = rest.length;
        while (cut > 1 && lineWidth(rest.slice(0, cut), fontSize, fontFamily) > maxWidth) {
          cut -= 1;
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    push();
  }

  return out.join("\n");
};

/* ------------------------------------------------------------------ *
 * Element construction
 * ------------------------------------------------------------------ */

const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const LINEAR = new Set(["arrow", "line"]);

/**
 * Types this file knows how to add sugar for. Anything else still builds - an
 * unrecognised type is passed through with only the universal fields filled in,
 * because Excalidraw gains element types faster than this file will, and a
 * whitelist here would silently become a ceiling on what an agent can draw.
 */
export const SUGARED_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
  "freedraw",
  "frame",
]);

/**
 * Fill in what Excalidraw requires and the caller left out, and change nothing
 * else. Every field a caller *did* supply survives verbatim, including fields
 * this file has never heard of, so a full element pasted straight out of a
 * .excalidraw file round-trips untouched.
 */
const base = (spec, index, ink = "#1e1e1e") => {
  // the sugar fields are consumed by buildElements and must not reach the
  // element itself, so they are peeled off here rather than deleted later
  const { ref: _ref, label: _label, start: _start, end: _end, ...rest } = spec;
  const withDefault = (key, value) => {
    if (rest[key] === undefined) rest[key] = value;
  };
  withDefault("id", newId());
  withDefault("x", 0);
  withDefault("y", 0);
  withDefault("width", 100);
  withDefault("height", 100);
  withDefault("angle", 0);
  withDefault("strokeColor", ink);
  withDefault("backgroundColor", "transparent");
  withDefault("fillStyle", "solid");
  withDefault("strokeWidth", 2);
  withDefault("strokeStyle", "solid");
  withDefault("roughness", 1);
  withDefault("opacity", 100);
  withDefault("groupIds", []);
  withDefault("frameId", null);
  withDefault("roundness", defaultRoundness(spec.type));
  withDefault("seed", nonce());
  withDefault("version", 1);
  withDefault("versionNonce", nonce());
  withDefault("isDeleted", false);
  withDefault("boundElements", []);
  withDefault("updated", Date.now());
  withDefault("link", null);
  withDefault("locked", false);
  // z-order is the one field a caller cannot usefully choose: it has to be
  // valid relative to what is already in the scene
  rest.index = isIndex(spec.index) ? spec.index : index;
  return rest;
};

const num = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const defaultRoundness = (type) => {
  if (SHAPES.has(type) && type !== "diamond") return { type: 3 };
  if (type === "diamond") return { type: 2 };
  if (LINEAR.has(type)) return { type: 2 };
  return null;
};

/**
 * Text is wrapped whenever a width is available to wrap to: the container's
 * width for a bound label, or an explicit `width` / `wrap` on a standalone text
 * element. Without one it stays on a single line, which is what Excalidraw does
 * for freely-typed text.
 */
const textFields = (spec, containerId = null, containerWidth = null) => {
  const fontSize = num(spec.fontSize, 20);
  const fontFamily = num(spec.fontFamily, 5);
  const original = String(spec.text ?? "");

  let wrapWidth = null;
  if (containerId && containerWidth) {
    wrapWidth = containerWidth - BOUND_TEXT_PADDING * 2;
  } else if (typeof spec.wrap === "number") {
    wrapWidth = spec.wrap;
  } else if (spec.wrap !== false && typeof spec.width === "number") {
    wrapWidth = spec.width;
  }

  const text = wrapWidth ? wrapText(original, wrapWidth, fontSize, fontFamily) : original;
  const measured = measureText(text, fontSize, fontFamily);

  return {
    text,
    originalText: original,
    fontSize,
    fontFamily,
    textAlign: spec.textAlign ?? (containerId ? "center" : "left"),
    verticalAlign: spec.verticalAlign ?? (containerId ? "middle" : "top"),
    containerId,
    // a declared width is a commitment; only free text resizes itself
    autoResize: !containerId && !wrapWidth,
    lineHeight: LINE_HEIGHT,
    measured: wrapWidth ? { width: wrapWidth, height: measured.height } : measured,
  };
};

/**
 * Complete a list of elements. Returns real Excalidraw elements in the order
 * given, with anything the caller supplied left exactly as supplied.
 *
 * This is a *completion* pass, not a translation layer. Hand it a full element
 * copied out of a .excalidraw file and it comes back unchanged apart from a
 * fresh id and a valid z-index. Hand it `{ type: "rectangle", x: 0, y: 0 }` and
 * it fills in the other 25 fields. Both are first-class; the shorthand exists to
 * save typing, never to limit what can be expressed.
 *
 * The optional sugar, applied only where the caller left the real field empty:
 *   label            a centred, container-bound text element on a shape
 *   ref / start / end  arrow bindings by name, resolved after everything exists
 *   points as [[x,y]]  re-based so the first point sits at the origin
 */
/**
 * @param ink  default strokeColor for anything that does not set one; the
 *             caller derives it from the scene's paper (see paper.js)
 */
export function buildElements(rawSpecs, { existing = [], ink = "#1e1e1e" } = {}) {
  // parametric shapes and repeat/mirror macros become ordinary specs first
  const { specs, warnings: geometryWarnings } = expandSpecs(rawSpecs);

  const nextIndex = indexFactory(existing);
  const built = [];
  const byRef = new Map();
  const warnings = [...geometryWarnings];
  const slots = []; // parallel to specs: where each spec's element landed

  for (const spec of specs ?? []) {
    if (!spec || typeof spec !== "object" || typeof spec.type !== "string") {
      warnings.push(
        `skipped an entry with no "type" field - every element is {"type": "path" | "rectangle" | ..., ...fields}: ${JSON.stringify(spec)?.slice(0, 80)}`,
      );
      slots.push(null);
      continue;
    }
    if (!SUGARED_TYPES.has(spec.type)) {
      // images, embeddables, whatever ships next: pass it through intact
      warnings.push(
        `"${spec.type}" passed through without shape-specific defaults`,
      );
    }

    const el = base(spec, nextIndex(), ink);

    if (spec.type === "text") {
      const { measured, ...fields } = textFields(spec);
      for (const [key, value] of Object.entries(fields)) {
        // `text` is the one field that must be rewritten rather than preserved:
        // it is the caller's string *after* wrapping, and the unwrapped version
        // is kept alongside it in originalText
        if (key === "text" || key === "originalText" || spec[key] === undefined) {
          el[key] = value;
        }
      }
      if (spec.width === undefined) el.width = measured.width;
      if (spec.height === undefined) el.height = measured.height;
    }

    if (LINEAR.has(spec.type) || spec.type === "freedraw") {
      const points = normalisePoints(spec);
      el.points = points;
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      if (spec.width === undefined) el.width = Math.max(...xs) - Math.min(...xs);
      if (spec.height === undefined) el.height = Math.max(...ys) - Math.min(...ys);
      if (el.lastCommittedPoint === undefined) {
        el.lastCommittedPoint = spec.type === "freedraw" ? points.at(-1) : null;
      }
      if (LINEAR.has(spec.type)) {
        if (el.startBinding === undefined) el.startBinding = null;
        if (el.endBinding === undefined) el.endBinding = null;
        if (el.startArrowhead === undefined) el.startArrowhead = null;
        if (el.endArrowhead === undefined) {
          el.endArrowhead = spec.type === "arrow" ? "arrow" : null;
        }
        if (el.elbowed === undefined) el.elbowed = false;
      } else {
        if (el.pressures === undefined) el.pressures = [];
        if (el.simulatePressure === undefined) el.simulatePressure = true;
      }
    }

    if (spec.type === "frame" && el.name === undefined) el.name = null;

    slots.push(el);
    built.push(el);
    if (spec.ref) byRef.set(spec.ref, el);

    // a shape carrying a label gets a second, container-bound text element
    const label = spec.label;
    if (SHAPES.has(spec.type) && label !== undefined && label !== null && String(label).length) {
      const labelSpec = typeof label === "object" ? label : { text: String(label) };
      const { measured, ...fields } = textFields(
        { fontSize: spec.fontSize, fontFamily: spec.fontFamily, ...labelSpec },
        el.id,
        el.width,
      );

      // a label that no longer fits grows its container, rather than spilling
      // out of it - the same thing Excalidraw does when you type past the edge
      const needed = measured.height + BOUND_TEXT_PADDING * 2;
      if (needed > el.height) el.height = needed;

      const text = base(
        {
          ...labelSpec,
          type: "text",
          strokeColor: labelSpec.strokeColor ?? spec.strokeColor ?? ink,
          opacity: spec.opacity,
          roundness: null,
          // Excalidraw re-centres bound text on container resize; this places
          // it correctly for the container as it stands now
          x: el.x + (el.width - measured.width) / 2,
          y: el.y + (el.height - measured.height) / 2,
          width: measured.width,
          height: measured.height,
          ...fields,
        },
        nextIndex(),
        ink,
      );
      el.boundElements = [...(el.boundElements ?? []), { id: text.id, type: "text" }];
      built.push(text);
    }
  }

  resolveBindings(specs ?? [], slots, built, byRef, warnings);
  return { elements: built, warnings };
}

/**
 * Points are stored relative to the element origin with the first at [0,0].
 * Already-correct input passes through; `[{x,y}]` and absolute runs are fixed.
 */
const normalisePoints = (spec) => {
  const raw = Array.isArray(spec.points) && spec.points.length >= 2 ? spec.points : null;
  if (!raw) {
    // no points given: a straight run across the declared box
    return [
      [0, 0],
      [num(spec.width, 100), num(spec.height, 0)],
    ];
  }
  const pts = raw.map((p) =>
    Array.isArray(p) ? [num(p[0], 0), num(p[1], 0)] : [num(p?.x, 0), num(p?.y, 0)],
  );
  const [ox, oy] = pts[0];
  if (ox === 0 && oy === 0) return pts;
  return pts.map(([px, py]) => [px - ox, py - oy]);
};

/**
 * Arrow bindings are two-sided: the arrow points at the shape, and the shape
 * lists the arrow. Excalidraw keeps the arrow attached while the shape moves
 * only if both halves are present.
 */
const resolveBindings = (specs, slots, built, byRef, warnings) => {
  const byId = new Map(built.map((el) => [el.id, el]));
  const find = (target) => {
    if (!target) return null;
    if (typeof target === "string") return byRef.get(target) ?? byId.get(target) ?? null;
    if (target.ref) return byRef.get(target.ref) ?? null;
    if (target.id) return byId.get(target.id) ?? null;
    return null;
  };

  specs.forEach((spec, i) => {
    const el = slots[i];
    if (!el || spec?.type !== "arrow") return;
    for (const [key, bindKey] of [
      ["start", "startBinding"],
      ["end", "endBinding"],
    ]) {
      if (!spec[key]) continue;
      const target = find(spec[key]);
      if (!target) {
        warnings.push(`arrow ${key} target not found: ${JSON.stringify(spec[key])}`);
        continue;
      }
      el[bindKey] = { elementId: target.id, focus: 0, gap: 4 };
      target.boundElements = [
        ...(target.boundElements ?? []),
        { id: el.id, type: "arrow" },
      ];
    }
  });
};

/**
 * Apply a partial patch to an existing element, keeping Excalidraw's bookkeeping
 * fields honest so the app treats it as a real edit rather than stale data.
 */
export function patchElement(element, patch) {
  const next = { ...element };
  for (const [key, value] of Object.entries(patch ?? {})) {
    // id is how the patch found this element in the first place, and index has
    // to stay a valid fractional key; everything else is the caller's to change
    if (key === "id") continue;
    if (key === "index" && !isIndex(value)) continue;
    next[key] = value;
  }
  const retext =
    patch.text !== undefined ||
    patch.fontSize !== undefined ||
    patch.width !== undefined ||
    patch.wrap !== undefined;

  if (element.type === "text" && retext) {
    const original = String(patch.text ?? element.originalText ?? element.text ?? "");
    const fontSize = next.fontSize ?? 20;
    const fontFamily = next.fontFamily ?? 5;

    // re-wrap to whatever width now applies, so editing the text of a box label
    // does not send it running past the edge
    const wrapWidth =
      typeof patch.wrap === "number"
        ? patch.wrap
        : element.autoResize === false || element.containerId
          ? (patch.width ?? element.width)
          : null;

    const text = wrapWidth
      ? wrapText(original, wrapWidth, fontSize, fontFamily)
      : original;
    const measured = measureText(text, fontSize, fontFamily);

    next.text = text;
    next.originalText = original;
    if (patch.width === undefined && !wrapWidth) next.width = measured.width;
    if (patch.height === undefined) next.height = measured.height;
  }
  next.version = (element.version ?? 1) + 1;
  next.versionNonce = nonce();
  next.updated = Date.now();
  return next;
}
