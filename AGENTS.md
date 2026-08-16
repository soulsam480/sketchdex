# Sketchdex: notes for agents working on this codebase

To **draw** on Lucas's scenes, read `BRIEF.md` - it is the complete manual for
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
| Colour picker | `scripts/patch-excalidraw.mjs` | Excalidraw's palette constants are module-private, so the built package is patched at `postinstall` (idempotent). After changing it: `rm -rf node_modules/.vite && npx vite --force`. |
| Rendering | `mcp/render.js`, `mcp/render-main.js`, `src/render.ts` | Hidden Electron window running Excalidraw's own export. Uses the dev server when it is up, else a throwaway server over `dist/` (so run `npm run build` once on a fresh clone). Region renders crop to the box; tall/wide pages tile from a single export. |
| Live sync | `server/watch.js`, `server/middleware.js`, `src/components/Editor.tsx` | Writes are attributed by exact revision so an agent's write is not mistaken for an outside edit, and vice versa. |

## Working here

- `npm run dev` for everything; `npm run lint` (oxlint) and `npx tsc -p tsconfig.app.json --noEmit` before committing.
- Tool descriptions live in `mcp/tools.js`; keep them concise and routing-first (figures via one SVG through `import_svg`, furniture and text via `add_elements`). Lucas's taste: flat solid colour, no shading or cross-hatch as texture, blueprint furniture welcome, vibrant true hexes.
- Do not write em-dashes anywhere, code or prose.
- Test against a throwaway scene through REST (`POST localhost:5173/api/agent/<op>`) and delete it after; the vault at `~/Documents/sketchdex` is Lucas's real library.
