# The vault

Scenes are plain `.excalidraw` files in one folder, the vault. The default is
`~/Documents/sketchdex`. `npx sketchdex vault` prints the folder the server
is actually using.

```
~/Documents/sketchdex/
├── index.json              names, timestamps, pins (a cache, not the truth)
├── scenes/<id>.excalidraw  the scene itself, real Excalidraw format
├── thumbs/<id>.svg         library previews
├── history/<id>/           snapshots taken before agent writes, gzipped
└── trash/<stamp>-<id>.excalidraw
```

The files are the truth. `index.json` is rebuilt from them if it is lost, so
you can copy, sync or version the folder freely. Any scene opens on
excalidraw.com or in any Excalidraw editor as it is.

## Moving it

Pick one:

- `--vault /path/to/folder` after the package name in the client config,
  e.g. `"args": ["-y", "sketchdex", "--vault", "/Users/me/Notes/sketches"]`.
- `SKETCHDEX_VAULT=/path/to/folder` in the server's environment.

`~` is expanded by the flag, since a JSON config never does that itself.
The folder is created on first use. Existing scenes do not move on their
own; copy the `scenes/` folder across and the index rebuilds.

The app and the MCP server must point at the same folder to see the same
scenes. `npx sketchdex app --vault /path` matches the flag above.

## History and trash

Every write through a tool takes a snapshot of the previous state first,
labelled with the note the agent gave it. Snapshots are gzipped, capped at
20 per scene, and never expire on their own. `list_history` shows them,
`restore_snapshot` brings one back, and the app's History sidebar does the
same with a preview.

Deleting a scene moves the file to `trash/` with a timestamp. Nothing in
`trash/` is cleaned up automatically.
