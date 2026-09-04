# Install

Sketchdex is a stdio MCP server published on npm as `sketchdex`. Every client
below runs the same command: `npx -y sketchdex`. Nothing is installed globally
and there is no account.

Needs Node 20 or newer. Rendering (`render_scene`) needs a Chromium-based
browser on the machine: Chrome, Chromium, Edge or Brave. Everything else works
without one.

## Claude Code

```bash
claude mcp add --scope user sketchdex -- npx -y sketchdex
```

`--scope user` registers it for every project. Check with `claude mcp list`,
or `/mcp` inside a session. A session that was already open needs restarting
before the tools show up.

## Codex

```bash
codex mcp add sketchdex -- npx -y sketchdex
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sketchdex]
command = "npx"
args = ["-y", "sketchdex"]
```

## Cursor

Global: `~/.cursor/mcp.json`. Per project: `.cursor/mcp.json` in the repo.

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

Cursor also opens a one-click install from this link:
`cursor://anysphere.cursor-deeplink/mcp/install?name=sketchdex&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNrZXRjaGRleCJdfQ==`

## VS Code (Copilot agent mode)

```bash
code --add-mcp '{"name":"sketchdex","command":"npx","args":["-y","sketchdex"]}'
```

Or in `.vscode/mcp.json` (note the key is `servers`, not `mcpServers`):

```json
{
  "servers": {
    "sketchdex": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sketchdex"]
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
      "command": "npx",
      "args": ["-y", "sketchdex"]
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`, same `mcpServers` block as Cursor.

## Gemini CLI

```bash
gemini mcp add sketchdex npx -y sketchdex
```

## Anything else

Any client that can launch a stdio MCP server: command `npx`, arguments
`-y sketchdex`. If the client takes a single command string, use
`npx -y sketchdex`.

## Options

Add these after the package name in `args`, so they work in every client:

- `--vault /path/to/folder` stores scenes somewhere other than
  `~/Documents/sketchdex`. An iCloud or Dropbox folder is fine.

Or set the environment variables `SKETCHDEX_VAULT` and `SKETCHDEX_BROWSER`
in the server's `env` block. See the `vault` and `rendering` topics.

## Check it works

In a session, ask: *draw me how the event loop works using sketchdex*. The
agent should call `create_scene`, then `render_scene`, and show a PNG. To
see and edit the result, run `npx sketchdex app`: it opens the library in
the browser, and the new scene is the first card. The `app` topic covers
the interface.
