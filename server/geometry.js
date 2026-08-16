/**
 * Parametric geometry, so an agent stops placing vertices by hand.
 *
 * The tell in an agent-drawn scene is the organic shapes: a pauldron described
 * by nine guessed points reads as something drawn with a trackpad, while the
 * bolt rings and dials in the same drawing look designed - because those are
 * circles repeated at even angles, which is arithmetic a model can actually do.
 *
 * Everything here turns a description into real geometry at a resolution no one
 * would type out: `{ type: "polygon", sides: 7, r: 80 }`, or a five-point path
 * that comes back as a smooth 60-point curve. Detail gets *cheaper* to ask for,
 * which is the only way to get more of it.
 *
 * Two layers:
 *   macros     repeat / mirror / grid, which turn one spec into many
 *   primitives polygon, star, arc, capsule, path, which become real elements
 */

import { resample } from "./sketch.js";

const TAU = Math.PI * 2;
const rad = (deg) => (deg * Math.PI) / 180;

const num = (value, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** Absolute points to an element: origin at the top-left, points relative. */
const fromAbsolute = (pts, spec, { closed = false, curved = false } = {}) => {
  const joined = closed && (pts[0][0] !== pts.at(-1)[0] || pts[0][1] !== pts.at(-1)[1])
    ? [...pts, [...pts[0]]]
    : pts;
  /**
   * A generated curve is dense - sixty points on a capsule corner - and
   * rough.js wobbles every segment separately, so at that density the sketchy
   * stroke turns into fuzz. Re-space curves at a hand-sized step and let
   * Excalidraw draw them as curves; the wobble comes back as one confident bow
   * per segment, which is what a line drawn by hand looks like.
   */
  const points = curved ? resample(joined) : joined;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  /**
   * Excalidraw anchors a linear element at its *first point*, not at the corner
   * of its bounding box: `points[0]` is always `[0, 0]` and later points may be
   * negative. Emitting bbox-relative points instead looks right until something
   * re-bases them, at which point every shape shifts by its own first-point
   * offset - a different distance each - and the drawing quietly falls apart.
   */
  const [originX, originY] = points[0];

  // the parametric inputs described the shape; they are not element fields
  const {
    sides: _s, cx: _cx, cy: _cy, r: _r, rx: _rx, ry: _ry, innerR: _ir,
    innerRatio: _irr, rotation: _rot, from: _from, to: _to, segments: _seg,
    radius: _rad, smooth, closed: _closed, resolution: _res, ...rest
  } = spec;

  return {
    ...rest,
    // a closed run with a fill is a shape; Excalidraw draws that as a `line`
    type: "line",
    x: originX,
    y: originY,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: points.map(([px, py]) => [px - originX, py - originY]),
    // a polygon keeps the corners it declares; a curve draws as a curve
    roundness: spec.roundness !== undefined ? spec.roundness : curved || smooth ? { type: 2 } : null,
  };
};

const polygon = (spec) => {
  const sides = Math.max(3, Math.round(num(spec.sides, 6)));
  const cx = num(spec.cx, num(spec.x, 0) + num(spec.width, 100) / 2);
  const cy = num(spec.cy, num(spec.y, 0) + num(spec.height, 100) / 2);
  const rx = num(spec.rx, num(spec.r, num(spec.width, 100) / 2));
  const ry = num(spec.ry, num(spec.r, num(spec.height, num(spec.width, 100)) / 2));
  const turn = rad(num(spec.rotation, -90)); // first vertex at the top

  const pts = [];
  for (let i = 0; i < sides; i += 1) {
    const a = turn + (i / sides) * TAU;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return fromAbsolute(pts, spec, { closed: true });
};

const star = (spec) => {
  const count = Math.max(3, Math.round(num(spec.points, 5)));
  const cx = num(spec.cx, num(spec.x, 0) + num(spec.width, 100) / 2);
  const cy = num(spec.cy, num(spec.y, 0) + num(spec.height, 100) / 2);
  const outer = num(spec.r, num(spec.width, 100) / 2);
  const inner = num(spec.innerR, outer * num(spec.innerRatio, 0.45));
  const turn = rad(num(spec.rotation, -90));

  const pts = [];
  for (let i = 0; i < count * 2; i += 1) {
    const a = turn + (i / (count * 2)) * TAU;
    const radius = i % 2 === 0 ? outer : inner;
    pts.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
  }
  return fromAbsolute(pts, spec, { closed: true });
};

const arc = (spec) => {
  const cx = num(spec.cx, 0);
  const cy = num(spec.cy, 0);
  const rx = num(spec.rx, num(spec.r, 50));
  const ry = num(spec.ry, num(spec.r, 50));
  const from = num(spec.from, 0);
  const to = num(spec.to, 180);
  const steps = Math.max(4, Math.round(num(spec.segments, Math.abs(to - from) / 4)));

  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = rad(from + ((to - from) * i) / steps);
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  if (spec.closed) pts.push([cx, cy]);
  return fromAbsolute(pts, spec, { closed: Boolean(spec.closed), curved: true });
};

/** A rectangle with real rounded ends - the shape a limb or a plate wants. */
const capsule = (spec) => {
  const x = num(spec.x, 0);
  const y = num(spec.y, 0);
  const w = num(spec.width, 100);
  const h = num(spec.height, 60);
  const r = Math.min(num(spec.radius, Math.min(w, h) / 2), Math.min(w, h) / 2);
  const steps = Math.max(3, Math.round(num(spec.segments, 8)));

  const corner = (ccx, ccy, startDeg) => {
    const out = [];
    for (let i = 0; i <= steps; i += 1) {
      const a = rad(startDeg + (90 * i) / steps);
      out.push([ccx + Math.cos(a) * r, ccy + Math.sin(a) * r]);
    }
    return out;
  };

  const pts = [
    ...corner(x + w - r, y + r, -90), // top-right
    ...corner(x + w - r, y + h - r, 0), // bottom-right
    ...corner(x + r, y + h - r, 90), // bottom-left
    ...corner(x + r, y + r, 180), // top-left
  ];
  return fromAbsolute(pts, spec, { closed: true, curved: true });
};

/**
 * Catmull-Rom through the given control points: the curve passes through every
 * one of them, which is what you want when placing a silhouette by eye. Five
 * points in, a smooth run of sixty out.
 */
const path = (spec) => {
  const raw = (spec.points ?? []).map((p) =>
    Array.isArray(p) ? [num(p[0], 0), num(p[1], 0)] : [num(p?.x, 0), num(p?.y, 0)],
  );
  if (raw.length < 2) return fromAbsolute(raw.length ? raw : [[0, 0], [1, 1]], spec);
  if (spec.smooth === false) {
    return fromAbsolute(raw, spec, { closed: Boolean(spec.closed) });
  }

  const closed = Boolean(spec.closed);
  const res = Math.max(2, Math.round(num(spec.resolution, 10)));
  const at = (i) => {
    if (closed) return raw[(i + raw.length) % raw.length];
    return raw[Math.min(raw.length - 1, Math.max(0, i))];
  };

  const out = [];
  const last = closed ? raw.length : raw.length - 1;
  for (let i = 0; i < last; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < res; s += 1) {
      const t = s / res;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(closed ? [...out[0]] : raw.at(-1));
  return fromAbsolute(out, spec, { closed, curved: true });
};

const PRIMITIVES = { polygon, star, arc, capsule, path };
export const PRIMITIVE_TYPES = Object.keys(PRIMITIVES);

/* ------------------------------------------------------------------ *
 * Macros
 * ------------------------------------------------------------------ */

const shift = (spec, dx, dy) => {
  const moved = { ...spec };
  if (typeof moved.x === "number") moved.x += dx;
  if (typeof moved.y === "number") moved.y += dy;
  if (typeof moved.cx === "number") moved.cx += dx;
  if (typeof moved.cy === "number") moved.cy += dy;
  return moved;
};

const flip = (spec, axis, at) => {
  const out = { ...spec };
  const mirrorX = (v, width = 0) => 2 * at - v - width;
  if (axis === "vertical") {
    // reflect left-right across the vertical line x = at
    if (typeof out.x === "number") out.x = mirrorX(out.x, num(out.width, 0));
    if (typeof out.cx === "number") out.cx = 2 * at - out.cx;
    if (Array.isArray(out.points)) {
      out.points = out.points.map((p) =>
        Array.isArray(p) ? [-p[0], p[1]] : [-num(p?.x, 0), num(p?.y, 0)],
      );
    }
  } else {
    if (typeof out.y === "number") out.y = mirrorX(out.y, num(out.height, 0));
    if (typeof out.cy === "number") out.cy = 2 * at - out.cy;
    if (Array.isArray(out.points)) {
      out.points = out.points.map((p) =>
        Array.isArray(p) ? [p[0], -p[1]] : [num(p?.x, 0), -num(p?.y, 0)],
      );
    }
  }
  // a mirrored copy is a new element, never the same one twice
  delete out.id;
  delete out.ref;
  return out;
};

/**
 * `repeat` turns one spec into a row, a grid, or a ring. A twelve-bolt flange
 * is one description rather than twelve, and it comes out actually even.
 */
const applyRepeat = (spec) => {
  const r = spec.repeat;
  if (!r) return [spec];
  const { repeat: _drop, ...base } = spec;
  const count = Math.max(1, Math.round(num(r.count, 1)));
  const out = [];

  if (r.around) {
    const cx = num(r.around.cx ?? r.around.x, 0);
    const cy = num(r.around.cy ?? r.around.y, 0);
    const from = num(r.from, 0);
    // a full turn repeats the first item on top of the last, so close the gap
    const to = num(r.to, 360 - 360 / count + from);
    const anchorX = num(base.cx, num(base.x, 0) + num(base.width, 0) / 2);
    const anchorY = num(base.cy, num(base.y, 0) + num(base.height, 0) / 2);
    const radius = num(r.radius, Math.hypot(anchorX - cx, anchorY - cy));
    const startAngle = Math.atan2(anchorY - cy, anchorX - cx);

    for (let i = 0; i < count; i += 1) {
      const a = count === 1 ? startAngle : startAngle + rad(from + ((to - from) * i) / Math.max(1, count - 1));
      const copy = shift(base, cx + Math.cos(a) * radius - anchorX, cy + Math.sin(a) * radius - anchorY);
      delete copy.id;
      if (i > 0) delete copy.ref;
      // ribs and teeth want to face outward
      if (r.rotate) copy.angle = num(base.angle, 0) + a - startAngle;
      out.push(copy);
    }
    return out;
  }

  const dx = num(r.dx, 0);
  const dy = num(r.dy, 0);
  const cols = Math.max(1, Math.round(num(r.cols, count)));
  const rows = Math.max(1, Math.round(num(r.rows, Math.ceil(count / cols))));
  let made = 0;
  for (let row = 0; row < rows && made < count; row += 1) {
    for (let col = 0; col < cols && made < count; col += 1) {
      const copy = shift(base, dx * col + num(r.rowDx, 0) * row, dy * row + num(r.colDy, 0) * col);
      delete copy.id;
      if (made > 0) delete copy.ref;
      out.push(copy);
      made += 1;
    }
  }
  return out;
};

const applyMirror = (spec) => {
  const m = spec.mirror;
  if (!m) return [spec];
  const { mirror: _drop, ...base } = spec;
  const axis = m.axis === "horizontal" ? "horizontal" : "vertical";
  const at = num(m.at ?? m.x ?? m.y, 0);
  return m.keep === false ? [flip(base, axis, at)] : [base, flip(base, axis, at)];
};

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Expand macros, then turn parametric types into real elements. Anything this
 * file does not recognise passes through untouched, so ordinary Excalidraw
 * elements are unaffected.
 */
/**
 * `{ "path": { points, closed } }` for `{ "type": "path", points, closed }`.
 *
 * The docs list primitives as `path {points, closed}` and more than one agent
 * has read that as a keyed object rather than a type field. It is unambiguous
 * enough to accept: an entry with no `type`, exactly one key, and that key
 * naming a primitive or element type with an object under it.
 */
const KEYED_TYPES = new Set([
  ...Object.keys(PRIMITIVES),
  "rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw", "frame", "image",
]);
const unwrapKeyed = (spec) => {
  if (spec.type !== undefined) return spec;
  const keys = Object.keys(spec);
  if (keys.length !== 1 || !KEYED_TYPES.has(keys[0])) return spec;
  const inner = spec[keys[0]];
  return inner && typeof inner === "object" && !Array.isArray(inner)
    ? { type: keys[0], ...inner }
    : spec;
};

export function expandSpecs(specs) {
  const out = [];
  const warnings = [];

  for (const raw of specs ?? []) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const spec = unwrapKeyed(raw);
    // mirror before repeat, so a mirrored pair can then be arrayed
    for (const mirrored of applyMirror(spec)) {
      for (const copy of applyRepeat(mirrored)) {
        const make = PRIMITIVES[copy.type];
        if (!make) {
          out.push(copy);
          continue;
        }
        try {
          out.push(make(copy));
        } catch (err) {
          warnings.push(`could not build ${copy.type}: ${err?.message ?? err}`);
        }
      }
    }
  }

  return { specs: out, warnings };
}
