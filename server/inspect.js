/**
 * Layout problems an agent cannot see.
 *
 * Drawing through an API is drawing blind. The mistakes that follow are not
 * subtle - a caption hidden behind the panel next to it, a label wider than the
 * box holding it, a stray element parked ten thousand pixels off to one side -
 * but they are invisible without eyes, and finding them by rendering and
 * squinting costs a round trip every time.
 *
 * This is the cheap pass: geometry in, list of specific problems with element
 * ids out, so a fix is one update_elements call away.
 */

const live = (elements) => (elements ?? []).filter((el) => !el.isDeleted);

const box = (el) => ({
  x: el.x,
  y: el.y,
  right: el.x + (el.width ?? 0),
  bottom: el.y + (el.height ?? 0),
});

const overlaps = (a, b) =>
  a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;

const area = (el) => Math.abs((el.width ?? 0) * (el.height ?? 0));

const round = (n) => Math.round(n);

/**
 * Does this segment pass *through* the box, entering one side and leaving by
 * another?
 *
 * Deliberately not "does it touch": a leader line is supposed to end at its
 * label, so counting an endpoint inside the box as a hit condemns every
 * correctly drawn callout on the sheet. Crossing two edges means the line went
 * in one side and out the other, which is the case worth reporting.
 */
const segmentCrossesBox = ([x1, y1], [x2, y2], b) => {
  const cross = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (d === 0) return false;
    const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
    const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  const edges =
    Number(cross(x1, y1, x2, y2, b.x, b.y, b.right, b.y)) +
    Number(cross(x1, y1, x2, y2, b.right, b.y, b.right, b.bottom)) +
    Number(cross(x1, y1, x2, y2, b.right, b.bottom, b.x, b.bottom)) +
    Number(cross(x1, y1, x2, y2, b.x, b.bottom, b.x, b.y));
  return edges >= 2;
};

export function inspectScene(elements, { limit = 60 } = {}) {
  const all = live(elements);
  const findings = [];
  const add = (severity, kind, message, ids) =>
    findings.push({ severity, kind, message, ids: [].concat(ids) });

  const order = new Map(all.map((el, i) => [el.id, i]));
  const byId = new Map(all.map((el) => [el.id, el]));
  /**
   * Anything that paints a solid area and can therefore hide what is under it.
   *
   * `line` belongs here: every generated polygon and every imported SVG path is
   * a filled line element, so leaving them out meant a scene could be covered in
   * opaque shapes swallowing its labels and this reported nothing wrong.
   */
  const opaque = all.filter(
    (el) =>
      ["rectangle", "ellipse", "diamond", "line", "freedraw"].includes(el.type) &&
      el.backgroundColor &&
      el.backgroundColor !== "transparent" &&
      (el.opacity ?? 100) > 60,
  );

  /* text hidden behind something drawn later ------------------------ */
  for (const text of all.filter((el) => el.type === "text")) {
    const tb = box(text);
    for (const shape of opaque) {
      if (shape.id === text.containerId) continue;
      if (order.get(shape.id) < order.get(text.id)) continue;
      if (!overlaps(tb, box(shape))) continue;
      const sb = box(shape);
      const hidden = Math.min(tb.right, sb.right) - Math.max(tb.x, sb.x);
      if (hidden > 2) {
        add(
          "error",
          "text-hidden",
          `"${text.text.slice(0, 40)}" is covered for ~${round(hidden)}px by a filled ${shape.type} drawn after it. Move the text, shrink the shape, or draw the shape first.`,
          [text.id, shape.id],
        );
      }
      break;
    }
  }

  /* text wider than the panel it sits in ---------------------------- */
  // measured width is an estimate that runs slightly narrow, so overflow is
  // judged with a margin rather than exactly
  const WIDTH_SLACK = 1.08;
  // below this a gap reads as a mistake rather than a deliberate margin
  const PADDING = 8;
  const panels = opaque.filter((el) => el.type === "rectangle" && area(el) > 20000);
  for (const text of all.filter((el) => el.type === "text" && !el.containerId)) {
    const tb = box(text);
    // smallest panel that actually contains the text's origin
    const host = panels
      .filter((p) => {
        const pb = box(p);
        // the origin must be inside on BOTH axes: checking only "right of the
        // left edge" adopted every panel to the left as a host, which reported
        // text as escaping a panel it was never in
        return (
          tb.x >= pb.x - 2 &&
          tb.x <= pb.right &&
          tb.y >= pb.y - 2 &&
          tb.y <= pb.bottom
        );
      })
      .sort((a, b) => area(a) - area(b))[0];
    if (!host) continue;
    const hb = box(host);
    const right = tb.x + (text.width ?? 0) * WIDTH_SLACK - hb.right;
    const bottom = tb.bottom - hb.bottom;
    const escaped = Math.max(right, bottom, hb.x - tb.x, hb.y - tb.y);
    if (escaped > 2) {
      const edge = escaped === right ? "right" : escaped === bottom ? "bottom" : escaped === hb.x - tb.x ? "left" : "top";
      add(
        "warning",
        "text-escapes-panel",
        `"${text.text.slice(0, 40)}" runs ${round(escaped)}px past the ${edge} edge of the panel it sits in. Shorten it, reduce fontSize, or set a width so it wraps.`,
        [text.id, host.id],
      );
    } else if (escaped > -PADDING) {
      // inside, but crowding the edge
      add(
        "info",
        "text-tight",
        `"${text.text.slice(0, 40)}" sits ${round(-escaped)}px from the panel edge. Under ${PADDING}px reads as a mistake rather than a margin.`,
        [text.id, host.id],
      );
    }
  }

  /* labels colliding with each other -------------------------------- */
  const texts = all.filter((el) => el.type === "text" && !el.containerId);
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = box(texts[i]);
      const b = box(texts[j]);
      if (!overlaps(a, b)) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (w > 3 && h > 3) {
        add(
          "error",
          "text-collision",
          `"${texts[i].text.slice(0, 28)}" and "${texts[j].text.slice(0, 28)}" overlap by ${round(w)}x${round(h)}px. Move one.`,
          [texts[i].id, texts[j].id],
        );
      }
    }
  }

  /* leader lines drawn straight through a label ---------------------- */
  /**
   * Only unfilled, short runs count as leaders. A filled polygon that happens
   * to sit under a label is artwork, and it is already covered by text-hidden;
   * counting those turned an illustrated scene into fifty identical warnings,
   * which is the same as no warnings at all.
   */
  const strokes = all.filter(
    (el) =>
      (el.type === "line" || el.type === "arrow") &&
      el.points?.length > 1 &&
      el.points.length <= 8 &&
      (!el.backgroundColor || el.backgroundColor === "transparent"),
  );
  for (const text of texts) {
    const tb = box(text);
    for (const stroke of strokes) {
      let hit = false;
      for (let i = 1; i < stroke.points.length && !hit; i += 1) {
        const p = [stroke.x + stroke.points[i - 1][0], stroke.y + stroke.points[i - 1][1]];
        const q = [stroke.x + stroke.points[i][0], stroke.y + stroke.points[i][1]];
        hit = segmentCrossesBox(p, q, tb);
      }
      if (hit) {
        // a rule spanning the sheet is structure to move away from; a short run
        // is a leader that should have stopped at the label
        const long = Math.max(stroke.width ?? 0, stroke.height ?? 0) > 400;
        add(
          "warning",
          "line-through-text",
          long
            ? `"${text.text.slice(0, 32)}" sits on top of a full-length rule (${round(stroke.width)}x${round(stroke.height)}). Move the label clear of the frame or divider, or break the rule around it.`
            : `A ${stroke.type} runs through "${text.text.slice(0, 32)}". Stop the leader at the edge of the label instead of crossing it.`,
          [text.id, stroke.id],
        );
        break;
      }
    }
  }

  /* bound labels taller than their container ------------------------ */
  for (const text of all.filter((el) => el.containerId)) {
    const container = byId.get(text.containerId);
    if (!container) {
      add("error", "orphan-label", `A bound label points at a container that is not in the scene.`, [text.id]);
      continue;
    }
    if ((text.height ?? 0) > (container.height ?? 0) - 6) {
      add(
        "warning",
        "label-too-tall",
        `The label on this ${container.type} needs ${round(text.height)}px but the container is ${round(container.height)}px. Excalidraw clips it - make the container taller.`,
        [text.id, container.id],
      );
    }
  }

  /* degenerate shapes ----------------------------------------------- */
  for (const el of all) {
    if (el.type === "text") continue;
    const w = Math.abs(el.width ?? 0);
    const h = Math.abs(el.height ?? 0);
    if (w < 1 && h < 1) {
      add("warning", "zero-size", `A ${el.type} has no size (${round(w)}x${round(h)}) and will not be visible.`, el.id);
    }
  }

  /* broken arrow bindings ------------------------------------------- */
  for (const el of all.filter((e) => e.type === "arrow")) {
    for (const key of ["startBinding", "endBinding"]) {
      const target = el[key]?.elementId;
      if (target && !byId.has(target)) {
        add("error", "dangling-binding", `An arrow's ${key} points at an element that no longer exists.`, el.id);
      }
    }
  }

  /* strays parked far from everything else --------------------------- */
  if (all.length > 6) {
    const cx = all.map((el) => el.x + (el.width ?? 0) / 2).sort((a, b) => a - b);
    const cy = all.map((el) => el.y + (el.height ?? 0) / 2).sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.floor(arr.length * p)];
    const [x1, x3] = [q(cx, 0.25), q(cx, 0.75)];
    const [y1, y3] = [q(cy, 0.25), q(cy, 0.75)];
    const padX = Math.max(600, (x3 - x1) * 3);
    const padY = Math.max(600, (y3 - y1) * 3);
    for (const el of all) {
      const mx = el.x + (el.width ?? 0) / 2;
      const my = el.y + (el.height ?? 0) / 2;
      if (mx < x1 - padX || mx > x3 + padX || my < y1 - padY || my > y3 + padY) {
        add("warning", "stray", `A ${el.type} sits far away from everything else, at ${round(el.x)},${round(el.y)}.`, el.id);
      }
    }
  }

  /* exact duplicates ------------------------------------------------- */
  const seen = new Map();
  for (const el of all) {
    // the end point matters: two mirrored radials share an anchor and a
    // bounding box while going opposite ways, and calling those duplicates
    // condemned every symmetric web lattice on the sheet
    const end = el.points?.length ? el.points[el.points.length - 1].map(round).join(",") : "";
    const key = [el.type, round(el.x), round(el.y), round(el.width ?? 0), round(el.height ?? 0), end, el.text ?? ""].join("|");
    const first = seen.get(key);
    if (first) {
      add("warning", "duplicate", `Two ${el.type} elements sit exactly on top of each other.`, [first, el.id]);
    } else {
      seen.set(key, el.id);
    }
  }

  const bySeverity = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => bySeverity[a.severity] - bySeverity[b.severity]);

  const counts = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  /**
   * Capped per kind. Fifty instances of one problem is one problem with fifty
   * instances, and a wall of identical lines buries the other findings - the
   * count is in `counts` either way.
   */
  const PER_KIND = 6;
  const kindTally = {};
  const shown = findings.filter((f) => {
    kindTally[f.kind] = (kindTally[f.kind] ?? 0) + 1;
    return kindTally[f.kind] <= PER_KIND;
  });

  return {
    elements: all.length,
    problems: findings.length,
    counts,
    truncated: shown.length < findings.length,
    findings: shown.slice(0, limit),
  };
}
