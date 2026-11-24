# Troubleshooting

## The tools do not show up in the client

- A session that was open when the server was added does not see it.
  Start a new session, or restart the app for Claude Desktop.
- Check the registration: `claude mcp list`, `codex mcp list`, or open the
  client's MCP settings. The command should be `sketchdex` with args `mcp`.
- Run `sketchdex --version` in a terminal. If that fails, the client cannot
  find the binary. Use an absolute path.

## "command not found" or permission denied

Use the absolute path to the binary in the client config. On macOS and Linux
make sure it is executable (`chmod +x /path/to/sketchdex`). On Windows use the
`.exe` path. Clients that launch without a shell need the full path.

## render_scene says SKETCHDEX_BROWSER is missing

Set `SKETCHDEX_BROWSER` to a Chromium-based browser binary in the server's
environment before it starts. There is no discovery:

- macOS: `/Applications/Chromium.app/Contents/MacOS/Chromium`
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Linux: `/usr/bin/chromium` or `/usr/bin/google-chrome`

Every other tool works without a browser; `check_scene` finds layout
problems by geometry.

## The first render is slow or times out

The browser starts on the first render, which takes a few seconds; after
that about a second and a half. A call that takes longer than two minutes
is answered with an error rather than hanging. If every render is slow,
`SKETCHDEX_BROWSER` may be pointing at something that is not a Chromium.

## The binary will not start

Reinstall the package or download the release asset again. In a checkout,
run `npm run build:server` after changing Nim source. The native server does
not hot-reload.

## A write was refused for a missing label

Every tool that changes a scene requires `label`, a short note describing the
change. It is what the user reads in the History sidebar when deciding
whether to keep or revert the change. Add one and call again.

## The agent and the app see different scenes

They are using different vaults. `sketchdex vault` prints the default;
if the server was given `--vault` or `SKETCHDEX_VAULT`, start the app with
the same flag. See the `vault` topic.

## The image came back as a preview, or as tiles

The full render is on disk at the `path` in the result. Render a smaller
`region` for detail, or pass `tiles: 1` for one image. See the `rendering`
topic.

## Port 5173 is busy

`sketchdex app` moves to the next free port and prints the URL. Pass
`--port` to choose one.

## Anything else

`sketchdex docs` prints this manual. The source and issue tracker are
at https://github.com/lucasr1b/sketchdex.
