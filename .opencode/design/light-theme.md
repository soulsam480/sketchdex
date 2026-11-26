# Light theme

The chrome theme is a preference. Canvas colours are authored data.

```mermaid
flowchart TD
  S["localStorage sketchdex:theme"] --> B["index.html no-flash script"]
  B --> D["html data-theme"]
  B --> M["meta theme-color"]
  D --> T["CSS tokens in @layer base"]
  T --> C["chrome: ink, graphite, chalk, violet-ink, hairline, scrollbar, error"]
  D --> E["useTheme subscribers"]
  E --> P["Excalidraw theme prop"]
  D --> N["App new-scene paper"]
  N --> Q["createScene name, paper"]
  Q --> R["POST /api/scenes paper"]
  R --> V["vault.create paper"]
  V --> F["freshAppState paper"]
  F --> W["scene viewBackgroundColor"]
  S --> U["storage event in other tabs"]
  U --> E
```

| Mode | New app scene paper | Default ink |
| --- | --- | --- |
| light | `#ffffff` | `#1e1e1e` |
| dark | `#121212` | `#e9ecef` |

Rules:

- Existing scenes keep their `viewBackgroundColor`. The theme never writes a
  scene file.
- Agent and MCP callers omit `paper`, so their new scenes stay dark.
- The canvas filter is off in both themes. No pixel is inverted.
- Exports read scene data, not chrome, so output stays byte-identical.
