# Sketchdex: notes for agents working on this codebase

To **draw** on scenes, read `BRIEF.md` - it is the complete manual for
the tools (MCP, REST and Node) and the hand-drawn contract. This file is for
changing the code.

## Shape of the thing

One Vite dev server on port 5173 hosts the app, the REST agent surface, the
HTTP MCP transport and the render page. `mcp/server.js` (stdio, what Claude Code
and Codex launch) supervises a worker that it hot-reloads on source change; the
server-level `instructions` string is sent once per client session, so a docs
change there needs a fresh client session even though tools do not.

| Layer | Where | Rule that must survive edits |
|---|---|---|
| Vault | `server/store.js` | Files are the truth; every save is atomic and carries a revision token (`mtimeMs-size`). Conditional saves (`ifRev`) 409 on mismatch; the app merges with `reconcileElements`, the agent API retries. |
| Agent surface | `server/agent.js` | One implementation behind MCP, REST and Node. Every mutation snapshots first (`server/history.js`) and takes a `label`. |
| Element completion | `server/elements.js`, `server/geometry.js` | Fill in what Excalidraw needs, change nothing the caller set. Text is laid out with measured font metrics (`server/font-metrics.json`, regenerate with `npm run measure-fonts` while the dev server runs). |
| Hand-drawn contract | `server/sketch.js`, `server/svg.js` | Generated geometry is re-spaced to ~18px anchors, curved runs get `roundness {type:2}`, roughness 1, solid fill; circles/rects become native shapes. Never reintroduce dense points or roughness 0 as a default - that is what turned drawings into clip-art. |
| Paper and ink | `server/paper.js`, `src/index.css` | `viewBackgroundColor` is data, new scenes are `#121212`, default ink follows paper luminance. The canvas theme filter is forced to `none`: hexes display exactly as written, never inverted. |
| Colour picker | `scripts/patch-excalidraw.mjs` | Excalidraw's palette constants are module-private, so the built package is patched by the `prepare` script on `npm install` in a checkout (idempotent; consumers get a prebuilt `dist/`). After changing it: `rm -rf node_modules/.vite && npx vite --force`. |
| Rendering | `mcp/render.js`, `mcp/render-main.js`, `src/render.ts` | Excalidraw's own export in a hidden browser window. A Chromium already on the machine (Chrome, Edge, Brave) runs headless and the page POSTs its result to a throwaway server; Electron is the fallback in a checkout; `SKETCHDEX_BROWSER` overrides. Uses the dev server for the page when it is up, else serves `dist/` (so run `npm run build` once on a fresh clone). Region renders crop to the box; tall/wide pages tile from a single export. |
| CLI and app server | `bin/sketchdex.js`, `server/serve.js` | `sketchdex` runs the MCP over stdio; `sketchdex app` serves `dist/` plus the API from plain Node (the packaged Electron app uses the same server). The published npm package is `bin/`, `mcp/`, `server/`, `dist/` and the docs, with the MCP SDK as its only runtime dependency; everything else is a devDependency used to build `dist/`. `scripts/check-package.mjs` gates publish. |
| Live sync | `server/watch.js`, `server/middleware.js`, `src/components/Editor.tsx` | Writes are attributed by exact revision so an agent's write is not mistaken for an outside edit, and vice versa. |

## Working here

- `npm run dev` for everything; `npm run lint` (oxlint), `npx tsc -p tsconfig.app.json --noEmit` and `npm test` (`test/e2e.mjs`: pack, install into a temp project, MCP client, render, app) before committing. CI (`.github/workflows/ci.yml`) runs the same on macOS, Linux and Windows.
- Tool descriptions live in `mcp/tools.js`; keep them concise and routing-first (figures via one SVG through `import_svg`, furniture and text via `add_elements`). The house taste: flat solid colour, no shading or cross-hatch as texture, blueprint furniture welcome, vibrant true hexes.
- Do not write em-dashes anywhere, code or prose.
- Hot reload of the MCP worker only runs in a git checkout (`SKETCHDEX_RELOAD=1` forces it); an installed package never changes under a session.
- Test against a throwaway scene through REST (`POST localhost:5173/api/agent/<op>`) and delete it after; the default vault at `~/Documents/sketchdex` is someone's real library, so point tests at a scratch one with `SKETCHDEX_VAULT`.
