import std/[json, monotimes, options, os, osproc, strutils, times, unittest]

import ../core/[jsvalue, paper, textmetrics]
import ../server/[agent, history, vault]

let metricsPath = currentSourcePath().parentDir.parentDir.parentDir /
  "server" / "font-metrics.json"
let repoRoot = currentSourcePath().parentDir.parentDir.parentDir

const oracleScript = r"""
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const vault = process.argv[3];
const { createAgentApi } = await import(
  pathToFileURL(path.resolve(repo, "server/agent.js")).href
);
const api = createAgentApi(vault);

const fixed = (type, id, index, fields = {}) => ({
  type, id, index,
  x: 0, y: 0, width: 100, height: 80, angle: 0,
  strokeColor: "#123456", backgroundColor: "transparent",
  fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
  opacity: 100, groupIds: [], frameId: null, seed: 7, version: 1,
  versionNonce: 11, isDeleted: false, boundElements: [], updated: 1,
  link: null, locked: false,
  ...fields
});

const label = fixed("text", "label", "a1", {
  text: "Box label", originalText: "Box label", fontSize: 20, fontFamily: 5
});
const initial = [
  fixed("rectangle", "box", "a0", {
    x: 10, y: 20, width: 200, height: 100, label
  }),
  fixed("text", "note", "a2", {
    x: 20, y: 140, text: "Hello world", originalText: "Hello world",
    fontSize: 20, fontFamily: 5, width: 90, height: 25
  }),
  fixed("ellipse", "ellipse", "a3", {
    x: 260, y: 30, width: 80, height: 60, groupIds: ["g1"]
  }),
  fixed("arrow", "arrow", "a4", {
    x: 210, y: 50, width: 50, height: 20,
    points: [[0, 0], [50, 20]], start: "box", end: "ellipse"
  }),
  fixed("rectangle", "gone", "a5", {
    x: 500, y: 500, isDeleted: true
  })
];

const commands = [
  { name: "create", op: "createScene", args: { name: "Parity", elements: initial } },
  { name: "add", op: "addElements", args: {
    scene: "Parity", label: "add second arrow", elements: [
      fixed("arrow", "added-arrow", "a6", {
        x: 210, y: 90, width: 50, height: 20,
        points: [[0, 0], [50, 20]], start: "box", end: "ellipse"
      })
    ]
  } },
  { name: "describe", op: "describeScene", args: {
    scene: "Parity", type: "text", limit: 1
  } },
  { name: "read-ids", op: "readElements", args: {
    scene: "Parity", ids: ["box", "missing", "note"], limit: 10
  } },
  { name: "read-types", op: "readElements", args: {
    scene: "Parity", type: ["text", "ellipse"], limit: 10
  } },
  { name: "read-contains", op: "readElements", args: {
    scene: "Parity", contains: "BOX", limit: 10
  } },
  { name: "read-region", op: "readElements", args: {
    scene: "Parity", region: { x: 0, y: 0, width: 300, height: 200 }, limit: 10
  } },
  { name: "update-list", op: "updateElements", args: {
    scene: "Parity", label: "move box and grow label", elements: [
      { id: "box", x: 15 },
      { id: "label", text: "A much longer label that needs the container to grow" }
    ]
  } },
  { name: "update-shared", op: "updateElements", args: {
    scene: "Parity", label: "recolour ellipse", ids: ["ellipse"],
    patch: { strokeColor: "#abcdef" }
  } },
  { name: "move", op: "moveElements", args: {
    scene: "Parity", label: "move box", ids: ["missing-b", "box", "missing-a"],
    dx: 5, dy: -3
  } },
  { name: "check", op: "checkScene", args: { scene: "Parity", limit: 20 } },
  { name: "delete", op: "deleteElements", args: {
    scene: "Parity", label: "delete box", ids: ["box"]
  } },
  { name: "move-group", op: "moveElements", args: {
    scene: "Parity", label: "move group", ids: ["missing-group"],
    groupIds: ["g1"], dx: 10, dy: 20
  } },
  { name: "replace", op: "replaceElements", args: {
    scene: "Parity", label: "replace scene", elements: [
      fixed("rectangle", "replacement-a", "a0", { x: 0, y: 0 }),
      fixed("rectangle", "replacement-b", "a1", { x: 150, y: 0 })
    ]
  } },
  { name: "write", op: "writeScene", args: {
    scene: "Parity", label: "write scene", appState: { gridMode: true },
    elements: [fixed("text", "written", "a0", {
      text: "written text", originalText: "written text",
      fontSize: 20, fontFamily: 5, width: 100, height: 25
    })]
  } },
  { name: "background", op: "setBackground", args: {
    scene: "Parity", label: "light paper", color: "#ffffff"
  } },
  { name: "read-scene", op: "readScene", args: {
    scene: "Parity", includeFiles: true
  } },
  { name: "snapshot", op: "snapshotScene", args: {
    scene: "Parity", label: "manual snapshot"
  } },
  { name: "after-snapshot", op: "addElements", args: {
    scene: "Parity", label: "after snapshot", elements: [
      fixed("rectangle", "after-snapshot", "a1", { x: 20, y: 20 })
    ]
  } },
  { name: "history", op: "listHistory", args: { scene: "Parity" } },
  { name: "restore", op: "restoreSnapshot", args: {
    scene: "Parity", snapshot: "$manual"
  } },
  { name: "discard", op: "discardSnapshot", args: {
    scene: "Parity", snapshot: "$manual"
  } },
  { name: "clear", op: "clearHistory", args: { scene: "Parity" } },
  { name: "final-check", op: "checkScene", args: { scene: "Parity", limit: 20 } }
];

let sceneId;
let manualSnapshot;
const capture = async (name, action) => {
  try {
    return { name, ok: true, value: await action() };
  } catch (error) {
    return {
      name, ok: false, error: String(error?.message ?? error),
      ...(error?.status === undefined ? {} : { status: error.status })
    };
  }
};

const results = [];
for (const command of commands) {
  const args = { ...command.args };
  if (args.snapshot === "$manual") args.snapshot = manualSnapshot;
  let action;
  switch (command.op) {
    case "createScene": action = () => api.createScene(args); break;
    case "addElements": action = () => api.addElements(args.scene, args.elements, args); break;
    case "describeScene": action = () => api.describeScene(args.scene, args); break;
    case "readElements": action = () => api.readElements(args.scene, args); break;
    case "readScene": action = () => api.readScene(args.scene, args); break;
    case "updateElements": action = () => api.updateElements(args.scene, args.elements, args); break;
    case "deleteElements": action = () => api.deleteElements(args.scene, args.ids, args); break;
    case "moveElements": action = () => api.moveElements(args.scene, args); break;
    case "replaceElements": action = () => api.replaceElements(args.scene, args.elements, args); break;
    case "writeScene": action = () => api.writeScene(args.scene, args); break;
    case "setBackground": action = () => api.setBackground(args.scene, args.color, args); break;
    case "checkScene": action = () => api.checkScene(args.scene, args); break;
    case "snapshotScene": action = () => api.snapshot(args.scene, args.label); break;
    case "listHistory": action = () => api.listHistory(args.scene); break;
    case "restoreSnapshot": action = () => api.restoreSnapshot(args.scene, args.snapshot); break;
    case "discardSnapshot": action = () => api.discardSnapshot(args.scene, args.snapshot); break;
    case "clearHistory": action = () => api.clearHistory(args.scene); break;
    default: throw new Error("unknown command " + command.op);
  }
  const result = await capture(command.name, action);
  results.push(result);
  if (command.name === "create") sceneId = result.value.sceneId;
  if (command.name === "snapshot") manualSnapshot = result.value.snapshot.id;
}

const stored = JSON.parse(await fs.readFile(api.store.scenePath(sceneId), "utf8"));
console.log(JSON.stringify({ commands, results, stored }));
"""

proc scratchVault(label: string): string =
  result = getTempDir() / ("sketchdex-agent-" & label & "-" & $getCurrentProcessId())
  createDir(result)

proc rectangleSpecs(count: int; prefix: string): JsonNode =
  result = newJArray()
  for index in 0 ..< count:
    result.add(%*{
      "type": "rectangle", "id": prefix & $index,
      "x": (index mod 100) * 10, "y": (index div 100) * 10,
      "width": 20, "height": 15
    })

proc arrowSpecs(count: int; prefix: string): JsonNode =
  result = newJArray()
  for index in 0 ..< count:
    result.add(%*{
      "type": "arrow", "id": prefix & $index,
      "x": (index mod 100) * 10, "y": 600 + (index div 100) * 10,
      "width": 30, "height": 10, "points": [[0, 0], [30, 10]]
    })

proc elapsedMs(start: MonoTime): float =
  float(inNanoseconds(getMonoTime() - start)) / 1_000_000.0

proc nodeText(node: JsonNode): string =
  if node.isNil: "<missing>" else: $node

proc mismatch(actual, expected: JsonNode; path: string): string =
  path & ": actual " & nodeText(actual) & " != expected " & nodeText(expected)

proc divergence(actual, expected: JsonNode; path = "$"): string =
  if actual.isNil or expected.isNil:
    if actual.isNil and expected.isNil: return ""
    return mismatch(actual, expected, path)
  if actual.isNumber and expected.isNumber:
    if actual.kind == JInt and expected.kind == JInt:
      if actual.getInt != expected.getInt: return mismatch(actual, expected, path)
      return ""
    let a = actual.getFloat
    let b = expected.getFloat
    let tolerance = 1e-8 * max(1.0, max(abs(a), abs(b)))
    if abs(a - b) > tolerance: return mismatch(actual, expected, path)
    return ""
  if actual.kind != expected.kind: return mismatch(actual, expected, path)
  case actual.kind
  of JObject:
    for key, value in actual:
      if not expected.hasKey(key): return mismatch(value, nil, path & "." & key)
    for key, value in expected:
      if not actual.hasKey(key): return mismatch(nil, value, path & "." & key)
    for key, value in actual:
      let problem = divergence(value, expected[key], path & "." & key)
      if problem.len > 0: return problem
  of JArray:
    if actual.len != expected.len: return mismatch(actual, expected, path)
    for index in 0 ..< actual.len:
      let problem = divergence(actual[index], expected[index], path & "[" & $index & "]")
      if problem.len > 0: return problem
  else:
    if actual != expected: return mismatch(actual, expected, path)
  ""

proc isHex(value: string): bool =
  if value.len == 0: return false
  for ch in value:
    if ch notin {'0' .. '9', 'a' .. 'f', 'A' .. 'F'}: return false
  true

proc isUuid(value: string): bool =
  value.len == 36 and value[8] == '-' and value[13] == '-' and
    value[18] == '-' and value[23] == '-' and
    isHex(value[0 .. 6] & value[9 .. 11] & value[14 .. 17] &
      value[19 .. 21] & value[24 .. 35])

proc normalise(value: JsonNode; key = ""): JsonNode =
  if value.isNil: return nil
  case value.kind
  of JObject:
    result = newJObject()
    for childKey, child in value:
      result[childKey] = normalise(child, childKey)
  of JArray:
    result = newJArray()
    for child in value:
      if key == "groupIds" and child.kind == JString and
          child.getStr.startsWith("svg-"):
        result.add(%"<group>")
      else:
        result.add(normalise(child, key))
  of JString:
    let text = value.getStr
    case key
    of "sceneId": return %"<scene>"
    of "path", "vault": return %"<path>"
    of "updatedAt", "createdAt", "at": return %"<time>"
    of "rev": return %"<rev>"
    of "groupId": return %"<group>"
    of "id":
      if isUuid(text): return %"<scene>"
      if text.len == 16 and isHex(text): return %"<snapshot>"
    of "restored":
      if text.len == 16 and isHex(text): return %"<snapshot>"
    else: discard
    result = copyNode(value)
  of JInt, JFloat:
    if key in ["seed", "versionNonce", "updated", "bytes", "at", "createdAt"]:
      return %0
    result = copyNode(value)
  else: result = copyNode(value)

proc capture(action: proc(): JsonNode): JsonNode =
  try:
    %*{"ok": true, "value": action()}
  except AgentError as error:
    %*{"ok": false, "error": error.msg, "status": error.status}
  except CatchableError as error:
    %*{"ok": false, "error": error.msg}

proc findElement(elements: JsonNode; id: string): JsonNode =
  for element in elements:
    if element.field("id").stringOr("") == id: return element
  nil

proc executeCommand(api: AgentApi; command: JsonNode;
    manualSnapshot: var string): JsonNode =
  let args = command["args"]
  var snapshot = args.field("snapshot").stringOr("")
  if snapshot == "$manual": snapshot = manualSnapshot
  try:
    var value: JsonNode
    case command["op"].getStr
    of "createScene":
      value = api.createScene(args["name"].getStr, args["elements"])
    of "addElements":
      value = api.addElements(args["scene"].getStr, args["elements"], args["label"].getStr)
    of "describeScene":
      value = api.describeScene(args["scene"].getStr, args["limit"].getInt,
        args["type"].getStr)
    of "readElements":
      value = api.readElements(args["scene"].getStr, args)
    of "readScene":
      value = api.readScene(args["scene"].getStr, args)
    of "updateElements":
      value = api.updateElements(args["scene"].getStr, args.field("elements"),
        args["label"].getStr, args.field("ids"), args.field("patch"))
    of "deleteElements":
      value = api.deleteElements(args["scene"].getStr, args["ids"], args["label"].getStr)
    of "moveElements":
      value = api.moveElements(args["scene"].getStr, args, args["label"].getStr)
    of "replaceElements":
      value = api.replaceElements(args["scene"].getStr, args["elements"], args["label"].getStr)
    of "writeScene":
      value = api.writeScene(args["scene"].getStr, args["elements"],
        args.field("appState"), args["label"].getStr)
    of "setBackground":
      value = api.setBackground(args["scene"].getStr, args["color"].getStr,
        args["label"].getStr)
    of "checkScene":
      value = api.checkScene(args["scene"].getStr, args)
    of "snapshotScene":
      value = api.snapshotScene(args["scene"].getStr, args["label"].getStr)
      manualSnapshot = value["snapshot"]["id"].getStr
    of "listHistory":
      value = api.listHistory(args["scene"].getStr)
    of "restoreSnapshot":
      value = api.restoreSnapshot(args["scene"].getStr, snapshot)
    of "discardSnapshot":
      value = api.discardSnapshot(args["scene"].getStr, snapshot)
    of "clearHistory":
      value = api.clearHistory(args["scene"].getStr)
    else: raise newException(ValueError, "unknown command " & command["op"].getStr)
    %*{"ok": true, "value": value}
  except AgentError as error:
    %*{"ok": false, "error": error.msg, "status": error.status}
  except CatchableError as error:
    %*{"ok": false, "error": error.msg}

suite "agent":
  setup:
    if fileExists(metricsPath): discard loadMetrics(metricsPath)

  test "create, add, and history share one scratch vault":
    let root = scratchVault("first-slice")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let created = api.createScene("First slice", %*[
      {"type": "rectangle", "id": "box", "x": 1, "y": 2, "width": 30, "height": 40}
    ])
    let sceneId = created["sceneId"].getStr
    check created["name"].getStr == "First slice"
    check created["added"].getInt == 1
    check api.scenePath(sceneId)["id"].getStr == sceneId
    check api.scenePath("First slice")["id"].getStr == sceneId
    check api.scenePath("first sli")["id"].getStr == sceneId

    let added = api.addElements(sceneId, %*[
      {"type": "ellipse", "id": "dot", "x": 50, "y": 60}
    ], "add the dot")
    check added["added"].getInt == 1
    check added["elements"][0]["id"].getStr == "dot"

    let scene = api.readScene(sceneId)
    check scene["elements"].len == 2
    check scene["fileIds"].len == 0
    check scene["appState"]["viewBackgroundColor"].getStr == DARK_PAPER
    check scene["appState"]["currentItemStrokeColor"].getStr == INK_ON_DARK

    let history = api.listHistory("First slice")
    check history["entries"].len == 1
    check history["entries"][0]["label"].getStr == "add the dot"
    check history["entries"][0]["elementCount"].getInt == 1
    check history["bytes"].getInt > 0

  test "readScene and readElements return the exact Node key sets":
    let root = scratchVault("read-keys")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Read keys", %*[
      {"type": "rectangle", "id": "box"}
    ])["sceneId"].getStr
    var payload = api.vault.read(sceneId)
    payload["files"] = %*{"asset": {"dataURL": "data:image/png;base64,AA=="}}
    discard api.vault.save(sceneId, payload)

    let excluded = api.readScene(sceneId)
    check excluded.len == 7
    for key in ["id", "name", "path", "vault", "elements", "appState", "fileIds"]:
      check excluded.hasKey(key)
    check not excluded.hasKey("files")
    check excluded["path"].getStr.len > 0
    check excluded["vault"].getStr == root
    check excluded["fileIds"] == %*["asset"]

    let included = api.readScene(sceneId, %*{"includeFiles": true})
    check included.len == 7
    for key in ["id", "name", "path", "vault", "elements", "appState", "files"]:
      check included.hasKey(key)
    check not included.hasKey("fileIds")
    check included["files"]["asset"]["dataURL"].getStr ==
      "data:image/png;base64,AA=="

    let elements = api.readElements(sceneId, nil)
    check elements.len == 5
    for key in ["id", "name", "matched", "truncated", "elements"]:
      check elements.hasKey(key)

  test "resolve prefers id, then exact name, and reports ambiguity":
    let root = scratchVault("resolve")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let first = api.createScene("Alpha board")["sceneId"].getStr
    let second = api.createScene("Beta alpha")["sceneId"].getStr
    let third = api.createScene("Gamma board")["sceneId"].getStr
    let exact = api.createScene("ALPHA")["sceneId"].getStr
    check api.scenePath(first)["id"].getStr == first
    check api.scenePath("alpha board")["id"].getStr == first
    check api.scenePath("alpha")["id"].getStr == exact
    let failure = capture(proc(): JsonNode = api.scenePath("missing"))
    check failure["ok"].getBool == false
    check failure["error"].getStr == "no scene matching \"missing\""
    var candidateLines: seq[string]
    for meta in api.listScenes:
      if meta["name"].getStr.toLowerAscii.contains("board"):
        candidateLines.add("  " & meta["id"].getStr & "  " & meta["name"].getStr)
    let ambiguous = capture(proc(): JsonNode = api.scenePath("board"))
    check ambiguous["error"].getStr ==
      "\"board\" matches 2 scenes. Use an id:\n" & candidateLines.join("\n")
    check api.scenePath(second)["id"].getStr == second
    check api.scenePath(third)["id"].getStr == third

  test "labels are required and a failed build never saves":
    let root = scratchVault("failures")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Failures", %*[
      {"type": "rectangle", "id": "box"}
    ])["sceneId"].getStr
    let before = api.vault.read(sceneId)
    let missingLabel = capture(proc(): JsonNode =
      api.addElements(sceneId, %*[{"type": "rectangle", "id": "new"}], " "))
    check missingLabel["status"].getInt == 400
    check api.listHistory(sceneId)["entries"].len == 0
    let badSnapshot = capture(proc(): JsonNode = api.snapshotScene(sceneId, ""))
    check badSnapshot["status"].getInt == 400
    check badSnapshot["error"].getStr ==
      "label is required: say why this snapshot is being taken"

    let failed = capture(proc(): JsonNode =
      api.addElements(sceneId, %*{"type": "rectangle"}, "bad build"))
    check failed["ok"].getBool == false
    let after = api.vault.read(sceneId)
    check after["rev"].getStr == before["rev"].getStr
    check after["elements"].len == 1
    check api.listHistory(sceneId)["entries"].len == 1

  test "a 409 retries on the newer state with one snapshot and preserved files":
    let root = scratchVault("retry")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Retry", %*[
      {"type": "rectangle", "id": "box"}
    ])["sceneId"].getStr
    var payload = api.vault.read(sceneId)
    payload["files"] = %*{"asset": {"dataURL": "data:image/png;base64,AA=="}}
    discard api.vault.save(sceneId, payload)
    var calls = 0
    api.beforeSave = proc(id, revision: string; saved: JsonNode) =
      if calls == 0:
        var external = api.vault.read(id)
        external["appState"]["external"] = %true
        discard api.vault.save(id, external)
      inc calls
    let added = api.addElements(sceneId, %*[
      {"type": "ellipse", "id": "dot"}
    ], "retry the add")
    check added["added"].getInt == 1
    check calls == 2
    let stored = api.vault.read(sceneId)
    check stored["elements"].len == 2
    check stored["appState"]["external"].getBool == true
    check stored["files"]["asset"]["dataURL"].getStr ==
      "data:image/png;base64,AA=="
    check api.listHistory(sceneId)["entries"].len == 1
    let path = api.vault.scenePath(sceneId).get
    check api.history.isClaimed(sceneId, path)

  test "update grows containers and delete preserves edit bookkeeping":
    let root = scratchVault("elements")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Elements", %*[
      {
        "type": "rectangle", "id": "box", "width": 120, "height": 40,
        "seed": 7, "versionNonce": 11, "updated": 13,
        "label": {
          "type": "text", "id": "label", "text": "short", "width": 40,
          "height": 25, "seed": 17, "versionNonce": 19, "updated": 23
        }
      }
    ])["sceneId"].getStr
    let updated = api.updateElements(sceneId, %*[
      {"id": "label", "text": "a label long enough to wrap and grow"}
    ], "grow label")
    check updated["updated"].getInt == 1
    var scene = api.vault.read(sceneId)
    check findElement(scene["elements"], "box")["height"].getInt > 40
    let boxNonce = findElement(scene["elements"], "box")["versionNonce"].getInt
    let boxUpdated = findElement(scene["elements"], "box")["updated"].getBiggestInt
    let labelNonce = findElement(scene["elements"], "label")["versionNonce"].getInt
    let labelUpdated = findElement(scene["elements"], "label")["updated"].getBiggestInt
    let deleted = api.deleteElements(sceneId, %*["box"], "delete box")
    check deleted["deleted"].getInt == 2
    scene = api.vault.read(sceneId)
    let box = findElement(scene["elements"], "box")
    let label = findElement(scene["elements"], "label")
    check box["isDeleted"].getBool == true
    check label["isDeleted"].getBool == true
    check box["versionNonce"].getInt == boxNonce
    check box["updated"].getBiggestInt == boxUpdated
    check label["versionNonce"].getInt == labelNonce
    check label["updated"].getBiggestInt == labelUpdated

  test "move follows labels and arrow ends with request-order missing ids":
    let root = scratchVault("move")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Move", %*[
      {
        "type": "rectangle", "id": "box", "x": 0, "y": 0,
        "label": {"type": "text", "id": "label", "text": "label"}
      },
      {
        "type": "ellipse", "id": "ellipse", "x": 200, "y": 0,
        "groupIds": ["g1"]
      },
      {
        "type": "arrow", "id": "arrow", "x": 120, "y": 20,
        "points": [[0, 0], [80, 0]], "width": 80, "height": 0,
        "start": "box", "end": "ellipse"
      }
    ])["sceneId"].getStr
    let moved = api.moveElements(sceneId, %*{
      "ids": ["missing-b", "box", "missing-a"], "dx": 10, "dy": 20
    }, "move box")
    check moved["moved"].getInt == 2
    check moved["followed"].getInt == 1
    check moved["missing"] == %*["missing-b", "missing-a"]
    var scene = api.vault.read(sceneId)
    check findElement(scene["elements"], "label")["x"].getInt == 15
    check findElement(scene["elements"], "arrow")["points"][1][0].getInt == 70
    let grouped = api.moveElements(sceneId, %*{
      "groupIds": ["g1"], "region": newJObject(), "dx": -5, "dy": 0
    }, "move all")
    check grouped["moved"].getInt == 1
    check grouped["followed"].getInt == 1
    scene = api.vault.read(sceneId)
    check findElement(scene["elements"], "ellipse")["x"].getInt == 195

  test "SVG import and scene inspection use the exported modules":
    let root = scratchVault("svg")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("SVG")["sceneId"].getStr
    let svg = "<svg viewBox=\"0 0 20 20\"><rect x=\"1\" y=\"2\" width=\"10\" height=\"12\" /></svg>"
    let imported = api.importSvg(sceneId, svg, %*{"group": false}, "import rect")
    check imported["added"].getInt == 1
    check imported["groupId"].kind == JNull
    check imported["ids"].len == 1
    check imported["placed"]["width"].getInt == 20
    let scene = api.vault.read(sceneId)
    check scene["elements"][0]["type"].getStr == "rectangle"
    check scene["elements"][0]["strokeColor"].getStr == INK_ON_DARK
    let grouped = api.importSvg(sceneId, svg, nil, "import grouped rect")
    check grouped["groupId"].getStr.startsWith("svg-")
    check api.vault.read(sceneId)["elements"][1]["groupIds"][0].getStr ==
      grouped["groupId"].getStr
    let nullOptions = api.importSvg(sceneId, svg, newJNull(), "import null options")
    check nullOptions["added"].getInt == 1
    let inspection = api.checkScene(sceneId, %*{"limit": 1})
    check inspection["elements"].getInt == 3
    check inspection.hasField("problems")

  test "restore, discard, clear, and external observation keep history honest":
    let root = scratchVault("history")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("History", %*[
      {"type": "rectangle", "id": "box"}
    ])["sceneId"].getStr
    let snap = api.snapshotScene(sceneId, "manual")["snapshot"]["id"].getStr
    discard api.addElements(sceneId, %*[{"type": "ellipse", "id": "dot"}], "add dot")
    let restored = api.restoreSnapshot(sceneId, snap)
    check restored["restored"].getStr == snap
    check restored["elements"].getInt == 1
    check api.vault.read(sceneId)["elements"].len == 1
    check api.listHistory(sceneId)["entries"].len == 3
    check api.discardSnapshot(sceneId, snap)["entries"].len == 2
    check api.clearHistory(sceneId)["entries"].len == 0

    discard api.readScene(sceneId)
    var external = api.vault.read(sceneId)
    external["appState"]["outside"] = %true
    discard api.vault.save(sceneId, external)
    let entry = api.noteExternalChange(sceneId)
    check entry["label"].getStr == "edited outside Sketchdex"
    check entry["origin"].getStr == "external"
    discard api.vault.delete(sceneId)
    check api.noteExternalChange(sceneId).kind == JNull

  test "parsed scene cache serves mutations and invalidates on disk changes":
    let root = scratchVault("cache")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Cache", rectangleSpecs(5000, "base-"))["sceneId"].getStr
    check api.vaultReadCount == 0
    discard api.addElements(sceneId, %*[{"type": "ellipse", "id": "first"}], "first add")
    check api.vaultReadCount == 1
    discard api.addElements(sceneId, %*[{"type": "ellipse", "id": "second"}], "second add")
    check api.vaultReadCount == 1
    check api.vault.read(sceneId)["elements"].len == 5002

    var external = api.vault.read(sceneId)
    external["appState"]["uiSave"] = %true
    discard api.vault.save(sceneId, external)
    discard api.addElements(sceneId, %*[{"type": "ellipse", "id": "third"}], "third add")
    check api.vaultReadCount == 2
    check api.vault.read(sceneId)["appState"]["uiSave"].getBool == true

    discard api.readScene(sceneId)
    discard api.describeScene(sceneId, 1)
    discard api.readElements(sceneId, %*{"limit": 1})
    discard api.checkScene(sceneId, %*{"limit": 1})
    discard api.snapshotScene(sceneId, "cached snapshot")
    check api.vaultReadCount == 2

  test "scene cache evicts least recently used scenes at five":
    let root = scratchVault("cache-lru")
    defer: removeDir(root)
    let api = newAgentApi(root)
    var ids: seq[string]
    for index in 0 ..< 6:
      ids.add(api.createScene("Scene " & $index)["sceneId"].getStr)
    for id in ids: discard api.readScene(id)
    check api.vaultReadCount == 6
    for index in 1 .. 5: discard api.readScene(ids[index])
    check api.vaultReadCount == 6
    discard api.readScene(ids[0])
    check api.vaultReadCount == 7
    discard api.readScene(ids[1])
    check api.vaultReadCount == 8
    discard api.deleteScene(ids[2])
    let deleted = capture(proc(): JsonNode = api.readScene(ids[2]))
    check deleted["ok"].getBool == false

  test "benchmark first and cached addElements on 5000 elements":
    let root = scratchVault("cache-benchmark")
    defer: removeDir(root)
    let api = newAgentApi(root)
    let sceneId = api.createScene("Benchmark", rectangleSpecs(5000, "base-"))["sceneId"].getStr
    var stageStart = getMonoTime()
    var preSaveMs = 0.0
    api.beforeSave = proc(id, revision: string; saved: JsonNode) =
      preSaveMs = elapsedMs(stageStart)
    let firstStart = getMonoTime()
    stageStart = firstStart
    discard api.addElements(sceneId, arrowSpecs(100, "first-"), "first benchmark add")
    let firstMs = elapsedMs(firstStart)
    let firstPreSaveMs = preSaveMs
    let firstSaveMs = firstMs - preSaveMs
    check api.vaultReadCount == 1
    let cachedStart = getMonoTime()
    stageStart = cachedStart
    discard api.addElements(sceneId, arrowSpecs(100, "cached-"), "cached benchmark add")
    let cachedMs = elapsedMs(cachedStart)
    let cachedPreSaveMs = preSaveMs
    let cachedSaveMs = cachedMs - preSaveMs
    check api.vaultReadCount == 1
    check api.vault.read(sceneId)["elements"].len == 5200
    echo "agent cache benchmark: first=", firstMs.formatFloat(ffDecimal, 3),
      "ms cached=", cachedMs.formatFloat(ffDecimal, 3),
      "ms vaultReads=", api.vaultReadCount
    echo "agent cache stages: firstPreSave=", firstPreSaveMs.formatFloat(ffDecimal, 3),
      "ms firstSave=", firstSaveMs.formatFloat(ffDecimal, 3),
      "ms cachedPreSave=", cachedPreSaveMs.formatFloat(ffDecimal, 3),
      "ms cachedSave=", cachedSaveMs.formatFloat(ffDecimal, 3), "ms"

  test "agent results and stored scenes match the Node oracle":
    let root = scratchVault("parity")
    defer: removeDir(root)
    let nodeVault = root / "node"
    let nimVault = root / "nim"
    createDir(nodeVault)
    createDir(nimVault)
    let scriptPath = root / "oracle.mjs"
    writeFile(scriptPath, oracleScript)
    let output = execProcess("node", args = [scriptPath, repoRoot, nodeVault],
      options = {poUsePath})
    let oracle = parseJson(output)
    check oracle["commands"].kind == JArray
    check oracle["results"].kind == JArray
    let api = newAgentApi(nimVault)
    var manualSnapshot = ""
    var sceneId = ""
    for index in 0 ..< oracle["commands"].len:
      let command = oracle["commands"][index]
      let executed = executeCommand(api, command, manualSnapshot)
      var actual = copyNode(executed)
      actual["name"] = %command["name"].getStr
      if command["name"].getStr == "create":
        sceneId = actual["value"]["sceneId"].getStr
      let expected = oracle["results"][index]
      let problem = divergence(normalise(actual), normalise(expected),
        "$.results[" & command["name"].getStr & "]")
      if problem.len > 0: echo "agent mismatch: ", problem
      check problem.len == 0
    let storedPath = api.vault.scenePath(sceneId).get
    let stored = parseFile(storedPath)
    let storedProblem = divergence(normalise(stored), normalise(oracle["stored"]))
    if storedProblem.len > 0: echo "stored scene mismatch: ", storedProblem
    check storedProblem.len == 0
