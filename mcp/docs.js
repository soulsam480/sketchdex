import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The manual, served to whoever asks: `sketchdex docs` on the command line,
 * the `sketchdex_docs` tool and `sketchdex://docs/<topic>` resources over
 * MCP, and the copy on the website. One set of files under docs/, plus the
 * agent brief at the package root and a tool list generated from the live
 * tool definitions so it cannot drift.
 *
 * The point is that the person installing this never has to read anything:
 * their agent reads it for them, before install (`npx -y sketchdex docs
 * install`) and after (the tool).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TOPICS = [
  { name: "install", file: "docs/install.md", summary: "Install on Claude Code, Codex, Cursor, VS Code, Claude Desktop, Windsurf, Gemini CLI or any MCP client, and check it works." },
  { name: "vault", file: "docs/vault.md", summary: "Where scenes are stored, how to move the folder, history and trash." },
  { name: "app", file: "docs/app.md", summary: "Opening the app (npx sketchdex app), the library, the editor, the history sidebar, scene links, and the HTTP and REST surfaces it serves." },
  { name: "rendering", file: "docs/rendering.md", summary: "What render_scene needs, how it finds a browser, sizes, tiles, regions and transparency." },
  { name: "tools", file: null, summary: "Every tool with what it is for." },
  { name: "drawing", file: "BRIEF.md", summary: "The drawing manual: element format, the hand-drawn contract, paper and ink, shorthand, the history safety contract." },
  { name: "troubleshooting", file: "docs/troubleshooting.md", summary: "Tools not showing up, npx on Windows, no browser found, slow renders, broken installs, refused writes." },
];

export const TOPIC_NAMES = TOPICS.map((t) => t.name);

/** The index: what there is and how to get it. */
export function index() {
  const lines = TOPICS.map((t) => `- ${t.name}: ${t.summary}`);
  return [
    "# sketchdex docs",
    "",
    "Sketchdex is an MCP server that lets an agent draw hand-drawn Excalidraw diagrams as real .excalidraw files on this machine. This is its manual, by topic.",
    "",
    ...lines,
    "",
    "Read one with `sketchdex docs <topic>` (over npx: `npx -y sketchdex docs <topic>`), the `sketchdex_docs` tool, or the `sketchdex://docs/<topic>` resource. `sketchdex docs all` prints everything.",
    "",
  ].join("\n");
}

/**
 * The tool list, from the definitions themselves. First sentence of each
 * description; the full text is what the client already shows the model.
 */
const toolList = (tools) =>
  [
    "# Tools",
    "",
    `${tools.length} tools over stdio. Every tool that changes a scene requires \`label\`, a short note the user reads in the history sidebar. \`scene\` accepts an id, an exact name, or a unique part of a name.`,
    "",
    ...tools.map((t) => {
      const first = String(t.description ?? "").split(/(?<=\.)\s/)[0];
      return `- \`${t.name}\`: ${first}`;
    }),
    "",
  ].join("\n");

/**
 * One topic as markdown. `tools` is the live TOOLS array, passed in rather
 * than imported so this module stays free of the tool module (which imports
 * it) and cheap to load from the CLI.
 */
export async function readTopic(name, { tools = [] } = {}) {
  if (!name || name === "index") return index();
  if (name === "all") {
    const parts = [];
    for (const t of TOPICS) parts.push(await readTopic(t.name, { tools }));
    return parts.join("\n---\n\n");
  }
  const topic = TOPICS.find((t) => t.name === name);
  if (!topic) {
    throw new Error(`no docs topic "${name}". Topics: ${TOPIC_NAMES.join(", ")}, or all.`);
  }
  if (!topic.file) return toolList(tools);
  return fs.readFile(path.join(root, topic.file), "utf8");
}
