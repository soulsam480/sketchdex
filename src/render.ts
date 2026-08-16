import { FONT_FAMILY, exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

/**
 * Headless render target, loaded by mcp/render-main.js in a hidden window.
 *
 * The library thumbnails are SVG scaled into a small card, which is why strokes
 * in them read as heavier or lighter than they really are. This goes through
 * Excalidraw's own canvas export instead, at real size, so what an agent looks
 * at is what the editor draws.
 *
 * The page fetches its scene rather than having it injected, because scenes with
 * embedded images run to several megabytes and that is not something to push
 * through executeJavaScript.
 */

const params = new URLSearchParams(window.location.search);
const numberParam = (key: string, fallback: number) => {
  const value = Number(params.get(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * The result is left on `window` for the Electron parent to read rather than
 * posted anywhere, so this page works unchanged against the normal dev server -
 * no second port just to carry an image back.
 */
const post = (body: unknown) => {
  (window as any).__sketchdexShot = body;
};

/**
 * ?measure=1: no scene at all. Load every Excalidraw font family and report
 * the real advance width of each character, per px of font size, so the server
 * can lay text out with the same numbers the canvas uses. Written once by
 * scripts/measure-fonts.mjs into server/font-metrics.json; there is no canvas
 * in the server to measure with, and an estimate that runs a few percent short
 * is a caption clipped mid-word.
 */
const measure = async () => {
  const families = Object.entries(FONT_FAMILY) as [string, number][];
  // exporting a text element per family is what makes Excalidraw load the font
  await exportToBlob({
    elements: families.map(([, id], i) => ({
      id: `m${id}`,
      type: "text",
      x: 0,
      y: i * 40,
      width: 100,
      height: 25,
      text: "measure",
      originalText: "measure",
      fontSize: 20,
      fontFamily: id,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      angle: 0,
      strokeColor: "#000",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
      containerId: null,
      autoResize: true,
    })) as any,
    appState: { exportBackground: false } as any,
    files: {},
  });
  await (document as any).fonts.ready;

  const SIZE = 100;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  // Latin, Latin-1, Latin Extended-A, plus the punctuation prose actually uses
  const chars: string[] = [];
  for (let c = 32; c < 0x250; c += 1) chars.push(String.fromCodePoint(c));
  for (const c of "‘’“”–—…•€→←↑↓×÷°·") chars.push(c);
  const samples = [
    "the quick brown fox jumps over the lazy dog",
    "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG",
    "Missile casings for plate. Wiring",
    "from the Jericho. Built in a cave.",
    "0123456789 !?()[]{};:,.'\"",
  ];
  const out: Record<string, any> = {};
  for (const [name, id] of families) {
    ctx.font = `${SIZE}px "${name}"`;
    const advance: Record<string, number> = {};
    for (const ch of chars) advance[ch] = ctx.measureText(ch).width / SIZE;
    const sample: Record<string, number> = {};
    for (const text of samples) sample[text] = ctx.measureText(text).width / SIZE;
    out[id] = { name, advance, sample };
  }
  post({ metrics: out });
};

const run = async () => {
  if (params.get("measure") === "1") return measure();
  // ?scene=<id> reads through the normal API; /__payload is the fallback the
  // throwaway server uses when no dev server is running
  const sceneId = params.get("scene");
  const payload = await fetch(
    sceneId ? `/api/scenes/${sceneId}` : "/__payload",
  ).then((res) => res.json());
  let elements = (payload.elements ?? []).filter((el: any) => !el.isDeleted);

  /**
   * Narrowing before export is what makes a sprawling board readable: the
   * bounds are computed from whatever survives this filter, so asking for a
   * region crops to it rather than shrinking the whole canvas to fit.
   */
  const only = params.get("only");
  if (only) {
    const wanted = new Set(only.split(","));
    elements = elements.filter((el: any) => wanted.has(el.id));
  }

  const region = params.get("region");
  let clip: { x: number; y: number; width: number; height: number } | null = null;
  if (region) {
    const [rx, ry, rw, rh] = region.split(",").map(Number);
    clip = { x: rx, y: ry, width: rw, height: rh };
    elements = elements.filter(
      (el: any) =>
        el.x + el.width >= rx &&
        el.y + el.height >= ry &&
        el.x <= rx + rw &&
        el.y <= ry + rh,
    );
  }

  // a bound label whose container was filtered out would render orphaned
  const present = new Set(elements.map((el: any) => el.id));
  elements = elements.filter(
    (el: any) => !el.containerId || present.has(el.containerId),
  );

  if (!elements.length) {
    post({ error: only || region ? "nothing matched that filter" : "the scene is empty" });
    return;
  }

  const dark = params.get("dark") === "1";
  const scale = Math.min(3, numberParam("scale", 1));
  const maxWidth = numberParam("maxWidth", 1400);
  const inlineLimit = numberParam("inlineLimit", 150_000);
  const tiles = Math.min(8, Math.round(numberParam("tiles", 1)));

  const appState = {
    ...payload.appState,
    exportBackground: true,
    exportWithDarkMode: dark,
    viewBackgroundColor: payload.appState?.viewBackgroundColor ?? "#ffffff",
  };

  const PADDING = 24;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements as any);

  /**
   * One export of everything that survived the filter, scaled so that `target`
   * scene px (the box the caller wants to look at) fits in `cap` device px.
   * Everything below crops out of this bitmap.
   */
  const exportAt = async (target: number, cap: number) => {
    let factor = 1;
    const blob = await exportToBlob({
      elements,
      appState,
      files: payload.files ?? {},
      exportPadding: PADDING,
      mimeType: "image/png",
      getDimensions: (width: number, height: number) => {
        factor = Math.max(0.1, Math.min(scale, cap / target));
        // Chromium will not allocate a canvas past roughly 16k on a side
        factor = Math.min(factor, 16000 / Math.max(width, height));
        return {
          width: Math.round(width * factor),
          height: Math.round(height * factor),
          scale: factor,
        };
      },
    });
    return { bitmap: await createImageBitmap(blob), factor };
  };

  /**
   * Cut a scene-space box out of an export. `shrink` < 1 draws the crop smaller
   * than the source pixels, which is how an over-budget tile is made to fit
   * without a second export.
   */
  const crop = (
    bitmap: ImageBitmap,
    factor: number,
    box: { x: number; y: number; width: number; height: number },
    mimeType: string,
    shrink = 1,
  ): Promise<Blob> => {
    const sx = Math.round((box.x - minX + PADDING) * factor);
    const sy = Math.round((box.y - minY + PADDING) * factor);
    const sw = Math.round(box.width * factor);
    const sh = Math.round(box.height * factor);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * shrink));
    canvas.height = Math.max(1, Math.round(sh * shrink));
    const ctx = canvas.getContext("2d")!;
    // paper under the parts of the box that lie outside the exported bounds
    ctx.fillStyle = appState.viewBackgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error("crop failed"))),
        mimeType,
        0.82,
      ),
    );
  };

  const encode = async (blob: Blob) => {
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const bitmap = await createImageBitmap(blob);
    return { dataUrl, width: bitmap.width, height: bitmap.height };
  };

  /**
   * A full-resolution render can be far too large to travel in a tool result,
   * and a caller left with only a file path has nothing to look at until it
   * goes and reads the file. So when the full image will not fit, a smaller
   * one is drawn from the same export and sent alongside the path.
   *
   * The preview is JPEG, not PNG. It exists to be looked at, so losing a
   * little fidelity is free, and it is the difference between fitting and
   * not: a scene carrying embedded photos stays enormous as a PNG however far
   * it is scaled down, because the photo data is the size, not the
   * dimensions. PNG size grows with roughly the square of the long edge, so
   * the shrink is the square root of how far over budget it is, with a
   * margin; dense scenes compress worse than that predicts, hence the retries.
   */
  const preview = async (
    full: { dataUrl: string; width: number; height: number },
    redraw: (shrink: number, mime: string) => Promise<Blob>,
  ) => {
    if (full.dataUrl.length <= inlineLimit) return null;
    let out: { dataUrl: string; width: number; height: number } | null = null;
    let shrink = 1;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const over = (out ?? full).dataUrl.length / inlineLimit;
      if (over <= 1) break;
      const longEdge = Math.max(full.width, full.height) * shrink;
      const next = Math.max(280, Math.floor((longEdge / Math.sqrt(over)) * 0.9));
      shrink = next / Math.max(full.width, full.height);
      out = await encode(await redraw(shrink, "image/jpeg"));
      if (next <= 280) break;
    }
    if (out && out.dataUrl.length > inlineLimit) return null;
    return out ? { ...out, mime: "image/jpeg" } : null;
  };

  /**
   * Tiles: a tall or wide page split along its long axis, all cut from one
   * export, so a whole board comes back as a few readable pictures instead of
   * one unreadable one. Each tile carries the scene box it shows, so a caller
   * can go straight from "that looks off" to a region render or an edit.
   */
  if (!clip && tiles > 1) {
    const width = maxX - minX;
    const height = maxY - minY;
    const tall = height >= width;
    const OVERLAP = 24;
    const step = (tall ? height : width) / tiles;
    const boxes = Array.from({ length: tiles }, (_, i) => {
      // paper margin on the outer edges, a little overlap between neighbours
      const from = i * step - (i ? OVERLAP : PADDING);
      const to = i === tiles - 1 ? (tall ? height : width) + PADDING : (i + 1) * step + OVERLAP;
      return tall
        ? { x: minX - PADDING, y: minY + from, width: width + PADDING * 2, height: to - from }
        : { x: minX + from, y: minY - PADDING, width: to - from, height: height + PADDING * 2 };
    });
    const target = Math.max(boxes[0].width, boxes[0].height);
    const { bitmap, factor } = await exportAt(target, maxWidth);
    const out = [];
    for (const box of boxes) {
      const full = await encode(await crop(bitmap, factor, box, "image/png"));
      const small = await preview(full, (shrink, mime) => crop(bitmap, factor, box, mime, shrink));
      out.push({ ...full, preview: small, region: box });
    }
    post({
      tiles: out,
      width: Math.round((width + PADDING * 2) * factor),
      height: Math.round((height + PADDING * 2) * factor),
    });
    return;
  }

  const box = clip ?? {
    x: minX - PADDING,
    y: minY - PADDING,
    width: maxX - minX + PADDING * 2,
    height: maxY - minY + PADDING * 2,
  };
  const { bitmap, factor } = await exportAt(Math.max(box.width, box.height), maxWidth);
  const full = await encode(await crop(bitmap, factor, box, "image/png"));
  const small = await preview(full, (shrink, mime) => crop(bitmap, factor, box, mime, shrink));
  post({ ...full, preview: small });
};

run().catch((err) => post({ error: String(err?.message ?? err) }));
