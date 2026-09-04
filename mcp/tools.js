import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { renderScene } from "./render.js";

/**
 * The Sketchdex tool set, independent of how it is transported.
 *
 * mcp/server.js serves this over stdio, which is what Claude Code and Codex
 * use. server/middleware.js serves the same thing over HTTP at /mcp on the dev
 * server, for clients that only speak to a URL. One definition either way.
 *
 * Two things shape the tool list:
 *
 * 1. Nothing here is a ceiling. `add_elements` accepts shorthand for the common
 *    case, but any field of a real Excalidraw element passes straight through,
 *    and `read_scene` / `replace_scene` work in whole raw element arrays. The
 *    scene file path is handed out too, for edits no tool here covers.
 *
 * 2. Edits are cheap to *describe*. The expensive part of agent editing is
 *    pulling a scene through a context window, not rewriting the file, so the
 *    granular tools take deltas: `update_elements` moves one box by sending one
 *    id and one number, and the server does the read-modify-write locally.
 */

/**
 * How much a single tool result may carry.
 *
 * Clients truncate an over-long reply mid-string rather than rejecting it, so it
 * arrives as unparseable JSON. Two ceilings have been seen in the wild, 384 KiB
 * and 320 KiB, on the same client - it is not a fixed number, so the only safe
 * play is to stay far below the lowest one rather than just under it.
 *
 * Override with SKETCHDEX_INLINE_LIMIT if a client turns out to be stricter.
 */
const INLINE_IMAGE_LIMIT = Number(process.env.SKETCHDEX_INLINE_LIMIT) || 150_000;

/**
 * Reported to clients on connect and by sketchdex_info. A long-lived stdio
 * process keeps whatever code it started with, so this is how you tell whether
 * the thing you are talking to is the build you just changed.
 */
export const VERSION = createRequire(import.meta.url)("../package.json").version;

/** Same reasoning, for tool results that are text rather than an image. */
const TEXT_LIMIT = 120_000;

const SCENE = {
  type: "string",
  description:
    "Scene id, exact name, or a unique part of the name. Use list_scenes if unsure.",
};

/**
 * Server-level instructions: the one paragraph every client shows the model
 * before any tool is called. Routing and the look, nothing else - the tools
 * carry their own detail.
 */
export const INSTRUCTIONS = [
  "Sketchdex draws on the user's Excalidraw canvases; scenes are real .excalidraw",
  "files, every write is snapshotted, and `label` is required on every write.",
  "Everything must look HAND-DRAWN - it is Excalidraw: roughness 1, sparse",
  "confident strokes, flat solid colour (no shading, no cross-hatch texture),",
  "hand-drawn font, colours exactly as written (never inverted), dark paper by",
  "default. To draw anything that has to look like",
  "something - a character, object, illustration - write it as ONE SVG and call",
  "import_svg; never assemble a figure from shapes. Use add_elements for",
  "diagrams, text, boxes, arrows and detail strokes. describe_scene before you",
  "draw, render_scene after, and fix what looks wrong.",
].join(" ");

const LABEL = {
  type: "string",
  description:
    "Short description of what this change is doing, e.g. 'add the dog illustration'. Shown next to the snapshot in the history sidebar, which is how the user decides whether to keep or revert it. Always set it.",
};

/**
 * The element shape is documented rather than schema-constrained on purpose: a
 * closed schema would make this file the limit of what an agent can draw, and
 * Excalidraw gains element types faster than this file will.
 */
const ELEMENT_ARRAY = {
  type: "array",
  description: [
    "Excalidraw elements. Any field of a real element is honoured verbatim; what",
    "you omit gets a valid default (id, index, seed, version are generated).",
    "",
    "USE THIS FOR diagrams, layout, text, boxes, arrows, and detail strokes on top",
    "of something already drawn. For anything that has to LOOK LIKE something - a",
    "character, creature, object, vehicle, logo, illustration - do NOT assemble it",
    "from shapes here. Write it as one SVG and call import_svg. Shapes stacked by",
    "hand come out as a pile of parts (fat, seamed, toy-like) every time; one SVG",
    "comes out as one drawing.",
    "",
    "Types: rectangle ellipse diamond arrow line text freedraw frame.",
    "Fields: x y width height angle, strokeColor, backgroundColor (the fill),",
    "fillStyle solid|hachure|cross-hatch, strokeWidth 1|2|4, strokeStyle,",
    "roughness 0|1|2, opacity, roundness, fontSize, fontFamily (5 hand-drawn),",
    "textAlign, groupIds, points [[0,0],[dx,dy],...] relative. y points down.",
    "TEXT WRAPS: give a text element a `width` and prose is wrapped to it with",
    "the real font metrics (height follows); no width = one line per \\n, sized",
    "exactly. Never break long paragraphs by hand.",
    "",
    "THE LOOK IS HAND-DRAWN. This is Excalidraw. roughness 1 (default) on",
    "everything; native rectangle/ellipse/arrow rather than 4-point lines; sparse",
    "points with roundness {type:2} for a curve (dense points look furry, not",
    "sketchy); hand-drawn font. Detail is a few extra strokes, never more parts.",
    "",
    "COLOUR IS FLAT. Solid fills, one colour per part, and the wobbly outline",
    "does the rest - that is the Excalidraw look. Do not shade: no hachure or",
    "cross-hatch as texture, no gradients faked with stacked shapes, no drop",
    "shadows. If a part must read as darker, give it a darker solid hex. Reserve",
    "hachure/cross-hatch for something that IS hatched (a cutaway, a glass pane).",
    "",
    "PAPER AND INK. Nothing is inverted for display: every hex shows exactly as",
    "written. New scenes are dark paper (#121212). Anything drawn without a",
    "strokeColor gets ink that contrasts with the paper (#e9ecef on dark, #1e1e1e",
    "on light); describe_scene reports `background` and `ink`. Any hex is fine -",
    "character colours are character colours on any paper.",
    "",
    "SHORTHAND. label on a shape adds centred bound text; ref names an element",
    "and start/end on an arrow bind to it. Generated geometry is an element whose",
    "type is polygon|star|arc|capsule|path, e.g.",
    "  {\"type\":\"path\",\"points\":[[0,0],[40,30],[90,10]],\"closed\":true}  smooth curve through the points",
    "  polygon {sides,cx,cy,r}  star {points,cx,cy,r,innerRatio}  arc {cx,cy,r,from,to}  capsule {x,y,width,height,radius}",
    "repeat {count,dx,dy | cols,rows | around:{cx,cy}} and mirror {axis:'vertical',at}",
    "multiply one spec evenly. These are for furniture - rings, plates, arrays -",
    "not for bodies.",
  ].join("\n"),
  items: { type: "object", additionalProperties: true },
};

const TOOLS = [
  {
    name: "list_scenes",
    description:
      "Every scene in the vault with its id, name, element count and last-edited time. Start here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_scene",
    description:
      "What is on a scene, as structure rather than pixels: counts by type, overall bounds, and a rounded summary of each element with its id, position, size, text and bindings. Cheaper than read_scene and usually enough to plan an edit.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        type: { type: "string", description: "Only elements of this type." },
        limit: { type: "number", description: "Max elements to list (default 400)." },
      },
      required: ["scene"],
    },
  },
  {
    name: "read_elements",
    description:
      "Full, unabridged elements, filtered down to the ones you need. Use this rather than read_scene when editing a few things in a busy scene.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        ids: { type: "array", items: { type: "string" } },
        type: { type: "string" },
        contains: { type: "string", description: "Only elements whose text contains this." },
        region: {
          type: "object",
          description: "Only elements overlapping this box.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        limit: { type: "number", description: "Default 100." },
      },
      required: ["scene"],
    },
  },
  {
    name: "read_scene",
    description:
      "The whole scene exactly as stored, plus the path to the .excalidraw file on disk. Large scenes run to thousands of elements, so prefer describe_scene or read_elements unless you genuinely need everything. The path is there for edits no tool here covers - take a snapshot first if you use it.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        includeFiles: {
          type: "boolean",
          description:
            "Include the embedded image map. Off by default: it is base64 and usually megabytes.",
        },
      },
      required: ["scene"],
    },
  },
  {
    name: "create_scene",
    description: "Make a new scene, optionally with its starting elements.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, elements: ELEMENT_ARRAY },
    },
  },
  {
    name: "add_elements",
    description:
      "Append elements to a scene, leaving everything already there untouched. The usual way to draw something new.",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE, elements: ELEMENT_ARRAY, label: LABEL },
      required: ["scene", "elements", "label"],
    },
  },
  {
    name: "update_elements",
    description:
      "Change named fields on existing elements. Send only what changes - {id, x: 40} moves one box and leaves its other 25 fields alone. Pass a list in `elements`, each carrying its `id`, or use `ids` + `patch` to apply one change across many.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        elements: {
          type: "array",
          description: "Partial elements, each with an `id` and the fields to change.",
          items: { type: "object", additionalProperties: true },
        },
        ids: { type: "array", items: { type: "string" } },
        patch: { type: "object", additionalProperties: true },
        label: LABEL,
      },
      required: ["scene", "label"],
    },
  },
  {
    name: "delete_elements",
    description: "Remove elements by id.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        ids: { type: "array", items: { type: "string" } },
        label: LABEL,
      },
      required: ["scene", "ids", "label"],
    },
  },
  {
    name: "move_elements",
    description:
      "Shift a set of elements by dx, dy in one write, keeping everything else about them. Select by ids, groupIds (an import_svg piece), a region box, or any mix; a container's label always moves with it. Include an arrow together with what it points at, or it is left behind. Returns the new bounds of what moved.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        ids: { type: "array", items: { type: "string" } },
        groupIds: { type: "array", items: { type: "string" } },
        region: {
          type: "object",
          description: "Everything overlapping this box moves.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        dx: { type: "number", description: "Scene px to the right (negative = left)." },
        dy: { type: "number", description: "Scene px down (negative = up)." },
        label: LABEL,
      },
      required: ["scene", "label"],
    },
  },
  {
    name: "replace_scene",
    description:
      "Replace a scene's entire contents. Destructive by design - the previous state is snapshotted, but prefer add_elements or update_elements when you only mean to change part of it.",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE, elements: ELEMENT_ARRAY, label: LABEL },
      required: ["scene", "elements", "label"],
    },
  },
  {
    name: "set_background",
    description:
      "Set the paper: the scene's real background colour, shown exactly as given (never inverted). The default pen for hand drawing follows it, so the next stroke in the app is visible. Elements already drawn keep their colours - recolour their ink yourself if you flip a scene from light to dark or back. New scenes start on dark paper (#121212).",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE, color: { type: "string" }, label: LABEL },
      required: ["scene", "color", "label"],
    },
  },
  {
    name: "render_scene",
    description:
      "A PNG of the scene as it actually renders, so you can look at what you drew. Use it to check your own work - proportions, overlaps, whether the thing reads as the thing. Always written to a file as well as returned. A tall or wide page (long edge more than about twice the short one, and too big to fit at the asked size) comes back as a few tiles cut along its length, each with the scene box it shows, so a whole board is readable in one call; a `region` renders just that box, which is the way to look closely at one part. When an image is too big to travel inline you get a downscaled preview plus the file path.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        scale: { type: "number", description: "Pixel density, 1-3. Default 1." },
        maxWidth: {
          type: "number",
          description:
            "Cap the long edge in pixels. Default 1400. Above ~1200 the result is a file path instead of an inline image.",
        },
        region: {
          type: "object",
          description:
            "Render only what overlaps this box, in scene coordinates. Take the numbers from describe_scene's `bounds`.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
        ids: {
          type: "array",
          description: "Render only these elements.",
          items: { type: "string" },
        },
        transparent: {
          type: "boolean",
          description: "Leave the paper out of the PNG (alpha background). For dropping a sketch onto a slide or a page.",
        },
        tiles: {
          type: "number",
          description:
            "Split the picture into this many tiles along its long axis (max 8). Default: chosen from the shape of the scene, 1 for anything roughly square. Pass 1 to force a single image.",
        },
      },
      required: ["scene"],
    },
  },
  {
    name: "import_svg",
    description: [
      "Draw by writing SVG. THE way to draw anything that has to look like",
      "something: a character, creature, object, vehicle, logo, illustration.",
      "This is what produces good figures; stacking shapes with add_elements does",
      "not.",
      "",
      "The result is hand-drawn, not pasted: every path becomes a real editable",
      "Excalidraw element (grouped as one piece), curves are re-spaced to",
      "hand-sized strokes and drawn with the sketchy pen, <circle>/<ellipse>/<rect>",
      "become native shapes. Write the SVG for SHAPE, PROPORTION and COLOUR and let",
      "the canvas supply the pen - do not fake wobble or hatching in the SVG.",
      "",
      "A recipe that works for a figure:",
      "  * viewBox about 300 x 600 for a standing figure; import at width 350-450.",
      "  * ONE closed path per body region - torso, each leg, each arm - tapered",
      "    like a real limb (forearm ~60% of the upper arm, calf into a narrow",
      "    ankle), plus head, hands, feet. Let them overlap; later paths draw on",
      "    top. Then detail as separate strokes OVER the silhouette: plates, seams,",
      "    webbing, a knee line. A few, not many.",
      "  * Every shape: fill=<vibrant, character-accurate hex> stroke=<the scene",
      "    ink from describe_scene, or a deep shade of the fill> stroke-width 2 to",
      "    2.5. Filled shapes with no stroke read as flat.",
      "  * Flat colour, no shading. One solid fill per part; a darker part is a",
      "    darker hex, not a hatched overlay or a shadow shape. The sketchy",
      "    outline carries the drawing - texture on top of it looks overworked.",
      "  * Proportion from a rule: 7-8 heads tall for heroic, 5-6 for stylised.",
      "    Head first, derive the rest.",
      "  * Then render_scene and LOOK; fix what is off. The first pass is usually",
      "    mis-proportioned, the second is right.",
      "",
      "Supported: path (all commands), rect, circle, ellipse, line, polyline,",
      "polygon, g, transform, <style>/class, <use>/<defs>, presentation attributes,",
      "text. viewBox honoured exactly. Gradients flatten to their first stop; pass",
      "holeColor to punch compound-path holes.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        svg: {
          type: "string",
          description: "Complete SVG markup, including the <svg> element and its viewBox.",
        },
        x: { type: "number", description: "Where to place it on the canvas. Default 0." },
        y: { type: "number", description: "Default 0." },
        width: {
          type: "number",
          description:
            "Scale the artwork to this width, keeping its aspect ratio. Height follows.",
        },
        height: { type: "number", description: "Optional bound on height." },
        tolerance: {
          type: "number",
          description:
            "Curve flattening, in source units. Default 3. Lower is smoother and heavier.",
        },
        style: {
          type: "string",
          enum: ["sketch", "precise"],
          description:
            "sketch (default): hand-drawn treatment - anchors re-spaced, curves as curves, roughness 1, native circles/rects. precise: every flattened vertex kept, roughness 0 - for a logo or a drawing that must be exact.",
        },
        fillStyle: {
          type: "string",
          enum: ["hachure", "cross-hatch", "solid"],
          description:
            "Fill for every filled shape. Default solid. hachure for a lighter, sketchier piece (small shapes stay solid); cross-hatch for weight.",
        },
        roughness: {
          type: "number",
          description:
            "0 precise, 1 sketchy (default in sketch mode), 2 very sketchy.",
        },
        step: {
          type: "number",
          description:
            "Anchor spacing for curves in sketch mode, in canvas px. Default 18. Lower keeps more of the source curve; higher is looser.",
        },
        holeColor: {
          type: "string",
          description: "Backdrop colour used to punch compound-path holes.",
        },
        group: {
          type: "boolean",
          description: "Group the result as one unit. Default true.",
        },
        label: LABEL,
      },
      required: ["scene", "svg", "label"],
    },
  },
  {
    name: "check_scene",
    description:
      "Find layout problems by geometry instead of by looking: text hidden behind a filled shape drawn after it, captions running past the panel they sit in, labels too tall for their container, zero-size elements, broken arrow bindings, strays parked far off, exact duplicates. Each finding carries the element ids, so the fix is one update_elements call. Run it after a batch of drawing - it is far cheaper than a render and catches what a render would only show you if you looked closely.",
    inputSchema: {
      type: "object",
      properties: {
        scene: SCENE,
        limit: { type: "number", description: "Max findings (default 60)." },
      },
      required: ["scene"],
    },
  },
  {
    name: "sketchdex_info",
    description:
      "Version of this server, where it is running from, which vault it is using, and how long this process has been alive. Use it to confirm you are talking to the build you think you are.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "snapshot_scene",
    description:
      "Stash the current state without changing anything, so it can be restored from the history sidebar. Do this before editing a .excalidraw file directly with your own file tools - every other tool here snapshots on its own.",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE, label: LABEL },
      required: ["scene", "label"],
    },
  },
  {
    name: "list_history",
    description: "Snapshots held for a scene, newest first.",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE },
      required: ["scene"],
    },
  },
  {
    name: "restore_snapshot",
    description:
      "Put a snapshot back on the canvas. This is itself snapshotted, so reverting a revert is possible.",
    inputSchema: {
      type: "object",
      properties: { scene: SCENE, snapshot: { type: "string" } },
      required: ["scene", "snapshot"],
    },
  },
];

const makeHandlers = (api) => ({
  list_scenes: () => api.listScenes(),
  describe_scene: (a) => api.describeScene(a.scene, a),
  read_elements: (a) => api.readElements(a.scene, a),
  read_scene: (a) => api.readScene(a.scene, a),
  create_scene: (a) => api.createScene(a),
  add_elements: (a) => api.addElements(a.scene, a.elements, a),
  update_elements: (a) => api.updateElements(a.scene, a.elements, a),
  delete_elements: (a) => api.deleteElements(a.scene, a.ids, a),
  move_elements: (a) => api.moveElements(a.scene, a),
  replace_scene: (a) => api.replaceElements(a.scene, a.elements, a),
  set_background: (a) => api.setBackground(a.scene, a.color, a),
  import_svg: (a) => api.importSvg(a.scene, a.svg, a),
  check_scene: (a) => api.checkScene(a.scene, a),
  sketchdex_info: async () => ({
    version: VERSION,
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    uptimeMinutes: Math.round(process.uptime() / 60),
    server: fileURLToPath(new URL("server.js", import.meta.url)),
    vault: api.vault,
    node: process.version,
  }),
  snapshot_scene: (a) => api.snapshot(a.scene, a.label),
  list_history: (a) => api.listHistory(a.scene),
  restore_snapshot: (a) => api.restoreSnapshot(a.scene, a.snapshot),
  render_scene: async (a) => {
    const scene = await api.readScene(a.scene, { includeFiles: true });

    /**
     * A page that is much taller than it is wide (or the reverse) cannot be
     * looked at as one image: shrunk to fit it is unreadable, at full size it
     * does not travel. So by default it is cut into tiles along its length,
     * each about as wide as it is tall. A region or an id list is already a
     * choice about what to look at, so those are never tiled unasked.
     */
    let tiles = a.tiles;
    if (tiles === undefined && !a.region && !a.ids?.length) {
      const live = (scene.elements ?? []).filter((el) => !el.isDeleted);
      if (live.length) {
        const xs = live.flatMap((el) => [el.x, el.x + (el.width ?? 0)]);
        const ys = live.flatMap((el) => [el.y, el.y + (el.height ?? 0)]);
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
        // a page that fits in one image at the asked size loses nothing by
        // staying one image; tiling is only for what would have to shrink
        const fits = Math.max(w, h) * (a.scale ?? 1) <= (a.maxWidth ?? 1400);
        tiles = !fits && aspect > 1.8 ? Math.min(4, Math.ceil(aspect / 1.25)) : 1;
      }
    }

    // the limit is per result, not per picture: tiles share it
    const png = await renderScene(scene, {
      ...a,
      tiles,
      inlineLimit: Math.floor(INLINE_IMAGE_LIMIT / Math.max(1, tiles)),
    });
    if (png.tiles) {
      return {
        _images: png.tiles,
        width: png.width,
        height: png.height,
        scene: scene.name,
      };
    }
    return {
      _image: png.base64,
      _preview: png.preview,
      path: png.path,
      bytes: png.bytes,
      width: png.width,
      height: png.height,
      scene: scene.name,
    };
  },
});

/** Park an oversized result on disk and hand back the path. */
const spill = async (tool, text) => {
  const dir = path.join(os.tmpdir(), "sketchdex-renders");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${tool}-${text.length}-${Math.random().toString(36).slice(2, 6)}.json`);
  await fs.writeFile(file, text);
  return file;
};

export { TOOLS };

/**
 * Run one tool call and shape the result, independent of transport.
 *
 * Kept separate from the Server wiring because the worker process runs it over
 * plain IPC, with no MCP machinery of its own - see mcp/worker.js.
 */
export async function dispatch(api, name, rawArgs) {
  const handlers = makeHandlers(api);
  const handler = handlers[name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tool: ${name}` }],
    };
  }

  /**
   * `required` in an inputSchema is a hint the client may or may not act on,
   * and the safety contract leans on `label` too heavily to leave to chance:
   * an unlabelled snapshot is one the user cannot judge. Enforced here so it
   * holds regardless of who is calling.
   */
  const args = rawArgs ?? {};
  const required = TOOLS.find((t) => t.name === name)
    ?.inputSchema?.required;
  const missing = (required ?? []).filter(
    (key) => args[key] === undefined || args[key] === "",
  );
  if (missing.length) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `${name} is missing: ${missing.join(", ")}` +
            (missing.includes("label")
              ? ". `label` is what the user reads in the history sidebar when deciding whether to keep this change, so describe what you are doing, e.g. 'add the dog illustration'."
              : ""),
        },
      ],
    };
  }

  try {
    const result = await handler(args);

    if (result?._images) {
      const { _images, ...rest } = result;
      const content = [];
      const tiles = [];
      for (const [i, tile] of _images.entries()) {
        const fits = tile.base64.length <= Math.floor(INLINE_IMAGE_LIMIT / _images.length);
        const shown = fits ? tile.base64 : tile.preview?.base64;
        const mime = fits ? "image/png" : (tile.preview?.mime ?? "image/jpeg");
        const r = tile.region;
        content.push({
          type: "text",
          text: `tile ${i + 1} of ${_images.length}: scene box x=${Math.round(r.x)} y=${Math.round(r.y)} width=${Math.round(r.width)} height=${Math.round(r.height)}`,
        });
        if (shown) content.push({ type: "image", data: shown, mimeType: mime });
        tiles.push({
          region: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          path: tile.path,
          width: tile.width,
          height: tile.height,
          inlined: fits,
          shownAt: fits ? undefined : tile.preview ? `${tile.preview.width}x${tile.preview.height}` : "not shown",
        });
      }
      content.push({
        type: "text",
        text: JSON.stringify(
          {
            ...rest,
            tiles,
            note: "The page was cut into tiles along its long axis (pass tiles: 1 for a single image). To look closely at one part, render that `region`.",
          },
          null,
          1,
        ),
      });
      return { content };
    }

    if (result?._image) {
      const { _image, _preview, ...rest } = result;
      const fits = _image.length <= INLINE_IMAGE_LIMIT;

      // full render if it travels, otherwise the downscaled companion drawn
      // in the same pass - either way there is something to actually look at
      const shown = fits ? _image : _preview?.base64;
      const shownMime = fits ? "image/png" : (_preview?.mime ?? "image/jpeg");
      const note = fits
        ? undefined
        : _preview
          ? `Shown at ${_preview.width}x${_preview.height}; the full ${rest.width}x${rest.height} render is the file at \`path\`. Render a smaller \`region\` for detail.`
          : "Too large to show inline and too detailed to downscale. Read the file at `path`, or render a smaller `region`.";

      return {
        content: [
          ...(shown ? [{ type: "image", data: shown, mimeType: shownMime }] : []),
          {
            type: "text",
            text: JSON.stringify({ ...rest, inlined: fits, note }, null, 1),
          },
        ],
      };
    }

    const text = JSON.stringify(result, null, 1);
    if (text.length > TEXT_LIMIT) {
      /**
       * Spilled to a file rather than truncated. A read big enough to break
       * the transport is usually read_scene on a large scene, and the caller
       * still needs the data - just not through this pipe.
       */
      const file = await spill(name, text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                truncated: true,
                bytes: text.length,
                path: file,
                note: "Too large to return in one result, so it was written to this file. Read it there, or narrow the request: describe_scene for a summary, read_elements with ids/type/region for specific elements.",
              },
              null,
              1,
            ),
          },
        ],
      };
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err?.message ?? err) }],
    };
  }
}

/** MCP Server speaking for a fixed code version, used by the HTTP transport. */
export function createSketchdexServer(api) {
  const server = new Server(
    { name: "sketchdex", version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    dispatch(api, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}
