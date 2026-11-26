# Install

Sketchdex is a native stdio MCP server. Every client below runs the same
command: `sketchdex mcp`. The binary owns the vault, the MCP transport, the
app, and rendering orchestration.

The one-line install:

```bash
curl -fsSL https://raw.githubusercontent.com/soulsam480/sketchdex/main/install.sh | bash
```

It installs `~/.local/bin/sketchdex` and the UI assets under
`~/.local/share/sketchdex`. Override the prefix with `SKETCHDEX_PREFIX`, or a
specific version with `SKETCHDEX_VERSION`.

Or download the release tarball for your platform from
`https://github.com/soulsam480/sketchdex/releases`, extract it, and put the
binary on `PATH`. The tarball holds the binary and the `dist/` folder it serves,
so keep them together.

Set `SKETCHDEX_BROWSER` to a Chromium-based browser binary before using
`render_scene`. There is no discovery. Everything else works without a
browser.

## Claude Code

```bash
claude mcp add --scope user sketchdex -- sketchdex mcp
```

Use the absolute binary path if `sketchdex` is not on the client's `PATH`.

## Codex

```bash
codex mcp add sketchdex -- sketchdex mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sketchdex]
command = "sketchdex"
args = ["mcp"]
```

## Cursor

Global: `~/.cursor/mcp.json`. Per project: `.cursor/mcp.json` in the repo.

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

## VS Code (Copilot agent mode)

```bash
code --add-mcp '{"name":"sketchdex","command":"sketchdex","args":["mcp"]}'
```

Or in `.vscode/mcp.json` (the key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "sketchdex": {
      "type": "stdio",
      "command": "sketchdex",
      "args": ["mcp"]
    }
  }
}
```

## Claude Desktop

Edit `claude_desktop_config.json` and restart the app.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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

## Windsurf

`~/.codeium/windsurf/mcp_config.json`, same `mcpServers` block as Cursor.

## Gemini CLI

```bash
gemini mcp add sketchdex sketchdex mcp
```

## Anything else

Any client that can launch a stdio MCP server: command `sketchdex`, arguments
`mcp`. If the client takes a single command string, use `sketchdex mcp`.

## Options

Add these after `mcp`:

- `--vault /path/to/folder` stores scenes somewhere other than
  `~/Documents/sketchdex`. An iCloud or Dropbox folder is fine.
- `--serve` also starts the app on `--port` (default 5173) and opens it, so you
  can watch scenes change as the agent draws. `--no-open` suppresses the
  browser. The app stops when the session ends.
- `SKETCHDEX_MCP_SERVE=1` turns `--serve` on, and `SKETCHDEX_NO_OPEN=1` turns
  the browser off, so a client `env` block can set this once.

Set `SKETCHDEX_VAULT`, `SKETCHDEX_BROWSER`, and `SKETCHDEX_METRICS` in the
client's `env` block when you prefer environment configuration.

## Check it works

In a session, ask: *draw me how the event loop works using sketchdex*. The
agent should call `create_scene`, then `render_scene`, and show a PNG. To see
and edit the result, run `sketchdex app`: it opens the library in the browser,
and the new scene is the first card. The `app` topic covers the interface.
