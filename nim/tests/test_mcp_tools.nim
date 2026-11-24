import std/[json, os, osproc, sets, tables, tempfiles, unittest]

import ../mcp/tools

const repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))

const oracleScript = r"""
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const { TOOLS, INSTRUCTIONS, dispatch } = await import(
  pathToFileURL(path.resolve(repo, "mcp/tools.js")).href
);
const operationNames = [
  "opListScenes", "opDescribeScene", "opReadElements", "opReadScene",
  "opCreateScene", "opAddElements", "opUpdateElements", "opDeleteElements",
  "opMoveElements", "opReplaceScene", "opSetBackground", "opRenderScene",
  "opImportSvg", "opCheckScene", "opSketchdexInfo", "opSketchdexDocs",
  "opSnapshotScene", "opListHistory", "opRestoreSnapshot",
];
const requiredKeys = Object.fromEntries(
  TOOLS.map((tool) => [tool.name, tool.inputSchema.required ?? []]),
);
const api = new Proxy({}, {
  get(_target, property) {
    if (property === "vault") return "/tmp/sketchdex-oracle-vault";
    return () => { throw new Error("HANDLER_REACHED"); };
  },
});
const validations = [];
async function validate(tool, args, omitArgs = false) {
  const result = await dispatch(api, tool, omitArgs ? undefined : args);
  const text = result.content?.[0]?.text;
  validations.push({
    tool,
    args,
    omitArgs,
    expected: result.isError && text !== "HANDLER_REACHED" ? text : "",
  });
}
for (const tool of TOOLS) {
  const required = requiredKeys[tool.name];
  await validate(tool.name, {}, true);
  await validate(tool.name, null);
  await validate(tool.name, {});
  for (const value of [0, false, "", [], ["scene"]]) {
    await validate(tool.name, value);
  }
  await validate(tool.name, Object.fromEntries(required.map((key) => [key, ""])));
  for (const key of required) {
    const others = Object.fromEntries(
      required.filter((name) => name !== key).map((name) => [name, null]),
    );
    await validate(tool.name, others);
    await validate(tool.name, { ...others, [key]: "" });
  }
  if (required.length > 0) {
    for (const value of [null, 0, false, [], {}, " "]) {
      const args = Object.fromEntries(required.map((key, index) => [
        key,
        index === 0 ? value : null,
      ]));
      await validate(tool.name, args);
    }
  }
}
process.stdout.write(JSON.stringify({
  tools: TOOLS,
  instructions: INSTRUCTIONS,
  requiredKeys,
  validations,
  operations: Object.fromEntries(TOOLS.map((tool, index) => [
    tool.name,
    operationNames[index],
  ])),
}));
"""

proc loadOracle(): JsonNode =
  let tempDir = createTempDir("sketchdex-mcp-tools-", "", "/tmp")
  let scriptPath = tempDir / "oracle.mjs"
  writeFile(scriptPath, oracleScript)
  try:
    let output = execProcess("node", args = [scriptPath, repoRoot], options = {poUsePath})
    parseJson(output)
  finally:
    removeDir(tempDir)

proc stringSeq(node: JsonNode): seq[string] =
  for value in node:
    result.add(value.getStr)

let oracle = loadOracle()

suite "MCP tools":
  test "all tool schemas match Node structurally and in order":
    check TOOLS.len == 19
    check TOOLS == oracle["tools"]
    var names: seq[string]
    var expectedNames: seq[string]
    for tool in TOOLS:
      names.add(tool["name"].getStr)
    for tool in oracle["tools"]:
      expectedNames.add(tool["name"].getStr)
    check names == expectedNames

  test "server instructions match exactly":
    check INSTRUCTIONS == oracle["instructions"].getStr

  test "required keys match every Node schema":
    check requiredKeys.len == oracle["requiredKeys"].len
    for tool in TOOLS:
      let name = tool["name"].getStr
      check requiredKeys.hasKey(name)
      check requiredKeys.getOrDefault(name) == stringSeq(oracle["requiredKeys"][name])

  test "required key validation matches Node dispatch":
    check oracle["validations"].len == 319
    for entry in oracle["validations"]:
      let args =
        if entry["omitArgs"].getBool: nil
        elif entry["args"].kind == JNull: newJNull()
        else: entry["args"]
      check validateArgs(entry["tool"].getStr, args) == entry["expected"].getStr

  test "dispatch operations cover the same tools with distinct values":
    let expectedOperations = [
      ("list_scenes", opListScenes),
      ("describe_scene", opDescribeScene),
      ("read_elements", opReadElements),
      ("read_scene", opReadScene),
      ("create_scene", opCreateScene),
      ("add_elements", opAddElements),
      ("update_elements", opUpdateElements),
      ("delete_elements", opDeleteElements),
      ("move_elements", opMoveElements),
      ("replace_scene", opReplaceScene),
      ("set_background", opSetBackground),
      ("render_scene", opRenderScene),
      ("import_svg", opImportSvg),
      ("check_scene", opCheckScene),
      ("sketchdex_info", opSketchdexInfo),
      ("sketchdex_docs", opSketchdexDocs),
      ("snapshot_scene", opSnapshotScene),
      ("list_history", opListHistory),
      ("restore_snapshot", opRestoreSnapshot),
    ]
    check OPERATIONS.len == expectedOperations.len
    var seen: HashSet[ToolOperation]
    for (name, operation) in expectedOperations:
      check OPERATIONS.getOrDefault(name) == operation
      check oracle["operations"][name].getStr == $operation
      seen.incl(operation)
    check seen.len == expectedOperations.len
