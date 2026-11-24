import std/[json, options, strutils]

import ../mcp/tools

type
  DocTopic* = object
    name*: string
    file*: Option[string]
    summary*: string
    content*: string

const
  InstallContent = staticRead("../../docs/install.md")
  VaultContent = staticRead("../../docs/vault.md")
  AppContent = staticRead("../../docs/app.md")
  RenderingContent = staticRead("../../docs/rendering.md")
  DrawingContent = staticRead("../../BRIEF.md")
  TroubleshootingContent = staticRead("../../docs/troubleshooting.md")

let TOPICS* = @[
  DocTopic(name: "install", file: some("docs/install.md"), summary: "Install on Claude Code, Codex, Cursor, VS Code, Claude Desktop, Windsurf, Gemini CLI or any MCP client, and check it works.", content: InstallContent),
  DocTopic(name: "vault", file: some("docs/vault.md"), summary: "Where scenes are stored, how to move the folder, history and trash.", content: VaultContent),
  DocTopic(name: "app", file: some("docs/app.md"), summary: "Opening the app (npx sketchdex app), the library, the editor, the history sidebar, scene links, and the HTTP and REST surfaces it serves.", content: AppContent),
  DocTopic(name: "rendering", file: some("docs/rendering.md"), summary: "What render_scene needs, how it finds a browser, sizes, tiles, regions and transparency.", content: RenderingContent),
  DocTopic(name: "tools", file: none(string), summary: "Every tool with what it is for.", content: ""),
  DocTopic(name: "drawing", file: some("BRIEF.md"), summary: "The drawing manual: element format, the hand-drawn contract, paper and ink, shorthand, the history safety contract.", content: DrawingContent),
  DocTopic(name: "troubleshooting", file: some("docs/troubleshooting.md"), summary: "Tools not showing up, npx on Windows, no browser found, slow renders, broken installs, refused writes.", content: TroubleshootingContent),
]

proc listTopics*(): seq[string] =
  for topic in TOPICS:
    result.add(topic.name)

proc resourceUri*(name: string): string =
  "sketchdex://docs/" & name

let RESOURCE_URIS* = block:
  var uris: seq[string]
  for topic in TOPICS:
    uris.add(resourceUri(topic.name))
  uris

let RESOURCES* = block:
  var resources = newJArray()
  for topic in TOPICS:
    resources.add(%*{
      "uri": resourceUri(topic.name),
      "name": topic.name,
      "title": "sketchdex docs: " & topic.name,
      "description": topic.summary,
      "mimeType": "text/markdown",
    })
  resources

proc docsIndex(): string =
  var lines = @[
    "# sketchdex docs",
    "",
    "Sketchdex is an MCP server that lets an agent draw hand-drawn Excalidraw diagrams as real .excalidraw files on this machine. This is its manual, by topic.",
    "",
  ]
  for topic in TOPICS:
    lines.add("- " & topic.name & ": " & topic.summary)
  lines.add("")
  lines.add("Read one with `sketchdex docs <topic>` (over npx: `npx -y sketchdex docs <topic>`), the `sketchdex_docs` tool, or the `sketchdex://docs/<topic>` resource. `sketchdex docs all` prints everything.")
  lines.add("")
  lines.join("\n")

proc firstSentence(description: string): string =
  for index in 0 ..< description.len:
    if description[index] == '.' and index + 1 < description.len and
        description[index + 1] in {' ', '\t', '\n', '\r', '\v', '\f'}:
      return description[0 .. index]
  description

proc toolList(): string =
  var lines = @[
    "# Tools",
    "",
    $TOOLS.len & " tools over stdio. Every tool that changes a scene requires `label`, a short note the user reads in the history sidebar. `scene` accepts an id, an exact name, or a unique part of a name.",
    "",
  ]
  for tool in TOOLS:
    lines.add("- `" & tool["name"].getStr & "`: " & firstSentence(tool["description"].getStr))
  lines.add("")
  lines.join("\n")

proc getTopic*(name: string): string =
  if name.len == 0 or name == "index":
    return docsIndex()
  if name == "all":
    var parts: seq[string]
    for topic in TOPICS:
      parts.add(getTopic(topic.name))
    return parts.join("\n---\n\n")

  for topic in TOPICS:
    if topic.name == name:
      if topic.file.isSome:
        return topic.content
      return toolList()

  raise newException(ValueError,
    "no docs topic \"" & name & "\". Topics: " & listTopics().join(", ") & ", or all.")
