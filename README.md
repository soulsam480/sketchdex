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
browser and `SKETCHDEX_BROWSER` pointing at it. Everything else works without
one.

The quickest way is to let the agent you already have do it. Paste this into
any agent that can run commands:

> install the sketchdex mcp server for me. run `sketchdex docs install` for the steps.

Or by hand:

Install the binary with `npm install -g sketchdex`, or download the release
asset for your platform. The MCP command is `sketchdex mcp`.

**Claude Code**

```bash
claude mcp add --scope user sketchdex -- sketchdex mcp
```

**Codex**

```bash
codex mcp add sketchdex -- sketchdex mcp
```

**Cursor**

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sketchdex": {
      "command": "sketchdex",
      "args": ["mcp"]
    }
  }
}
```

**VS Code**

```bash
code --add-mcp '{"name":"sketchdex","command":"sketchdex","args":["mcp"]}'
```

**Claude Desktop, Windsurf, Gemini CLI, anything else** takes the same
`mcpServers` block as Cursor, or the command `sketchdex mcp` as a stdio
server. `sketchdex docs install` has the exact file for each.

Then, in a session: *draw me how the event loop works using sketchdex*.

Scenes are saved to `~/Documents/sketchdex`. Point them somewhere else with
`--vault /path/to/folder` after the package name, or `SKETCHDEX_VAULT` in the
server's environment. An iCloud or Dropbox folder works.

## Docs, for the agent

The manual ships inside the package so an agent can answer setup questions
and fix problems without anyone reading a page:

- `sketchdex docs [topic]` prints it (topics: `install`, `vault`,
  `app`, `rendering`, `tools`, `drawing`, `troubleshooting`, or `all`).
- The `sketchdex_docs` tool returns the same text once the server is
  connected, and the server instructions tell the agent to use it for
  anything about setup or errors.
- The same topics are MCP resources at `sketchdex://docs/<topic>`.

## The app

```bash
sketchdex app
```

Opens the library in your browser: a grid of scenes with live previews,
search, pin, rename, duplicate, import; a full Excalidraw editor for each; a
`⌥K` switcher; and a **History** sidebar showing every agent write with the
label the agent gave it, so you can preview, keep or revert each one. The app
notices agent writes as they happen.

The same process serves the tools over HTTP at `POST /mcp` and as plain REST at
`POST /api/agent/:op`, localhost only.

## What the agent gets

Nineteen tools over stdio. The ones that matter:

| Tool | Does |
|---|---|
| `describe_scene` | Structure, not pixels: bounds, counts, a rounded summary per element. Start here. |
| `add_elements` | Boxes, arrows, text, generated shapes (`polygon`, `star`, `arc`, `capsule`, `path`). `label` on a shape adds bound text; `start`/`end` on an arrow bind it. |
| `update_elements` | One id and the fields that change. The read-modify-write happens server-side, so a two-line edit costs two lines. |
| `import_svg` | Write an SVG, get hand-drawn editable elements grouped as one piece. The way to draw anything that has to look like something. |
| `render_scene` | A real canvas render as PNG, whole scene or a region, so the agent can look at its own work. |
| `check_scene` | Layout problems found by geometry: hidden text, overlapping labels, dangling arrows, strays. |
| `snapshot_scene`, `list_history`, `restore_snapshot` | The safety net. Every write snapshots the previous state first. |
| `sketchdex_docs` | The manual by topic, so the agent can answer setup questions and fix errors itself. |

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

The JavaScript implementation remains the oracle for differential tests. The npm CLI and MCP server run Nim.

## Development

```bash
git clone https://github.com/lucasr1b/sketchdex
cd sketchdex
npm install          # also retunes Excalidraw's colour picker for dark paper
npm run dev          # app + API + HTTP MCP on http://localhost:5173
npm run build        # dist/, which the CLI and the render page need
npm run build:server # native CLI at bin/sketchdex
./bin/sketchdex app
```

For an MCP client pointed at a checkout, run `npm run build:server`, then use
`/path/to/sketchdex/bin/sketchdex mcp` as the command. Rebuild after Nim source
changes. The native server does not hot-reload.

`npm run lint`, `npx tsc -p tsconfig.app.json --noEmit` and `npm test` before
committing. The test packs the package, installs it into a clean project and
drives it through a real MCP client, including a render.
[`AGENTS.md`](AGENTS.md) maps the codebase and the rules that must survive
edits.

## Notes

- New scenes are dark paper (`#121212`) and nothing is ever colour-inverted:
  the canvas, thumbnails and renders show every hex exactly as written. Paper
  colour is per scene (`viewBackgroundColor`).
- The first render on a fresh install takes a few seconds while the browser
  starts; after that about a second and a half.
- Set `SKETCHDEX_BROWSER=/path/to/chromium` before using `render_scene`. There is no browser discovery.
- The server only answers requests whose Host is localhost and refuses
  cross-site writes, so a web page open in your browser cannot touch the
  vault. It still binds a plain local port: anything running as you on the
  same machine can reach it, which is the point.
- In the app, `⌘K` opens the scene switcher, which shadows Excalidraw's own
  "add link" shortcut; use the context menu for links.
- The app registers a small service worker (for install-as-app). It does no
  caching, but if you run another project on the same port later it will show
  up in that project's devtools until you unregister it.
