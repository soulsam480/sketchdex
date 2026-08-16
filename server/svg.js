import { measureText } from "./elements.js";
import { fillFor, sketchLine, snapStrokeWidth, SKETCH_STEP } from "./sketch.js";
/**
 * SVG in, native Excalidraw elements out.
 *
 * The reason this exists: a model asked to draw a figure by emitting three
 * hundred positioned polygons produces a pile. The same model writing SVG path
 * data produces something recognisable - because SVG is a format it has seen
 * endlessly, it has real curves, and the whole drawing is authored in one
 * coordinate system instead of as hundreds of independent numeric guesses.
 *
 * So this is not an image importer. Every path becomes a real Excalidraw line
 * element with real points: selectable, movable, recolourable, editable on the
 * canvas like anything drawn by hand.
 *
 * Supported: path (M L H V C S Q T A Z, absolute and relative), rect, circle,
 * ellipse, line, polyline, polygon, g nesting, transform (translate scale
 * rotate matrix skewX skewY), presentation attributes and inline style, text.
 *
 * Not supported, and dropped with a warning rather than faked: gradients,
 * filters, clip paths, masks, patterns, and holes in a fill - Excalidraw has no
 * even-odd fill, so each subpath becomes its own element.
 */

/* ------------------------------------------------------------------ *
 * A very small XML reader
 *
 * There is no DOM here and pulling in a parser for this would be silly: SVG
 * written by a model is well-formed and shallow. Comments, doctypes and CDATA
 * are skipped; everything else becomes {tag, attrs, children}.
 * ------------------------------------------------------------------ */

const parseXml = (source) => {
  const clean = source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");

  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tagRe = /<\s*(\/?)([a-zA-Z_][\w:.-]*)((?:\s+[^<>]*?)?)(\/?)\s*>|([^<]+)/g;

  let match;
  while ((match = tagRe.exec(clean))) {
    const [, closing, name, rawAttrs, selfClose, text] = match;
    const top = stack[stack.length - 1];

    if (text !== undefined) {
      const value = text.trim();
      if (value) top.children.push({ tag: "#text", attrs: {}, children: [], text: value });
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const attrs = {};
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrRe.exec(rawAttrs ?? ""))) {
      attrs[attr[1]] = attr[3] ?? attr[4] ?? "";
    }

    const node = { tag: name.toLowerCase(), attrs, children: [] };
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
};

/* ------------------------------------------------------------------ *
 * Transforms, as 2x3 matrices [a b c d e f]
 * ------------------------------------------------------------------ */

const IDENTITY = [1, 0, 0, 1, 0, 0];

const multiply = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const applyMatrix = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const parseTransform = (value) => {
  let matrix = IDENTITY;
  if (!value) return matrix;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(value))) {
    const n = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    const rad = (deg) => (deg * Math.PI) / 180;
    let step = IDENTITY;
    switch (match[1]) {
      case "matrix":
        step = n.length >= 6 ? n.slice(0, 6) : IDENTITY;
        break;
      case "translate":
        step = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
        break;
      case "scale":
        step = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const [a, cx = 0, cy = 0] = n;
        const c = Math.cos(rad(a));
        const s = Math.sin(rad(a));
        step = multiply([1, 0, 0, 1, cx, cy], multiply([c, s, -s, c, 0, 0], [1, 0, 0, 1, -cx, -cy]));
        break;
      }
      case "skewX":
        step = [1, 0, Math.tan(rad(n[0] || 0)), 1, 0, 0];
        break;
      case "skewY":
        step = [1, Math.tan(rad(n[0] || 0)), 0, 1, 0, 0];
        break;
    }
    matrix = multiply(matrix, step);
  }
  return matrix;
};

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

const NAMED = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000",
  blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080",
  gray: "#808080", grey: "#808080", silver: "#c0c0c0", maroon: "#800000",
  navy: "#000080", teal: "#008080", olive: "#808000", lime: "#00ff00",
  aqua: "#00ffff", cyan: "#00ffff", fuchsia: "#ff00ff", magenta: "#ff00ff",
  pink: "#ffc0cb", brown: "#a52a2a", gold: "#ffd700", darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  transparent: "transparent", none: "transparent",
};

const toHex = (value) => {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "none" || text === "transparent") return "transparent";
  if (NAMED[text]) return NAMED[text];
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`;
    return null;
  }
  const rgb = text.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const channel = (raw) => {
      const n = raw.endsWith("%") ? (parseFloat(raw) / 100) * 255 : parseFloat(raw);
      return Math.max(0, Math.min(255, Math.round(n || 0)));
    };
    const [r, g, b] = parts;
    return `#${[r, g, b].map((c) => channel(c).toString(16).padStart(2, "0")).join("")}`;
  }
  // url(#gradient) and everything else exotic
  return null;
};

/**
 * Rules out of a `<style>` block, as selector -> declarations.
 *
 * Worth supporting because it is not an edge case: Illustrator, Figma and most
 * icon sets export `<style>.cls-1{fill:#e03131}</style>` with `class="cls-1"`
 * on the shapes. Without this every one of those files imports as black
 * silhouettes, which looks like a broken importer rather than a missing feature.
 */
const parseCss = (source) => {
  const rules = new Map();
  // strip at-rules; media queries and font faces have nothing for us
  const body = source.replace(/@[^{]+\{[\s\S]*?\}\s*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {};
    for (const pair of match[2].split(";")) {
      const [key, value] = pair.split(":");
      if (key && value) decls[key.trim().toLowerCase()] = value.trim();
    }
    for (const selector of match[1].split(",")) {
      const key = selector.trim();
      // only the simple selectors these exports actually use
      if (/^[.#]?[\w-]+$/.test(key)) {
        rules.set(key, { ...(rules.get(key) ?? {}), ...decls });
      }
    }
  }
  return rules;
};

/**
 * Presentation attributes, then CSS, then inline style - which is the order the
 * spec gives them, and it matters: a `fill="#000"` attribute alongside a class
 * that sets a real colour must lose to the class.
 */
const readStyle = (attrs, tag = "", css = new Map()) => {
  const fromCss = {};
  for (const key of [tag, ...(attrs.class ?? "").split(/\s+/).filter(Boolean).map((c) => `.${c}`), attrs.id ? `#${attrs.id}` : ""]) {
    if (key && css.has(key)) Object.assign(fromCss, css.get(key));
  }

  const inline = {};
  for (const pair of (attrs.style ?? "").split(";")) {
    const [key, value] = pair.split(":");
    if (key && value) inline[key.trim().toLowerCase()] = value.trim();
  }

  const style = { ...attrs, ...fromCss, ...inline };
  const get = (key) => style[key];
  return {
    fill: get("fill"),
    stroke: get("stroke"),
    strokeWidth: get("stroke-width"),
    opacity: get("opacity"),
    fillOpacity: get("fill-opacity"),
    strokeOpacity: get("stroke-opacity"),
    dash: get("stroke-dasharray"),
    fontSize: get("font-size"),
    fontFamily: get("font-family"),
    textAnchor: get("text-anchor"),
    baseline: get("dominant-baseline") ?? get("alignment-baseline"),
    display: get("display"),
  };
};

/* ------------------------------------------------------------------ *
 * Path data
 * ------------------------------------------------------------------ */

const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/**
 * An SVG font stack to one of Excalidraw's families.
 *
 * Defaulting everything to the hand-drawn face was wrong: a technical drawing
 * labelled in Arial becomes markedly harder to read when every label turns
 * sketchy. Excalidraw offers 2 (clean sans), 3 (mono) and 5 (hand-drawn), so a
 * named sans-serif should land on 2 and only an unspecified font should get the
 * hand-drawn default.
 */
const pickFont = (stack) => {
  const name = String(stack ?? "").toLowerCase();
  if (!name) return 5;
  if (/mono|courier|consolas|menlo|cascadia|code/.test(name)) return 3;
  if (/comic|marker|hand|caveat|virgil|excalifont/.test(name)) return 5;
  if (/arial|helvetica|inter|roboto|sans|segoe|verdana|tahoma|system|georgia|times|serif/.test(name)) {
    return 2;
  }
  return 5;
};

/** Flatten a cubic bezier; sample count follows the control polygon's length. */
const cubic = (out, p0, p1, p2, p3, tolerance) => {
  const rough =
    Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) +
    Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) +
    Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const steps = Math.max(3, Math.min(64, Math.ceil(rough / tolerance)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
};

/** Endpoint-parameterised arc to centre form, then sampled. */
const arcTo = (out, p0, rx, ry, angle, largeArc, sweep, p1, tolerance) => {
  if (!rx || !ry) return out.push(p1);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;

  let RX = Math.abs(rx);
  let RY = Math.abs(ry);
  const check = (x1 * x1) / (RX * RX) + (y1 * y1) / (RY * RY);
  if (check > 1) {
    const scale = Math.sqrt(check);
    RX *= scale;
    RY *= scale;
  }

  const denominator = RX * RX * y1 * y1 + RY * RY * x1 * x1;
  const numerator = RX * RX * RY * RY - denominator;
  const factor =
    (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
  const cx1 = (factor * RX * y1) / RY;
  const cy1 = (-factor * RY * x1) / RX;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;

  const angleOf = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    return sign * Math.acos(Math.max(-1, Math.min(1, dot / len)));
  };

  const start = angleOf(1, 0, (x1 - cx1) / RX, (y1 - cy1) / RY);
  let sweepAngle = angleOf(
    (x1 - cx1) / RX,
    (y1 - cy1) / RY,
    (-x1 - cx1) / RX,
    (-y1 - cy1) / RY,
  );
  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const steps = Math.max(
    3,
    Math.min(90, Math.ceil((Math.abs(sweepAngle) * Math.max(RX, RY)) / tolerance)),
  );
  for (let i = 1; i <= steps; i += 1) {
    const a = start + (sweepAngle * i) / steps;
    const px = Math.cos(a) * RX;
    const py = Math.sin(a) * RY;
    out.push([cos * px - sin * py + cx, sin * px + cos * py + cy]);
  }
};

/**
 * Path data to one point run per subpath. Each `M` starts a new run, which is
 * how a shape with a hole arrives here - and why it leaves as two elements.
 */
const parsePath = (d, tolerance) => {
  const runs = [];
  let points = null;
  let current = [0, 0];
  let start = [0, 0];
  let lastControl = null;
  let lastQuad = null;
  // whether the run in progress has had a real curve command; a run of L/H/V
  // is a polygon and should keep its corners, a run with C/Q/A is a curve
  let curved = false;

  const commands = String(d ?? "").match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) ?? [];

  const begin = () => {
    if (points && points.length > 1) runs.push({ points, closed: false, curved });
    points = [];
    curved = false;
  };

  for (const chunk of commands) {
    const code = chunk[0];
    const type = code.toUpperCase();
    const relative = code !== type;
    const nums = (chunk.slice(1).match(NUMBER_RE) ?? []).map(Number);
    const rel = ([x, y]) => (relative ? [current[0] + x, current[1] + y] : [x, y]);

    if (type === "Z") {
      if (points && points.length > 1) {
        runs.push({ points, closed: true, curved });
        points = [[...start]];
        current = [...start];
        curved = false;
      }
      continue;
    }

    let i = 0;
    while (i < nums.length || (type === "M" && i === 0)) {
      switch (type) {
        case "M": {
          const p = rel([nums[i], nums[i + 1]]);
          i += 2;
          begin();
          points.push(p);
          current = p;
          start = p;
          // extra pairs after an M are implicit L
          while (i + 1 < nums.length) {
            const q = relative ? [current[0] + nums[i], current[1] + nums[i + 1]] : [nums[i], nums[i + 1]];
            i += 2;
            points.push(q);
            current = q;
          }
          break;
        }
        case "L": {
          const p = rel([nums[i], nums[i + 1]]);
          i += 2;
          points.push(p);
          current = p;
          break;
        }
        case "H": {
          const p = [relative ? current[0] + nums[i] : nums[i], current[1]];
          i += 1;
          points.push(p);
          current = p;
          break;
        }
        case "V": {
          const p = [current[0], relative ? current[1] + nums[i] : nums[i]];
          i += 1;
          points.push(p);
          current = p;
          break;
        }
        case "C": {
          const c1 = rel([nums[i], nums[i + 1]]);
          const c2 = rel([nums[i + 2], nums[i + 3]]);
          const end = rel([nums[i + 4], nums[i + 5]]);
          i += 6;
          curved = true;
          cubic(points, current, c1, c2, end, tolerance);
          lastControl = c2;
          current = end;
          break;
        }
        case "S": {
          const c2 = rel([nums[i], nums[i + 1]]);
          const end = rel([nums[i + 2], nums[i + 3]]);
          i += 4;
          const c1 = lastControl
            ? [2 * current[0] - lastControl[0], 2 * current[1] - lastControl[1]]
            : current;
          curved = true;
          cubic(points, current, c1, c2, end, tolerance);
          lastControl = c2;
          current = end;
          break;
        }
        case "Q": {
          const q = rel([nums[i], nums[i + 1]]);
          const end = rel([nums[i + 2], nums[i + 3]]);
          i += 4;
          // a quadratic is a cubic with the control points at two thirds
          curved = true;
          cubic(
            points,
            current,
            [current[0] + (2 / 3) * (q[0] - current[0]), current[1] + (2 / 3) * (q[1] - current[1])],
            [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])],
            end,
            tolerance,
          );
          lastQuad = q;
          current = end;
          break;
        }
        case "T": {
          const end = rel([nums[i], nums[i + 1]]);
          i += 2;
          const q = lastQuad
            ? [2 * current[0] - lastQuad[0], 2 * current[1] - lastQuad[1]]
            : current;
          curved = true;
          cubic(
            points,
            current,
            [current[0] + (2 / 3) * (q[0] - current[0]), current[1] + (2 / 3) * (q[1] - current[1])],
            [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])],
            end,
            tolerance,
          );
          lastQuad = q;
          current = end;
          break;
        }
        case "A": {
          const [rx, ry, rot, large, sweep] = nums.slice(i, i + 5);
          const end = rel([nums[i + 5], nums[i + 6]]);
          i += 7;
          curved = true;
          arcTo(points, current, rx, ry, rot, large, sweep, end, tolerance);
          current = end;
          break;
        }
        default:
          i = nums.length;
      }
      if (type !== "C" && type !== "S") lastControl = null;
      if (type !== "Q" && type !== "T") lastQuad = null;
      if (type === "M") break;
      if (i >= nums.length) break;
    }
  }
  if (points && points.length > 1) runs.push({ points, closed: false, curved });
  return runs;
};

/* ------------------------------------------------------------------ *
 * Shapes to Excalidraw specs
 * ------------------------------------------------------------------ */

const ellipsePoints = (cx, cy, rx, ry, tolerance) => {
  const steps = Math.max(12, Math.min(96, Math.ceil((Math.max(rx, ry) * 2 * Math.PI) / tolerance)));
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
};

const num = (value, fallback = 0) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Ray casting: is this point inside that ring? Used to spot subpath holes. */
const contains = (ring, [px, py]) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
};

/**
 * @param svg      the markup
 * @param options  x, y, width, height to fit into; tolerance in user units
 */
export function svgToSpecs(svg, options = {}) {
  const {
    tolerance = 3,
    currentColor = "#1e1e1e",
    holeColor = null,
    /**
     * "sketch" is the default and the point of the tool: anchors re-spaced to
     * a hand-sized step, curves drawn as curves, roughness 1,
     * circles and rects as native Excalidraw shapes. The result looks drawn on
     * the canvas rather than pasted onto it. "precise" keeps every flattened
     * vertex and roughness 0 - for a logo that must be exact.
     */
    style: mode = "sketch",
    roughness = mode === "precise" ? 0 : 1,
    fillStyle: forcedFill,
    step = SKETCH_STEP,
  } = options;
  const sketch = mode !== "precise";
  const warnings = [];
  const dropped = new Set();
  const shapes = [];
  let holes = false;

  const root = parseXml(String(svg ?? ""));
  const svgNode = (function find(node) {
    if (node.tag === "svg") return node;
    for (const child of node.children) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  })(root);

  if (!svgNode) throw new Error("no <svg> element found");

  /* first pass: collect stylesheets and anything addressable by id --- */
  const css = new Map();
  const byId = new Map();
  (function index(node) {
    for (const child of node.children) {
      if (child.tag === "style") {
        const text = child.children.map((n) => n.text ?? "").join("");
        for (const [key, decls] of parseCss(text)) {
          css.set(key, { ...(css.get(key) ?? {}), ...decls });
        }
      }
      if (child.attrs?.id) byId.set(child.attrs.id, child);
      index(child);
    }
  })(svgNode);

  const walk = (node, matrix, inherited, depth = 0) => {
    if (depth > 24) return; // a <use> cycle would otherwise never end
    for (const child of node.children) {
      if (child.tag === "#text") continue;
      const style = { ...inherited, ...clean(readStyle(child.attrs, child.tag, css)) };
      if (style.display === "none") continue;
      const local = multiply(matrix, parseTransform(child.attrs.transform));

      /**
       * `<use>` is how icon sprites and repeated symbols are written, so it is
       * resolved rather than dropped: find the referenced node, offset by
       * x/y, and draw it here.
       */
      if (child.tag === "use") {
        const ref = (child.attrs.href ?? child.attrs["xlink:href"] ?? "").replace(/^#/, "");
        const target = byId.get(ref);
        if (!target) {
          warnings.push(`<use> pointed at "#${ref}", which is not in the file`);
          continue;
        }
        const placed = multiply(local, [1, 0, 0, 1, num(child.attrs.x), num(child.attrs.y)]);
        walk({ children: [{ ...target, attrs: { ...target.attrs, id: undefined } }] }, placed, style, depth + 1);
        continue;
      }

      switch (child.tag) {
        case "g":
        case "svg":
        case "a":
          if (child.attrs["clip-path"] || child.attrs.mask) {
            warnings.push(
              "a clip-path or mask was ignored, so something may extend past where it should",
            );
          }
          walk(child, local, style, depth + 1);
          break;
        case "path": {
          const runs = parsePath(child.attrs.d, tolerance);
          const filled = style.fill && style.fill !== "none";

          /**
           * Excalidraw has no even-odd fill, so a subpath cannot cut a hole in
           * the one around it - it lands on top as another filled shape. When a
           * backdrop colour is known, painting the inner ring in it is the
           * honest approximation: an eye lens or a technical cutaway reads
           * correctly, even though nothing is truly transparent.
           */
          for (const [i, run] of runs.entries()) {
            const inner =
              filled &&
              i > 0 &&
              run.closed &&
              runs[0].closed &&
              contains(runs[0].points, run.points[0]);
            if (inner) holes = true;
            shapes.push({
              points: run.points,
              closed: run.closed,
              curved: run.curved,
              style,
              matrix: local,
              isHole: inner,
            });
          }
          break;
        }
        case "rect": {
          const x = num(child.attrs.x);
          const y = num(child.attrs.y);
          const w = num(child.attrs.width);
          const h = num(child.attrs.height);
          shapes.push({
            points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
            closed: true,
            curved: false,
            rounded: num(child.attrs.rx) > 0,
            native: { type: "rectangle", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 },
            style,
            matrix: local,
          });
          break;
        }
        case "circle": {
          const r = num(child.attrs.r);
          shapes.push({
            points: ellipsePoints(num(child.attrs.cx), num(child.attrs.cy), r, r, tolerance),
            closed: true,
            curved: true,
            native: { type: "ellipse", cx: num(child.attrs.cx), cy: num(child.attrs.cy), rx: r, ry: r },
            style,
            matrix: local,
          });
          break;
        }
        case "ellipse": {
          shapes.push({
            points: ellipsePoints(
              num(child.attrs.cx),
              num(child.attrs.cy),
              num(child.attrs.rx),
              num(child.attrs.ry),
              tolerance,
            ),
            closed: true,
            curved: true,
            native: {
              type: "ellipse",
              cx: num(child.attrs.cx),
              cy: num(child.attrs.cy),
              rx: num(child.attrs.rx),
              ry: num(child.attrs.ry),
            },
            style,
            matrix: local,
          });
          break;
        }
        case "line": {
          shapes.push({
            points: [
              [num(child.attrs.x1), num(child.attrs.y1)],
              [num(child.attrs.x2), num(child.attrs.y2)],
            ],
            closed: false,
            curved: false,
            style,
            matrix: local,
          });
          break;
        }
        case "polyline":
        case "polygon": {
          const nums = (child.attrs.points ?? "").match(NUMBER_RE)?.map(Number) ?? [];
          const points = [];
          for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
          if (points.length > 1) {
            shapes.push({ points, closed: child.tag === "polygon", curved: false, style, matrix: local });
          }
          break;
        }
        case "text": {
          const text = child.children
            .map((n) => (n.tag === "#text" ? n.text : n.children.map((t) => t.text ?? "").join("")))
            .join(" ")
            .trim();
          if (text) {
            shapes.push({
              text,
              at: [num(child.attrs.x), num(child.attrs.y)],
              style,
              matrix: local,
            });
          }
          break;
        }
        case "image":
          warnings.push(
            "an embedded <image> was skipped: this converts vector artwork to editable elements, and a raster has none",
          );
          break;
        case "title":
        case "desc":
        case "defs":
        case "style":
        case "metadata":
        case "clippath":
        case "mask":
          break;
        default:
          dropped.add(child.tag);
      }
    }
  };

  /**
   * A paint value to a flat colour.
   *
   * Excalidraw fills are solid, so a gradient becomes its first stop rather
   * than nothing: the wrong shade of the right colour beats a shape that
   * silently vanishes or turns black.
   */
  const paint = (value) => {
    if (value === "currentColor") return currentColor;
    const url = String(value ?? "").match(/url\(\s*#([^)\s]+)\s*\)/);
    if (url) {
      const node = byId.get(url[1]);
      const stop = node && (function firstStop(n) {
        for (const child of n.children) {
          if (child.tag === "stop") {
            return readStyle(child.attrs, "stop", css)["stop-color"] ?? child.attrs["stop-color"];
          }
          const deeper = firstStop(child);
          if (deeper) return deeper;
        }
        return null;
      })(node);
      if (stop) {
        warnings.push(`gradient "${url[1]}" flattened to its first stop`);
        return toHex(stop);
      }
      warnings.push(`could not resolve paint "${value}"`);
      return null;
    }
    return toHex(value);
  };

  walk(svgNode, IDENTITY, {});
  if (dropped.size) {
    warnings.push(`ignored unsupported elements: ${[...dropped].join(", ")}`);
  }
  if (holes) {
    warnings.push(
      holeColor
        ? "compound paths had their inner rings painted in the supplied holeColor; Excalidraw has no true even-odd fill"
        : "a compound path has inner rings that should be holes. Excalidraw has no even-odd fill, so they are filled over. Pass holeColor with the backdrop colour to punch them visually.",
    );
  }
  if (!shapes.length) {
    throw new Error(
      warnings.length
        ? `nothing drawable was produced. ${warnings.join(" ")}`
        : "nothing drawable found in the SVG",
    );
  }

  // everything into one coordinate space
  for (const shape of shapes) {
    if (shape.points) shape.points = shape.points.map((p) => applyMatrix(shape.matrix, p));
    if (shape.at) shape.at = applyMatrix(shape.matrix, shape.at);
  }

  /* fit to the requested box, preserving aspect ---------------------- */

  /**
   * The viewBox wins over the painted bounds when it is declared.
   *
   * A composition's margins are part of the design: a blueprint drawn inside
   * 1800x1200 with deliberate breathing room around the frame is not the same
   * drawing as its 1756x1156 ink bounds stretched to fill the target. Cropping
   * to what happens to be painted silently rebases everything and throws the
   * spacing away.
   */
  const viewBox = (svgNode.attrs.viewBox ?? "").match(NUMBER_RE)?.map(Number);
  const declared = viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;

  const xs = [];
  const ys = [];
  for (const shape of shapes) {
    for (const [px, py] of shape.points ?? [shape.at]) {
      xs.push(px);
      ys.push(py);
    }
  }
  const minX = declared ? viewBox[0] : Math.min(...xs);
  const minY = declared ? viewBox[1] : Math.min(...ys);
  const srcW = declared ? viewBox[2] : Math.max(1e-6, Math.max(...xs) - minX);
  const srcH = declared ? viewBox[3] : Math.max(1e-6, Math.max(...ys) - minY);

  const targetW = options.width ?? srcW;
  const targetH = options.height ?? (options.width ? (srcH * options.width) / srcW : srcH);
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const offsetX = (options.x ?? 0) - minX * scale;
  const offsetY = (options.y ?? 0) - minY * scale;
  const place = ([px, py]) => [px * scale + offsetX, py * scale + offsetY];

  /* to Excalidraw specs ---------------------------------------------- */
  const specs = [];
  for (const shape of shapes) {
    const { style } = shape;
    const strokeAlpha = num(style.strokeOpacity, 1) * num(style.opacity, 1);
    const fillAlpha = num(style.fillOpacity, 1) * num(style.opacity, 1);

    if (shape.text) {
      const [x, y] = place(shape.at);
      const fontSize = Math.max(6, num(style.fontSize, 16) * scale);
      const fontFamily = pickFont(style.fontFamily);
      const width = measureText(shape.text, fontSize, fontFamily).width;

      /**
       * SVG anchors text at a point; Excalidraw positions a box by its left
       * edge. Ignoring the anchor silently left-aligns every centred and
       * right-aligned label, which pulls a laid-out drawing apart.
       */
      const anchor = String(style.textAnchor ?? "start").toLowerCase();
      const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;

      // SVG measures from the baseline, Excalidraw from the top
      const baseline = String(style.baseline ?? "").toLowerCase();
      const top =
        baseline === "middle" || baseline === "central"
          ? y - fontSize * 0.5
          : baseline === "hanging" || baseline === "text-before-edge"
            ? y
            : y - fontSize * 0.85;

      specs.push({
        type: "text",
        x: left,
        y: top,
        text: shape.text,
        fontSize: Math.round(fontSize),
        fontFamily,
        textAlign: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
        width,
        strokeColor: paint(style.fill) ?? currentColor,
        opacity: Math.round(fillAlpha * 100),
      });
      continue;
    }

    /**
     * A circle or a rect is drawn as Excalidraw's own ellipse/rectangle when
     * its transform allows (rotation and uniform or axis scale, no skew). Those
     * are the most hand-drawn things on the canvas - rough.js draws them as
     * two overlapping strokes - and they stay editable as the shape they are.
     */
    if (shape.native && sketch) {
      const m = shape.matrix;
      const [a, b, c, d] = m;
      const skew = Math.abs(a * c + b * d);
      const sx = Math.hypot(a, b);
      const sy = Math.hypot(c, d);
      if (sx > 0 && sy > 0 && skew < 1e-6 * sx * sy + 1e-9) {
        const { cx, cy, rx, ry } = shape.native;
        const [mx, my] = place(applyMatrix(m, [cx, cy]));
        const w = 2 * rx * sx * scale;
        const h = 2 * ry * sy * scale;
        const fillN = paint(style.fill);
        const strokeN = paint(style.stroke);
        let fillResolved = style.fill === undefined && style.stroke ? "transparent" : (fillN ?? "transparent");
        if (shape.isHole && holeColor) fillResolved = holeColor;
        const filled = fillResolved !== "transparent";
        specs.push({
          type: shape.native.type,
          x: mx - w / 2,
          y: my - h / 2,
          width: w,
          height: h,
          angle: Math.atan2(b, a) * Math.sign(a * d - b * c || 1),
          strokeColor: strokeN && strokeN !== "transparent" ? strokeN : filled ? fillResolved : currentColor,
          backgroundColor: fillResolved,
          fillStyle: filled ? fillFor(forcedFill, w * h) : "solid",
          strokeWidth: strokeN ? snapStrokeWidth(num(style.strokeWidth, 1) * scale) : 1,
          strokeStyle: style.dash && style.dash !== "none" ? "dashed" : "solid",
          roughness,
          roundness: shape.native.type === "rectangle" && shape.rounded ? { type: 3 } : null,
          opacity: Math.round((strokeN ? strokeAlpha : fillAlpha) * 100),
        });
        continue;
      }
    }

    const points = shape.points.map(place);
    if (shape.closed) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) points.push([...first]);
    }

    const fill = paint(style.fill);
    const stroke = paint(style.stroke);
    // an SVG shape with no fill attribute is filled black; one that is only
    // stroked must not become a black blob here
    let resolvedFill = style.fill === undefined && style.stroke ? "transparent" : (fill ?? "transparent");
    if (shape.isHole && holeColor) resolvedFill = holeColor;

    const xsP = points.map((p) => p[0]);
    const ysP = points.map((p) => p[1]);
    // anchored at the first point, which is Excalidraw's convention for linear
    // elements: points[0] is [0,0] and the rest may be negative
    const [x, y] = points[0];

    const line = {
      type: "line",
      x,
      y,
      width: Math.max(...xsP) - Math.min(...xsP),
      height: Math.max(...ysP) - Math.min(...ysP),
      points: points.map(([px, py]) => [px - x, py - y]),
      strokeColor: stroke ?? (resolvedFill !== "transparent" ? resolvedFill : currentColor),
      backgroundColor: resolvedFill,
      strokeWidth: stroke
        ? sketch
          ? snapStrokeWidth(num(style.strokeWidth, 1) * scale)
          : Math.max(1, Math.round(num(style.strokeWidth, 1) * scale))
        : 1,
      strokeStyle: style.dash && style.dash !== "none" ? "dashed" : "solid",
      roughness,
      opacity: Math.round((stroke ? strokeAlpha : fillAlpha) * 100),
      // a stroke of none means the outline should not draw at all
      ...(stroke === "transparent" && resolvedFill !== "transparent"
        ? { strokeColor: resolvedFill }
        : {}),
    };
    specs.push(
      sketch
        ? sketchLine(line, { curved: shape.curved !== false, step, fill: forcedFill })
        : { ...line, fillStyle: "solid", roundness: null },
    );
  }

  return {
    specs,
    warnings,
    source: { width: srcW, height: srcH },
    placed: { width: srcW * scale, height: srcH * scale },
    shapes: specs.length,
  };
}

/** Drop undefined keys so inherited style is not clobbered by absent ones. */
const clean = (object) => {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};
