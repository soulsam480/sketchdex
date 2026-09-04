# sketchdex

[![ci](https://github.com/lucasr1b/sketchdex/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasr1b/sketchdex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sketchdex)](https://www.npmjs.com/package/sketchdex)

Give your agent a whiteboard. [sketchdex.dev](https://sketchdex.dev)

Sketchdex is an MCP server that lets Claude, Codex, Cursor and any other MCP
client draw hand-drawn Excalidraw diagrams while it explains something. Scenes
are real `.excalidraw` files in a folder on your machine. The agent can draw,
look at what it drew, and fix it; you can open the result in the bundled
library app or on excalidraw.com and keep editing.

Built on the official `@excalidraw/excalidraw` package, so the canvas is the
real thing. MIT.

## Install

Needs Node 20 or newer. Rendering (`render_scene`) needs a Chromium-based
browser on the machine: Chrome, Chromium, Edge or Brave. Everything else works
without one.

**Claude Code**

```bash
claude mcp add --scope user sketchdex -- npx -y sketchdex
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.sketchdex]
command = "npx"
args = ["-y", "sketchdex"]
```

**Cursor, Claude Desktop, Windsurf, anything with an `mcpServers` block**

```json
{
  "mcpServers": {
    "sketchdex": {
      "command": "npx",
      "args": ["-y", "sketchdex"]
    }
  }
}
```

Then, in a session: *draw me how the event loop works*.

Scenes are saved to `~/Documents/sketchdex`. Point them somewhere else with
`SKETCHDEX_VAULT=/path/to/folder` in the server's environment, or
`--vault /path/to/folder` after the package name. An iCloud or Dropbox folder
works.

## The app

```bash
npx sketchdex app
```

Opens the library in your browser: a grid of scenes with live previews,
search, pin, rename, duplicate, import; a full Excalidraw editor for each; a
`⌥K` switcher; and a **History** sidebar showing every agent write with the
label the agent gave it, so you can preview, keep or revert each one. The app
notices agent writes as they happen.

The same process serves the tools over HTTP at `POST /mcp` and as plain REST at
`POST /api/agent/:op`, localhost only.

## What the agent gets

Eighteen tools over stdio. The ones that matter:

| Tool | Does |
|---|---|
| `describe_scene` | Structure, not pixels: bounds, counts, a rounded summary per element. Start here. |
| `add_elements` | Boxes, arrows, text, generated shapes (`polygon`, `star`, `arc`, `capsule`, `path`). `label` on a shape adds bound text; `start`/`end` on an arrow bind it. |
| `update_elements` | One id and the fields that change. The read-modify-write happens server-side, so a two-line edit costs two lines. |
| `import_svg` | Write an SVG, get hand-drawn editable elements grouped as one piece. The way to draw anything that has to look like something. |
| `render_scene` | A real canvas render as PNG, whole scene or a region, so the agent can look at its own work. |
| `check_scene` | Layout problems found by geometry: hidden text, overlapping labels, dangling arrows, strays. |
| `snapshot_scene`, `list_history`, `restore_snapshot` | The safety net. Every write snapshots the previous state first. |

The full manual the agent reads is [`BRIEF.md`](BRIEF.md): the element format,
the hand-drawn contract (roughness, sparse anchors, flat colour, no clip-art),
paper and ink rules, and the things that will bite.

## How it holds up

- **Files are the truth.** Every scene is a plain `.excalidraw` file. Atomic
  writes (temp file, rename), deletes go to `trash/`, and `index.json` is a
  cache the server rebuilds from the files if it is lost.
- **Every agent write is undoable.** Snapshots are gzipped, capped at 20 per
  scene, images excluded, and never expire on their own.
- **Deltas, not rewrites.** Edits you make in the editor while the agent works
  survive: writes carry a revision token and conflicting saves are merged.
- **Local only.** No account, no upload, no telemetry. The server binds
  127.0.0.1.

```
~/Documents/sketchdex/
├── index.json              names, timestamps, pins (a cache, not the truth)
├── scenes/<id>.excalidraw  the scene itself, real Excalidraw format
├── thumbs/<id>.svg         library previews
├── history/<id>/           snapshots taken before agent writes, gzipped
└── trash/<stamp>-<id>.excalidraw
```

## Node API

```js
import { createAgentApi } from "sketchdex";
const api = createAgentApi(); // or createAgentApi("/path/to/vault")
await api.describeScene("Brain Dump");
```

Same implementation as the MCP and REST surfaces. Works with the app closed.

## Development

```bash
git clone https://github.com/lucasr1b/sketchdex
cd sketchdex
npm install          # also retunes Excalidraw's colour picker for dark paper
npm run dev          # app + API + HTTP MCP on http://localhost:5173
npm run build        # dist/, which the CLI and the render page need
node bin/sketchdex.js app
```

For an MCP client pointed at a checkout, use `node /path/to/sketchdex/mcp/server.js`
as the command. In a checkout the server hot-reloads its worker when a file
under `server/` or `mcp/` changes, so edits are live on the next tool call
without restarting the client.

`npm run lint`, `npx tsc -p tsconfig.app.json --noEmit` and `npm test` before
committing. The test packs the package, installs it into a clean project and
drives it through a real MCP client, including a render; CI runs it on macOS,
Linux and Windows.
[`AGENTS.md`](AGENTS.md) maps the codebase and the rules that must survive
edits. There is also a macOS desktop shell: `npm run electron:dev`.

## Notes

- New scenes are dark paper (`#121212`) and nothing is ever colour-inverted:
  the canvas, thumbnails and renders show every hex exactly as written. Paper
  colour is per scene (`viewBackgroundColor`).
- The first render on a fresh install takes a few seconds while the browser
  starts; after that about a second and a half.
- Set `SKETCHDEX_BROWSER=/path/to/browser` if the browser is somewhere unusual.
- The server only answers requests whose Host is localhost and refuses
  cross-site writes, so a web page open in your browser cannot touch the
  vault. It still binds a plain local port: anything running as you on the
  same machine can reach it, which is the point.
- In the app, `⌘K` opens the scene switcher, which shadows Excalidraw's own
  "add link" shortcut; use the context menu for links.
- The app registers a small service worker (for install-as-app). It does no
  caching, but if you run another project on the same port later it will show
  up in that project's devtools until you unregister it.
