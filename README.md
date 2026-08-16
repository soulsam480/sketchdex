# sketchdex

Excalidraw, but bound into a codex instead of one endless scroll: every drawing
is a named scene you can browse, search, pin and flip through.

Built on the official `@excalidraw/excalidraw` React package, so the canvas is
the real thing (every tool, shortcut and export). Everything around it, the
library, the scene store, the switcher, is local.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

## Install as an app (and get ⌘K back)

Chrome reserves `⌘K` for the address bar, and no page can override a browser
shortcut. An installed app window has no address bar, so the shortcut reaches
sketchdex. The `⌘K`/`⌥K` label in the UI reflects whichever one is live.

```bash
npm run build && npm run preview   # http://localhost:4173
```

In Chrome: ⋮ menu → Cast, Save and Share → **Install page as app**. It gets a
Dock icon and its own window; `⌘K` works there.

## How it works

- **Library** (`/`) - grid of scene cards with live SVG previews. Search, sort
  by edited/created/name, pin to top, rename (double-click the title),
  duplicate, delete, import `.excalidraw` files.
- **Editor** (`#/s/<id>`) - full Excalidraw canvas with a thin top bar: scene
  name, save state, `‹ ›` to leaf through scenes in creation order, `⌘K`.
- **Switcher** - `⌥K` opens a jump list from anywhere (`⌘K` also works wherever
  the browser doesn't reserve it, i.e. in the installed app). Arrow keys move,
  enter opens, typing a name with no match offers a new scene.
- **Storage** - real files on disk, served by the dev/preview server. Nothing
  leaves the machine and the browser holds no source of truth, so clearing site
  data costs nothing. See **Vault** below.
- **Saving** - debounced 700ms after the last change, plus a forced save when
  leaving a scene, hiding the tab, or stepping to another scene. Thumbnails
  regenerate at most every 6s while drawing and always on exit.

## Agents

Claude and Codex can read and draw on these scenes. Everything runs on port
5173 alongside the app; `BRIEF.md` is the reference (written for the model, not
for you), and `AGENTS.md` is for agents changing this codebase.

Registered already: Claude Code at user scope, Codex in `~/.codex/config.toml`.
Both launch `node mcp/server.js` over stdio, which talks to the vault directly
and works with the app closed.

**Editing this project does not need a client restart.** A stdio MCP server is
spawned once per session and keeps whatever code it started with, so changes
used to stay invisible until every Claude Code and Codex session was restarted.
`mcp/server.js` is now only a supervisor: it holds the pipe to the client and
runs the tools in a child process that is replaced whenever a file under
`server/` or `mcp/` changes. The next tool call uses the new code, and a
`tools/list_changed` notification goes out if the tool list itself moved.

The one exception is `mcp/server.js` itself, which cannot reload itself - it is
kept thin for that reason. `SKETCHDEX_NO_RELOAD=1` pins a session to the code it
started with.

- **Freedom.** Tools accept real Excalidraw elements - any field passes through
  verbatim - with shorthand (`label`, arrow `start`/`end` by ref) layered on top
  for the common cases. `read_scene` hands out the file path for anything the
  tools don't cover.
- **Cheap edits.** `update_elements` takes a delta: one id and the fields that
  change. The read-modify-write of the file happens server-side, so a two-line
  change costs two lines, not a scene rewrite.
- **Sight.** `render_scene` returns a real canvas-rendered PNG, not the library's
  scaled SVG thumbnail, so an agent can check its own work.
- **Undo.** See **History** below.
- **Other clients.** `POST /mcp` is the same tool set over HTTP, and
  `POST /api/agent/:op` is plain REST. Both localhost-only - reaching them from
  a hosted assistant would mean tunnelling the port, which exposes the vault.

## History

Drawing by hand has Excalidraw's undo stack. An agent writing to the vault does
not, so **every agent write snapshots the previous state first**, and the
snapshots appear in a sidebar in the editor (the *History* button) with the time
and the agent's own description of what it was about to do.

Per snapshot: click to preview it on the canvas (nothing is saved while
previewing), ✓ to make it live and clear the rest, ✕ to drop it. Doing nothing
leaves them; they never expire on their own.

Snapshots hold elements and appState only, gzipped, capped at 20 per scene. The
embedded image map is excluded - it is the bulk of a scene on disk and nothing
ever removes entries from it, so the live map is always a superset. A snapshot
of a busy scene costs tens of KB.

If an agent edits a `.excalidraw` file directly instead of going through the
tools, the running app notices the change, snapshots the last state it saw, and
reloads the canvas.

## Vault

Scenes are files. The vault defaults to `~/Documents/sketchdex`; point it
anywhere (an iCloud or Dropbox folder, say) with `SKETCHDEX_VAULT`:

```bash
SKETCHDEX_VAULT=~/Drive/sketchdex npm run dev
```

```
~/Documents/sketchdex/
├── index.json              names, timestamps, pins (a cache, not the truth)
├── scenes/<id>.excalidraw  the scene itself, real Excalidraw format
├── thumbs/<id>.svg         library previews
├── history/<id>/           snapshots taken before agent writes, gzipped
└── trash/<stamp>-<id>.excalidraw
```

What that buys:

- **Backed up.** Time Machine and any folder sync already cover it.
- **Portable.** Each file opens as-is in excalidraw.com or the desktop app.
- **Self-healing.** `index.json` is a cache. Delete or corrupt it and the
  server rebuilds it by scanning `scenes/`, recovering each scene's name from
  inside its own file.
- **Atomic writes.** Every write goes to a temp file and is renamed into place,
  so a crash mid-save cannot leave a truncated scene.
- **Recoverable deletes.** Deleting moves the file to `trash/`. Nothing is
  unlinked.
- **No silent data loss.** If the server is unreachable, the editor shows
  "retrying", a banner appears, and the pending edit is held in memory and
  written as soon as the vault answers again.

Scenes that predate this (stored in IndexedDB) are migrated into the vault
automatically on first load. The old IndexedDB copies are left in place as a
backup.

## Files

| Path | Purpose |
|---|---|
| `src/App.tsx` | Hash routing, scene index state, global `⌘K` |
| `src/components/Library.tsx` | Scene grid, search/sort, import |
| `src/components/SceneCard.tsx` | Preview card, inline rename, card actions |
| `src/components/Editor.tsx` | Excalidraw host, autosave, scene stepping, live reload |
| `src/components/Switcher.tsx` | Jump-to-scene palette |
| `src/components/History.tsx` | Snapshot sidebar: preview, keep, discard |
| `src/lib/store.ts` | Vault client, appState whitelist, history + SSE clients |
| `src/lib/migrate.ts` | One-time lift of old IndexedDB scenes into the vault |
| `src/lib/thumbnail.ts` | Scene to preview SVG |
| `src/render.ts` | Headless page that renders a scene to PNG |
| `server/store.js` | The vault: atomic file writes, index rebuild, trash |
| `server/middleware.js` | `/api/*`, `/mcp`, mounted on dev + preview |
| `server/agent.js` | The agent surface; every mutation snapshots first |
| `server/elements.js` | Completes partial elements: indices, seeds, bindings, labels, text metrics |
| `server/geometry.js` | Parametric shapes, repeat/mirror, `{"path": ...}` shorthand |
| `server/sketch.js` | The hand-drawn contract: re-spaced anchors, curves, roughness, fill |
| `server/svg.js` | SVG to elements, through the sketch pass |
| `server/paper.js` | Paper and ink: dark paper by default, ink follows paper |
| `server/inspect.js` | `check_scene`: layout problems found by geometry |
| `server/history.js` | Snapshot store, gzipped and capped |
| `server/watch.js` | Watches the vault, pushes SSE, catches direct file edits |
| `mcp/tools.js` | Tool definitions, shared by both transports |
| `mcp/server.js` | stdio entry (Claude Code, Codex) |
| `mcp/render.js` | Scene to PNG via a hidden Electron window |
| `scripts/patch-excalidraw.mjs` | Postinstall: retune the colour picker for dark paper |
| `scripts/measure-fonts.mjs` | Regenerate `server/font-metrics.json` from Excalidraw's fonts |

## Notes

- The chrome is dark and so is new paper (`#121212`), but nothing is ever
  colour-inverted: the canvas, thumbnails and renders all show hexes exactly as
  written. Paper colour is per scene (`viewBackgroundColor`).
- `onChange` deliberately never touches React state. The save indicator writes
  straight to the DOM, otherwise every stroke would re-render the canvas host.
