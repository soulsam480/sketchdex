# Troubleshooting

## The tools do not show up in the client

- A session that was open when the server was added does not see it.
  Start a new session, or restart the app for Claude Desktop.
- Check the registration: `claude mcp list`, `codex mcp list`, or open the
  client's MCP settings. The command should be `npx` with args `-y sketchdex`.
- Run `npx -y sketchdex --version` in a terminal. If that fails, the problem
  is Node or npm, not the client. Node 20 or newer is required
  (`node --version`).

## "spawn npx ENOENT" or "command not found" (Windows)

Some clients launch the server without a shell, and on Windows `npx` is a
`.cmd` script that needs one. Wrap it:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "sketchdex"]
}
```

On macOS and Linux the same error usually means Node was installed through
a version manager the client does not load. Use the full path to `npx`
(`which npx`) as the command.

## render_scene says no browser was found

It needs Chrome, Chromium, Edge or Brave. Install one, or point
`SKETCHDEX_BROWSER` at the browser binary in the server's `env`:

- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Linux: `/usr/bin/google-chrome` or `/usr/bin/chromium`

Every other tool works without a browser; `check_scene` finds layout
problems by geometry.

## The first render is slow or times out

The browser starts on the first render, which takes a few seconds; after
that about a second and a half. A call that takes longer than two minutes
is answered with an error rather than hanging. If every render is slow,
`SKETCHDEX_BROWSER` may be pointing at something that is not a Chromium.

## "worker failed to start" or "could not load its own source"

The installed package is damaged, usually a broken npx cache. Clear it and
try again:

```bash
npx clear-npx-cache
npx -y sketchdex --version
```

In a git checkout the same message means a source file was caught mid-save;
it retries on its own.

## A write was refused for a missing label

Every tool that changes a scene requires `label`, a short note describing the
change. It is what the user reads in the History sidebar when deciding
whether to keep or revert the change. Add one and call again.

## The agent and the app see different scenes

They are using different vaults. `npx sketchdex vault` prints the default;
if the server was given `--vault` or `SKETCHDEX_VAULT`, start the app with
the same flag. See the `vault` topic.

## The image came back as a preview, or as tiles

The full render is on disk at the `path` in the result. Render a smaller
`region` for detail, or pass `tiles: 1` for one image. See the `rendering`
topic.

## Port 5173 is busy

`npx sketchdex app` moves to the next free port and prints the URL. Pass
`--port` to choose one.

## Anything else

`npx -y sketchdex docs` prints this manual. The source and issue tracker are
at https://github.com/lucasr1b/sketchdex.
