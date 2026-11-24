# Sketchdex: notes for agents working on this codebase

To **draw** on scenes, read `BRIEF.md` - it is the complete manual for
the tools (MCP, REST and Node) and the hand-drawn contract. This file is for
changing the code.

## Shape of the thing

One Vite dev server on port 5173 hosts the app, and proxies the REST agent
surface and HTTP MCP to the native `sketchdex` binary. The binary runs MCP over
stdio and owns `app` mode. The JavaScript modules remain as test oracles. The
server-level `instructions` string is sent once per client session, so a docs
change there needs a fresh client session.

| Layer | Where | Rule that must survive edits |
|---|---|---|
| Vault | `nim/server/vault.nim` | Files are the truth; every save is atomic and carries a revision token (`mtimeMs-size`). Conditional saves (`ifRev`) 409 on mismatch; the app merges with `reconcileElements`, the agent API retries. |
| Agent surface | `nim/server/agent.nim` | One implementation behind MCP and REST. Every mutation snapshots first (`nim/server/history.nim`) and takes a `label`. |
| Element completion | `nim/core/elements.nim`, `nim/core/geometry.nim` | Fill in what Excalidraw needs, change nothing the caller set. Text is laid out with measured font metrics (`server/font-metrics.json`, checked in). |
| Hand-drawn contract | `nim/core/resample.nim`, `nim/server/svg.nim` | Generated geometry is re-spaced to ~18px anchors, curved runs get `roundness {type:2}`, roughness 1, solid fill; circles/rects become native shapes. Never reintroduce dense points or roughness 0 as a default - that is what turned drawings into clip-art. |
| Paper and ink | `nim/core/paper.nim`, `src/index.css` | `viewBackgroundColor` is data, new scenes are `#121212`, default ink follows paper luminance. The canvas theme filter is forced to `none`: hexes display exactly as written, never inverted. |
| Colour picker | `scripts/patch-excalidraw.mjs` | Excalidraw's palette constants are module-private, so the built package is patched by the `prepare` script on `npm install` in a checkout (idempotent; consumers get a prebuilt `dist/`). After changing it: `rm -rf node_modules/.vite && npx vite --force`. |
| Rendering | `nim/server/render.nim`, `src/render.ts` | Excalidraw's own export in a hidden browser window. `SKETCHDEX_BROWSER` must point at a Chromium-based browser binary; there is no discovery. The page POSTs its result to a throwaway server. Uses `dist/`, so run `npm run build` once on a fresh clone. Region renders crop to the box; tall/wide pages tile from a single export. |
| CLI and app server | `nim/cmd/sketchdex.nim` | `sketchdex` runs the native Nim binary for MCP and the app. `scripts/build-server.mjs` copies it to `bin/sketchdex` for npm. The JavaScript modules remain as test oracles. The published npm package is `bin/`, `mcp/`, `server/`, `dist/` and the docs. `scripts/check-package.mjs` gates publish. |
| Docs for the agent | `docs/*.md`, `nim/mcp/docs.nim`, `BRIEF.md` | One set of files, served four ways: `sketchdex docs` on the CLI, the `sketchdex_docs` tool, `sketchdex://docs/<topic>` resources, and the website's llms.txt. The `tools` topic is generated from the Nim tool table so it cannot drift; everything else is prose that must stay true to the code it describes. Setup facts (flags, env vars, paths, limits) live in `docs/`; drawing lives in `BRIEF.md`. |
| Comments | `nim/server/comments.nim`, `src/components/Comments.tsx` | Comments live in `customData.sketchdex.comments` on the element. Every write goes through the agent surface with a label. A canvas save is never authoritative: `PUT /api/scenes/:id` re-attaches what the file holds, so a stale tab cannot erase a comment. |
| Libraries | `nim/server/library.nim`, `nim/server/watch.nim`, `src/components/Editor.tsx` | The vault is the store: one `library.excalidrawlib` at the vault root, in Excalidraw's format. Installs append by item id, so a repeat install adds nothing; the app's replace is guarded by `ifRev`. Library items are never browser state. The catalog is fetched with `curl` so the binary keeps no TLS dependency. |
| Live sync | `nim/server/watch.nim`, `nim/server/http.nim`, `src/components/Editor.tsx` | Writes are attributed by exact revision so an agent's write is not mistaken for an outside edit, and vice versa. |

## Working here

- `npm run dev` for everything; `npm run lint` (oxlint), `npx tsc -p tsconfig.app.json --noEmit` and `npm test` (build the native server, pack, install into a temp project, MCP client, render, app) before committing. CI (`.github/workflows/ci.yml`) runs the same on macOS, Linux and Windows.
- Tool descriptions live in `nim/mcp/tools.nim`; keep them concise and routing-first (figures via one SVG through `import_svg`, furniture and text via `add_elements`). The house taste: flat solid colour, no shading or cross-hatch as texture, blueprint furniture welcome, vibrant true hexes.
- Do not write em-dashes anywhere, code or prose.
- `scripts/build-server.mjs` builds `nim/bin/sketchdex` and copies it to `bin/sketchdex` for npm. Rebuild and restart MCP clients after Nim source changes.
- Test against a throwaway scene through REST (`POST localhost:5173/api/agent/<op>`) and delete it after; the default vault at `~/Documents/sketchdex` is someone's real library, so point tests at a scratch one with `SKETCHDEX_VAULT`.
