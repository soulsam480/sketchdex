# Sketchdex: a brief for an agent

Self-contained. You need nothing else to start drawing.

Sketchdex is a local Excalidraw library on this Mac. Drawings are called
**scenes** and live as real `.excalidraw` files in a **vault** at
`~/Documents/sketchdex`. You can read them, draw on them, and look at what you
drew. Everything is local: no network, no account, no upload.

There is a safety contract, described under **History**. Read it before writing.

---

## Three ways in. Pick whichever you have.

### 1. MCP (already registered)

Registered for Claude Code (user scope) and Codex (`~/.codex/config.toml`, which
the ChatGPT desktop app also reads). If you have tools named `list_scenes`,
`describe_scene`, `add_elements`, `render_scene` and so on, use them - skip to
**The element format**. Argument names match the JSON fields below.

(The same tools are also served over HTTP at `POST localhost:5173/mcp`, for a
client you can only hand a URL.)

### 2. Shell (any agent that can run bash)

The app's dev server exposes the identical surface at `POST /api/agent/:op` on
**port 5173**. One endpoint, one JSON body, `scene` names the target.

```bash
curl -s localhost:5173/api/agent/describe \
  -H 'Content-Type: application/json' \
  -d '{"scene":"Project Centis"}'
```

If nothing answers on 5173, start it: `cd ~/Developer/lab/sketchdex && npm run dev`.

### 3. Node (no server needed)

```js
import { createAgentApi } from "/Users/lucas/Developer/lab/sketchdex/server/agent.js";
const api = createAgentApi();
await api.describeScene("Project Centis");
```

Same implementation as the other two. Works with the app closed.

---

## Operations

`POST localhost:5173/api/agent/<op>`, body is JSON. `scene` accepts a scene id,
an exact name, or a unique part of a name.

| op | body | does |
|---|---|---|
| `list` | `{}` | every scene: id, name, element count, updated |
| `describe` | `{scene, type?, limit?}` | structural summary - **start here** |
| `elements` | `{scene, ids?, type?, contains?, region?, limit?}` | full elements, filtered |
| `read` | `{scene, includeFiles?}` | the whole scene + its file path |
| `path` | `{scene}` | just the file path |
| `create` | `{name, elements?}` | new scene |
| `add` | `{scene, elements, label}` | append elements |
| `update` | `{scene, elements, label}` or `{scene, ids, patch, label}` | change fields on existing elements |
| `delete` | `{scene, ids, label}` | remove elements |
| `move` | `{scene, ids?, groupIds?, region?, dx, dy, label}` | shift a set of elements as one |
| `replace` | `{scene, elements, label}` | replace everything (destructive) |
| `background` | `{scene, color, label}` | canvas colour |
| `snapshot` | `{scene, label}` | stash current state, change nothing |
| `history` | `{scene}` | snapshots held |
| `restore` | `{scene, snapshot}` | put a snapshot back |

Rendering (`render_scene`) is MCP-only - it returns an image, which REST can't
usefully hand back. Over shell, open the scene in the app instead.

**`label` is required on every mutating op** and enforced server-side, not just
declared in the schema. A call without one is rejected.

**Rendering.** Every render is written to a file and the `path` always comes
back. When the full image is too big to travel in one result you get a
downscaled JPEG preview inline plus the path to the full-resolution PNG, so
there is always something to look at. `inlined` says which you got.

A tall or wide page (long edge more than about twice the short one) comes back
as a few **tiles** cut along its length, each tagged with the scene box it
shows; `tiles: 1` forces one image. To look closely at one part, render a
`region`, taking the box from `describe`'s `bounds` or a tile's `region`:
`{"scene":"Brain Dump","region":{"x":0,"y":0,"width":900,"height":700},"scale":2}`.
`ids` renders just those elements. Draw, render, look, fix: anything visual
handed over without having looked at it is a guess. First render after a code
change takes ~30s (it builds the page); after that ~1.5s.

Oversized **text** results (a `read` of a big scene) are written to a file the
same way rather than truncated, with the path returned.

### Read cheaply, write as a delta

Rewriting the file is free: it happens on local disk, inside the server, not in
your context. What costs you is **reading**. Scenes here run past 700 elements
and 4MB.

So: `describe` first (rounded, defaults stripped, ~10 fields per element), then
`elements` for the few you actually need in full. `read` is a last resort.

And never read a scene, mutate the array, and `replace` it back. Send only what
changes:

```bash
curl -s localhost:5173/api/agent/update -H 'Content-Type: application/json' -d '{
  "scene": "Project Centis",
  "label": "shift the auth box right",
  "elements": [{ "id": "kdy29EsP9-Y3MDfCVRBon", "x": 420 }]
}'
```

That element's other 25 fields are untouched, and any edit Lucas made in the
meantime survives. `{"ids": [...], "patch": {...}}` applies one change to many.

---

## The element format

Elements are **real Excalidraw elements**. Any field you set is kept verbatim -
paste a full element out of a `.excalidraw` file and it round-trips unchanged.
Fields you omit are filled in. `id`, `index`, `seed`, `version`, `versionNonce`
and `updated` are always generated for you.

Types: `rectangle` `ellipse` `diamond` `arrow` `line` `text` `freedraw` `frame`.
Others (`image`, `embeddable`, …) pass through with universal defaults only.

```
x, y, width, height   y axis points DOWN, origin top-left
angle                 radians
strokeColor           hex, default "#1e1e1e"
backgroundColor       hex or "transparent"  <- this is the FILL
fillStyle             "hachure" | "cross-hatch" | "solid"
strokeWidth           1 | 2 | 4
strokeStyle           "solid" | "dashed" | "dotted"
roughness             0 architect | 1 artist | 2 cartoonist
opacity               0-100
roundness             {"type": 3} rounded, null sharp
fontSize, fontFamily  5 hand-drawn (default) | 2 normal | 3 code
textAlign             "left" | "center" | "right"
groupIds              shared string = elements move together
points                [[0,0],[dx,dy],...] for line/arrow/freedraw, relative
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

### Text wraps to the width you give it

- A **bound `label`** wraps to its container's width, and the container grows
  taller if the label needs the room.
- **Standalone text with a `width`** wraps to it.
- **Standalone text with no width** stays on one line.
- `wrap: <px>` forces a width, `wrap: false` opts out.

As in Excalidraw, `text` holds the wrapped string and `originalText` holds what
you passed. Editing text later re-wraps to the element's current width.

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

The one thing that makes an agent-drawn scene look scribbled. Use the
generators; they produce geometry at a resolution nobody would type.

Each generator is an ordinary element whose `type` is the generator's name,
with the parameters as fields alongside the usual ones. Not `{"path": {...}}`:

```json
{"type": "path", "points": [[0,0],[40,30],[90,10]], "closed": true,
 "backgroundColor": "#8a2b2b", "strokeWidth": 2}
```

| | |
|---|---|
| `polygon` | `{sides, cx, cy, r}` |
| `star` | `{points, cx, cy, r, innerRatio}` |
| `arc` | `{cx, cy, r, from, to}` degrees; `closed:true` for a wedge |
| `capsule` | `{x, y, width, height, radius}` - plates, limbs, bars |
| `path` | `{points, closed}` - smooth curve **through** your control points |

`repeat` and `mirror` make detail cheap:

- `repeat {count, dx, dy}` row/column · `{count, cols, rows, dx, dy}` grid
- `repeat {count, around:{cx,cy}, radius, rotate}` a ring - bolts, teeth, ribs
- `mirror {axis:"vertical", at:<x>}` - the reflected copy, exactly symmetric

### Colour is not restricted

Any hex for `strokeColor` / `backgroundColor`, any 0-100 `opacity`. The sets
under **Paper and ink** are starting points, not a palette to choose from.

### Check your layout

`check` (`check_scene` over MCP) finds layout problems by geometry, each with
the element ids so the fix is one `update`: text hidden behind a later filled
shape, labels overlapping, a line running through a label, text escaping or
crowding its panel, a bound label too tall for its container, zero-size
elements, dangling bindings, strays, duplicates. Cheaper than a render; run it
after each batch. What it cannot check is whether the drawing is any good -
render it and look.

### Shorthand

Applied only where you left the real field empty, so it never blocks you.

- **`label`** on a shape adds a centred, container-bound text element.
- **`ref`** names an element within one call; **`start`** / **`end`** on an arrow
  bind that end to a `ref` or id. Binding is written on both sides, so the arrow
  follows the shape when Lucas drags it.
- **`points`** as `[[x,y],…]` is re-based so the first point is the origin.

A complete, working call:

```bash
curl -s localhost:5173/api/agent/add -H 'Content-Type: application/json' -d '{
  "scene": "Brief Check",
  "label": "two boxes and an arrow",
  "elements": [
    {"type":"rectangle","ref":"a","x":0,"y":0,"width":180,"height":80,
     "label":"A","backgroundColor":"#a5d8ff"},
    {"type":"rectangle","ref":"b","x":300,"y":0,"width":180,"height":80,"label":"B"},
    {"type":"arrow","x":185,"y":40,"width":110,"height":0,"start":"a","end":"b"}
  ]
}'
```

→ `{"sceneId":"…","name":"Brief Check","added":5,"elements":[{"id","type","text?"},…],"warnings":[]}`

Five, not three: each `label` became its own bound text element.

---

## History: the safety contract

Drawing by hand has Excalidraw's undo stack. You writing to the vault does not.
So **every write through this surface snapshots the previous state first**, and
the snapshots show up in a sidebar in the editor with the time and your `label`.
Lucas previews them, then keeps or reverts. Nothing expires on its own.

Two obligations:

1. **Write a real `label`.** It is the only thing Lucas sees when deciding
   whether to keep your work. `"add the dog illustration"`, not `"update"`.
2. **If you edit a `.excalidraw` file directly** with your own file tools, call
   `snapshot` first. Everything else snapshots itself; your own file write does
   not. (There is a backstop - the running app watches the vault - but it only
   works if the app is open and had already read that scene. Don't rely on it.)

Snapshots are gzipped elements only, capped at 20 per scene, images excluded.
Two snapshots of a small scene cost under 1KB, so take them freely.

---

## Things that will bite you

- **`isDeleted: true` is how deletion works.** Deleted elements stay in the
  array. `describe` and `elements` filter them; a raw `read` does not.
- **Bound text is a separate element** with `containerId` pointing at its shape;
  the shape lists it in `boundElements`. Changing a shape's label means updating
  that text element, not the shape.
- **Don't set `index`.** It is a fractional z-order key ("a0", "a1", "b00") that
  must sort correctly against what is already there. It is computed for you.
- **`replace` destroys everything else on the canvas.** Snapshotted, but reach
  for `add` or `update` unless you mean it.
- **Names must be unambiguous.** A fragment matching several scenes is an error
  listing the candidates and their ids, not a silent pick.
- **Check size before pulling a scene.** `list` gives you the element count.
- **You cannot see what you drew** unless you have `render_scene` (MCP only).
  Without it you are placing shapes by arithmetic with no feedback - keep the
  geometry simple, or ask Lucas to look.
