# Sketchdex for agents

You can draw on Lucas's Excalidraw canvases. This file tells you how, and what
will bite you.

## The model

A **vault** of `.excalidraw` files at `~/Documents/sketchdex` (override with
`SKETCHDEX_VAULT`). One file per **scene**. `index.json` is a rebuildable cache,
not the source of truth. The MCP server edits those files directly, so it works
whether or not the app is running; when it is running, your edit appears on the
open canvas within a moment.

**Every write through these tools snapshots the previous state first.** Lucas
reviews snapshots in a history sidebar and keeps or reverts them. That is the
whole safety model, and it is why `label` matters (see below).

## Which tool

| You want to | Call |
|---|---|
| Know what scenes exist | `list_scenes` |
| Plan an edit, know what's on a canvas | `describe_scene` |
| Get exact values for a few elements | `read_elements` with `ids`/`type`/`contains`/`region` |
| Get everything, or the file path | `read_scene` |
| Draw something new | `add_elements` |
| Move/recolour/retext what's there | `update_elements` |
| Shift a whole panel, group or region | `move_elements` with `ids`/`groupIds`/`region` + `dx`,`dy` |
| Remove things | `delete_elements` |
| Start over on a canvas | `replace_scene` |
| **See what you drew** | `render_scene` |

### Read cheaply

Rewriting the file is free - it happens on local disk, in the server, not in
your context. What costs you is *reading*. A scene here runs to 700+ elements
and 4MB.

So: `describe_scene` first (rounded, defaults stripped, ~10 fields per element),
then `read_elements` for the handful you actually need at full fidelity.
`read_scene` is for when you genuinely need the whole array.

### Write as a delta

`update_elements` merges named fields into named elements. To move one box:

```json
{ "scene": "Project Centis", "label": "shift the auth box right",
  "elements": [{ "id": "kdy29EsP9-Y3MDfCVRBon", "x": 420 }] }
```

That element's other 25 fields are untouched. Do **not** read the scene, mutate
the array, and `replace_scene` it back - that burns context and throws away any
edit Lucas made in between.

For one change across many elements: `{ "ids": [...], "patch": { "opacity": 40 } }`.

## The element format

Elements are **real Excalidraw elements**. Any field you set is honoured
verbatim - paste a full element out of a `.excalidraw` file and it round-trips
unchanged. Fields you omit get valid defaults (id, `index`, `seed`, `version`,
`versionNonce`, `updated` are always generated for you; `index` is a fractional
z-order key and you should never set it by hand).

Types: `rectangle` `ellipse` `diamond` `arrow` `line` `text` `freedraw` `frame`.
Anything else (`image`, `embeddable`, …) passes through with universal defaults
only and a warning - which is fine if you know what you're building.

Fields worth knowing:

```
x, y, width, height      y axis points DOWN. origin is top-left.
angle                    radians
strokeColor              hex, default "#1e1e1e"
backgroundColor          hex or "transparent" - this is the FILL
fillStyle                "hachure" | "cross-hatch" | "solid"
strokeWidth              1 | 2 | 4
strokeStyle              "solid" | "dashed" | "dotted"
roughness                0 architect | 1 artist | 2 cartoonist
opacity                  0-100
roundness                { type: 3 } rounded, null sharp
fontSize, fontFamily     5 hand-drawn (default) | 2 normal | 3 code
textAlign                "left" | "center" | "right"
groupIds                 shared string = elements move together
points                   [[0,0],[dx,dy],...] for line/arrow/freedraw, relative
```

### Paper and ink: colours are exactly what you write

Nothing is ever inverted for display. The canvas shows every hex as it is,
including the background, so `#ffc21a` is gold and `#ffffff` is white on any
scene. There is no dark "mode": a dark scene is one whose data is dark.

- **New scenes are dark paper**: `viewBackgroundColor` `#121212`.
- **Default ink follows the paper.** Anything you draw without a `strokeColor`
  gets `#e9ecef` on dark paper and `#1e1e1e` on light paper. `describe_scene`
  reports both as `background` and `ink`. Check them before choosing colours -
  a `#1e1e1e` outline on `#121212` paper is invisible.
- `set_background` changes the paper; the default pen follows it. Existing
  elements keep their colours, so recolour ink you already drew if you flip a
  scene from light to dark.
- Fills should be chosen for the paper. On dark paper, mid-tone fills read
  best (`#245b8f` `#2b6b3a` `#8a2b2b` `#8a6a12`), with light ink strokes and
  white `#ffffff` for highlights. On light paper Excalidraw's soft set works:
  stroke `#1e1e1e #e03131 #2f9e44 #1971c2 #f08c00`, fill `#ffc9c9 #b2f2bb
  #a5d8ff #ffec99`. Character colours are character colours: Iron Man is
  `#e0101a` and `#ffc21a` on either paper.

### The look is hand-drawn. Keep it that way.

This is Excalidraw. The point of every drawing here is that it reads as
sketched by a person with a pen, not exported from a vector tool. Everything
generated for you (SVG imports, the shape primitives) already comes out that
way; what you write by hand has to match. The rules, in order of how much they
matter:

- **roughness 1** on everything (it is the default). 2 for a loose doodle.
  Never 0 unless the thing must be precise: a logo, a wiring diagram.
- **Native shapes first.** A `rectangle`, `ellipse`, `diamond` or `arrow` drawn
  as its own type gets Excalidraw's double-stroke wobble. The same box drawn
  as a 4-point `line` does not. Heads, eyes, wheels, faces: `ellipse`.
- **Few points, confident strokes.** A curve someone drew by hand has anchors
  15-20px apart and each segment gets one bow. A dense polyline (a point every
  2-3px) at roughness 1 looks furry, not sketchy - it is the single reason an
  import reads as clip-art. If you write `points` yourself keep them sparse and
  set `roundness: {"type": 2}` so they draw as a curve.
- **Flat colour, no shading.** One solid fill per part; the wobbly outline
  does the rest. A darker part is a darker hex, not a hatched overlay or a
  shadow shape, and there are no gradients faked with stacked shapes.
  `hachure` / `cross-hatch` are for things that *are* hatched (a cutaway, a
  glass pane), not for texture. Overworked shading is the fastest way for a
  sketch to stop looking like one.
- **Detail is a few extra strokes, not more polygons.** A leg is one tapered
  silhouette with a line at the knee - not a thigh polygon, a shin polygon and a
  foot polygon. When a figure looks like a toy, the fix is the silhouette,
  never more parts. More parts is how a sketch turns into a vector diagram.
- **Text** in the hand-drawn font (`fontFamily` 5, the default). Stroke width
  1 or 2, 4 for a bold outline. A white or paper canvas. Any hex works, but a
  black background with neon panels is a poster, not a sketch.

### Text wraps to whatever width it is given

- A **bound `label`** wraps to its container's width, and the container grows
  taller if the label needs more room.
- **Standalone text with a `width`** wraps to it.
- **Standalone text with no width** stays on one line and sets its own width.
- `wrap: <px>` forces a width; `wrap: false` opts out.

As in Excalidraw itself, `text` holds the wrapped string and `originalText`
holds what you passed. Editing text through `update_elements` re-wraps to the
element's current width, so a label stays inside its box.

### To draw something that has to *look* like something, write SVG

`import_svg` is THE way to draw a character, creature, object, vehicle, logo or
illustration. Stacking shapes with `add_elements` never works for this: every
part comes out crisp and the whole comes out as a pile (fat, seamed, toy-like),
because nothing holds the proportions. One SVG comes out as one drawing.

The import is hand-drawn, not pasted: every path becomes a real editable
Excalidraw element (grouped as one piece), curves are re-spaced to hand-sized
strokes and drawn with the sketchy pen, `<circle>`/`<ellipse>`/`<rect>` become
native shapes. Write the SVG for **shape, proportion and colour** and let the
canvas supply the pen. Do not fake wobble or hatching in the SVG.

A recipe that works for a figure:

- `viewBox` about 300 x 600 for a standing figure; import at `width` 350-450.
- **One closed path per body region** (torso, each leg, each arm), tapered like
  a real limb: forearm ~60% of the upper arm, calf into a narrow ankle. Plus
  head, hands, feet. Let them overlap; later paths draw on top. Then detail as
  separate strokes *over* the silhouette: plates, seams, webbing, a knee line.
  A few, not many.
- Every shape: `fill` a vibrant, character-accurate hex; `stroke` the scene
  ink (from `describe`) or a deep shade of the fill; `stroke-width` 2 to 2.5.
  Filled shapes with no stroke read as flat.
- Proportion from a rule: 7-8 heads tall for heroic, 5-6 for stylised. Head
  first, derive the rest.
- Then **render and look**; fix what is off. The first pass is usually
  mis-proportioned, the second is right.

Supported: `path` (all commands), `rect`, `circle`, `ellipse`, `line`,
`polyline`, `polygon`, `g`, `transform`, `<style>`/class, `<use>`/`<defs>`,
presentation attributes, `text`. `viewBox` is honoured exactly. Gradients
flatten to their first stop; pass `holeColor` to punch compound-path holes.
Options: `style: "precise"` (exact vertices, roughness 0) for a logo;
`fillStyle`; `roughness` (1 default, 2 looser); `step` (anchor spacing, 18).

### For diagram furniture, never place vertices by hand

This is the single thing that makes an agent-drawn scene look scribbled. A
silhouette guessed at eight points is a blob; the same drawing's bolt rings and
dials look designed, because those are circles repeated at even angles. Use the
generators and you get geometry at a resolution nobody would type.

Each generator is an ordinary element whose `type` is the generator's name,
with the parameters as fields alongside the usual ones. Not `{"path": {...}}`:

```json
{"type": "path", "points": [[0,0],[40,30],[90,10]], "closed": true,
 "backgroundColor": "#8a2b2b", "strokeWidth": 2}
```

| | |
|---|---|
| `polygon` | `{sides, cx, cy, r}` - also `rx`/`ry`, `rotation` |
| `star` | `{points, cx, cy, r, innerRatio}` |
| `arc` | `{cx, cy, r, from, to}` in degrees; `closed:true` for a wedge |
| `capsule` | `{x, y, width, height, radius}` - plates, limbs, bars |
| `path` | `{points, closed}` - a smooth curve **through** your control points |

`path` is the one to reach for on organic shapes: nine control points come back
as a 127-point curve. `resolution` controls smoothness, `smooth:false` keeps the
segments straight.

**`repeat` and `mirror` make detail cheap**, which is the only way to get more of
it:

```json
{ "type": "ellipse", "width": 12, "height": 12, "backgroundColor": "#d36b38",
  "repeat": { "count": 12, "around": { "cx": 300, "cy": 330 }, "radius": 53 } }
```

- `repeat {count, dx, dy}` - a row or column
- `repeat {count, cols, rows, dx, dy}` - a grid
- `repeat {count, around:{cx,cy}, radius, rotate}` - a ring; `rotate` faces each
  copy outward, for teeth and ribs
- `mirror {axis:"vertical", at:<x>}` - adds the reflected copy, so a left arm is
  *exactly* the right arm rather than approximately

### Colour is not restricted

`strokeColor` and `backgroundColor` take any hex, `opacity` any 0-100. The
sets under **Paper and ink** are starting points, **not a palette to choose
from**. Build a real scheme for what you are drawing.

### Shorthand

Three conveniences layered on top. They only apply where you left the real field
empty, so they never get in your way.

- **`label`** on a shape creates a centred, container-bound text element.
- **`ref`** names an element within one call; **`start`**/**`end`** on an arrow
  bind that end to a `ref` or an id. Binding is two-sided and done properly, so
  the arrow follows the shape when Lucas drags it.
- **`points`** as `[[x,y],…]` gets re-based so the first point is the origin.

```json
[{ "type": "rectangle", "ref": "api", "x": 0, "y": 0, "width": 180, "height": 80,
   "label": "API", "backgroundColor": "#a5d8ff" },
 { "type": "rectangle", "ref": "db", "x": 320, "y": 0, "width": 180, "height": 80,
   "label": "Postgres" },
 { "type": "arrow", "x": 185, "y": 40, "start": "api", "end": "db" }]
```

## Check before you look

`check_scene` finds layout problems by geometry, each with the element ids so the
fix is one `update_elements` call:

- text hidden behind a filled shape drawn after it
- two labels overlapping each other
- a rule or leader line running through a label
- text escaping its panel on any edge, or crowding within 8px of one
- a bound label too tall for its container
- zero-size elements, dangling arrow bindings, strays, exact duplicates

Run it after each batch. It is far cheaper than a render and catches what a
render only reveals if you look closely. Repeats are capped at six per kind -
`counts` has the real totals.

**What it cannot check is whether the drawing is any good.** Proportion, anatomy,
composition and weight are not geometry problems, and a clean report means only
that nothing is provably broken. Render it and look.

## Look at what you drew

`render_scene` returns a PNG from Excalidraw's own canvas renderer - the real
fonts, the real rough strokes, not the library's scaled-down SVG thumbnail.

**Use it.** You are placing shapes by arithmetic with no feedback. Text is laid
out with the real font metrics (measured from Excalidraw's own fonts, see
`server/font-metrics.json`), so widths are right; what a render catches is
everything else - overlaps, proportion, a figure that does not read. Draw,
render, look, fix. Anything visual you hand over without having looked at it is
a guess.

Every render is written to a file and the `path` always comes back. If the full
image is too large to travel in one tool result, you get a **downscaled JPEG
preview inline plus the path to the full-resolution PNG** - so there is always
something to look at, and the detail is always retrievable. `inlined` in the
result tells you which you got.

**A tall or wide page comes back as tiles.** When the long edge is more than
about twice the short one, the render is cut along its length into a few
pictures (one export, so it is no slower), each tagged with the scene box it
shows. Pass `tiles: 1` for a single image, or `tiles: N` to choose. A whole
board scaled to fit is unreadable at any resolution, so raising `maxWidth` past
the inline budget buys nothing; to look closely at one part, render a
`region`. Take the box from `describe_scene`'s `bounds` or a tile's `region`:

```json
{ "scene": "Brain Dump", "region": { "x": 0, "y": 0, "width": 900, "height": 700 }, "scale": 2 }
```

`ids` renders just those elements. A bound label whose container is filtered out
is dropped with it, so pieces never come back with orphaned text.

First call after a code change may take ~30s (it builds the render page). After
that ~1.5s with the app running.

## The label field

`label` is what Lucas reads in the history sidebar next to the timestamp when
deciding whether to keep your change. **Every mutating tool rejects a call
without one** - not as schema decoration, it is checked server-side. Write it
for him, not for you:

- good: `"add the dog illustration"`, `"recolour the auth boxes blue"`
- useless: `"agent edit"`, `"update"`, `"changes"`

## Editing the file directly

`read_scene` returns `path`. You may edit that file with your own tools when no
tool here fits. Two rules:

1. **Call `snapshot_scene` first.** Nothing else can protect you - the tools
   snapshot themselves, your own `Write` does not.
2. Preserve `files` (the embedded image map, base64, usually most of the file's
   bytes) and keep every element's `index` valid.

There is a backstop: the running app watches the vault and snapshots the last
state it saw when a file changes underneath it. It only works if the app is
running *and* had seen that scene. Do not rely on it.

## Things that will bite you

- **`isDeleted: true` is how deletion works.** Deleted elements stay in the
  array. `describe_scene` and `read_elements` filter them; a raw `read_scene`
  does not.
- **Bound text is a separate element** with `containerId` pointing at its shape,
  and the shape lists it in `boundElements`. Changing a shape's label means
  updating that text element, not the shape.
- **Names must be unambiguous.** `scene` accepts an id, an exact name, or a
  *distinguishing* fragment. A fragment matching several scenes is an error
  listing the candidates and their ids, not a silent pick. Pass an id to settle
  it.
- **`replace_scene` destroys everything else on the canvas.** It is snapshotted,
  but reach for `add_elements` unless you mean it.
- **Don't set `index`.** It is a fractional key ("a0", "a1", "b00") that must
  sort correctly against what's already there. It is computed for you.
- **Scenes can be huge.** Check `elements` in `list_scenes` before pulling one.

## Transports

Everything lives on **port 5173**, the dev server. There is no second service.

| | |
|---|---|
| `stdio` | `node mcp/server.js` - what Claude Code and Codex launch. Works with the app closed, and picks up source edits without a restart (see below). |
| `POST /mcp` | the same tools over HTTP, for clients you can only hand a URL. |
| `POST /api/agent/:op` | plain REST, if you have no MCP at all. `GET /api/agent` lists the ops. |
| `GET /api/events` | server-sent events; how the open app learns you changed something. |

REST ops mirror the tools: `list describe read elements path create add update
delete replace write background snapshot history restore discard clear`. Body is
JSON with `scene` in it.

```bash
curl -s localhost:5173/api/agent/describe -H 'Content-Type: application/json' \
  -d '{"scene":"Project Centis"}'
```

`render_scene` borrows the dev server when one is running on the same vault, and
only spins a throwaway port when nothing is up.
