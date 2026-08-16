/**
 * The hand-drawn contract, in code.
 *
 * Why this file exists: an SVG path or a generated curve flattens to sixty or
 * eighty points a few pixels apart, and rough.js (which is what Excalidraw
 * draws with) wobbles each segment on its own. On segments that short the
 * wobble is a fuzz along the edge - roughness 1 comes out looking like a
 * precise vector line with a furry outline, and the drawing reads as clip-art
 * dropped onto the canvas. A line someone drew by hand has far fewer anchors,
 * fifteen to twenty pixels apart, and each segment gets one confident bow.
 *
 * So anything generated - imported SVG, parametric curves - passes through
 * here before it becomes an element: points are re-spaced along the arc at a
 * hand-sized step, curved runs are told to draw as curves, and fills default to
 * hachure. That is the whole difference between "vector art" and "Excalidraw".
 */

/** How far apart anchors sit on a curve someone drew by hand, in scene px. */
export const SKETCH_STEP = 18;

/** Below this area a hachure fill is just noise; solid reads better. */
export const HACHURE_MIN_AREA = 400;

/**
 * Default fill for generated shapes. Solid, as in Excalidraw itself: the
 * sketchy stroke is what makes a drawing hand-drawn, and solid keeps small
 * detail legible on a piece with many parts. Hachure is one option away for a
 * lighter, sketchier piece.
 */
export const SKETCH_FILL = "solid";

const isClosed = (pts) =>
  pts.length > 2 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];

/**
 * Re-space a polyline at roughly `step` units along its length, keeping the
 * first and last points (and so the closure) exactly. Never returns fewer
 * points than a closed loop needs to still look like its shape.
 */
export const resample = (pts, step = SKETCH_STEP) => {
  if (!Array.isArray(pts) || pts.length < 3) return pts;
  const closed = isClosed(pts);
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  if (total === 0) return pts;
  const n = Math.max(closed ? 6 : 2, Math.round(total / step));
  if (n >= pts.length - 1) return pts; // already coarser than the step

  const target = total / n;
  const out = [pts[0]];
  let prev = pts[0];
  let acc = 0;
  let i = 1;
  while (i < pts.length && out.length < n) {
    const seg = Math.hypot(pts[i][0] - prev[0], pts[i][1] - prev[1]);
    if (acc + seg >= target) {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      const p = [prev[0] + (pts[i][0] - prev[0]) * t, prev[1] + (pts[i][1] - prev[1]) * t];
      out.push(p);
      prev = p;
      acc = 0;
    } else {
      acc += seg;
      prev = pts[i];
      i += 1;
    }
  }
  const last = pts.at(-1);
  const tail = out.at(-1);
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
};

/**
 * Snap a stroke width to the three Excalidraw actually offers. Anything else
 * renders, but 3px and 5px strokes are the tell of a converted file.
 */
export const snapStrokeWidth = (w) => (w < 1.5 ? 1 : w < 3 ? 2 : 4);

/**
 * Give a line spec the hand-drawn treatment. Absolute points in, spec out.
 *
 *   curved   the run came from real curves: re-space it and draw as a curve
 *            (a rectangle or polygon stays on its own corners)
 *   step     anchor spacing, scene px
 *   fill     fillStyle for filled shapes; default solid. hachure/cross-hatch
 *            apply only above HACHURE_MIN_AREA, small shapes stay solid
 */
export const sketchLine = (spec, { curved = true, step = SKETCH_STEP, fill } = {}) => {
  const out = { ...spec };
  if (curved) {
    // points are relative to the element origin; the origin is points[0]
    out.points = resample(out.points, step);
    if (out.roundness === undefined || out.roundness === null) out.roundness = { type: 2 };
  } else if (out.roundness === undefined) {
    out.roundness = null;
  }
  if (out.roughness === undefined) out.roughness = 1;
  const filled = out.backgroundColor && out.backgroundColor !== "transparent";
  if (filled && (out.fillStyle === undefined || fill)) {
    out.fillStyle = fillFor(fill, (out.width ?? 0) * (out.height ?? 0));
  }
  return out;
};

/** The fill a generated shape of `area` px² gets for a requested style. */
export const fillFor = (fill, area) => {
  const wanted = fill ?? SKETCH_FILL;
  return wanted !== "solid" && area < HACHURE_MIN_AREA ? "solid" : wanted;
};
