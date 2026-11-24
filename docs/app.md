# The app

The app is where the person sees what the agent drew: a library of every
scene in the vault, and the real Excalidraw editor for each one. It is the
same package as the MCP server, so nothing extra is installed.

## Opening it

```bash
sketchdex app
```

Starts a local server, prints its URL (`http://localhost:5173` unless that
port is busy) and opens it in the default browser. Leave the terminal
running; `Ctrl C` stops it. Flags:

- `--port <n>`: default 5173. A busy port moves to the next free one.
- `--no-open`: do not open a browser tab, just print the URL.
- `--vault <dir>`: the scene folder, if the MCP server was given one too.

A scene has a stable address, `http://localhost:5173/#/s/<scene id>`, where
the id is the one `list_scenes` and `create_scene` return. After drawing
something, tell the person to run `sketchdex app` if it is not already
open, or give them that link if it is.

The page notices agent writes as they happen, so it can stay open while
the agent draws and the canvas updates on its own.

## The interface

**Library** (the front page): a grid of scene cards with hand-drawn
previews, newest edit first. At the top: a search box, sort by Edited,
Created or Name, Jump (`Cmd K` or `Alt K`, a switcher that opens any scene
by typing part of its name), Import (an `.excalidraw` file from anywhere,
excalidraw.com exports included), and New scene. Each card has rename,
duplicate, pin and delete; deleted scenes go to the vault's `trash/`.

**Editor**: the official Excalidraw canvas, full screen, with every tool
and shortcut from excalidraw.com, so anything the person already knows
carries over. Above it a small bar: All scenes (back to the library), the
scene name (click to rename) with its saved state, previous and next scene,
History with a count of pending agent writes, and the `Cmd K` switcher.
Changes save on their own; there is no save button. `Cmd K` shadows
Excalidraw's own add-link shortcut, so links go through the context menu.

**History** (the sidebar in the editor): every write the agent made, newest
first, each with the label the agent gave it and a preview of the scene as
it was before. For each one: restore that state, keep the current state and
clear the list, or discard the snapshot. Writes made outside sketchdex, in
another editor for example, are snapshotted too and marked as such. The
agent can do the same through `list_history` and `restore_snapshot`.

Editing while the agent draws is fine. Both sides write deltas against a
revision token and conflicting saves are merged, so a box the person moved
stays moved when the agent adds the next one.

## What it serves

Everything is bound to localhost and refuses requests from other hosts and
cross-site writes.

- `/`: the library and editor.
- `POST /mcp`: the same tools over HTTP, for a client that can only be given
  a URL.
- `POST /api/agent/<op>`: the same tools as plain REST, one JSON body per
  call, for an agent that can run curl but has no MCP client. The `drawing`
  topic lists the operations.

The MCP server and the app are independent. Neither needs the other running,
but they must share a vault to see the same scenes.
