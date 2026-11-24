import std/[json, options, os, osproc, streams, strutils, tempfiles, unittest]

import ../server/[history, vault]

type RunResult = tuple[output, stderr: string, exitCode: int]

proc runNode(arguments: openArray[string]): RunResult =
  let process = startProcess("node", args = arguments, options = {poUsePath})
  defer: process.close()
  result.output = process.outputStream.readAll()
  result.stderr = process.errorStream.readAll()
  result.exitCode = process.waitForExit(timeout = 10_000)

proc payload(id: string; appState = newJObject()): JsonNode =
  %*{
    "elements": [%*{
      "id": id,
      "type": "rectangle",
      "isDeleted": false
    }],
    "appState": appState,
    "files": %*{"image": %*{"dataURL": "data:image/png;base64,AA=="}}
  }

proc snapshotCount(history: History; sceneId: string): int =
  for _ in walkFiles(history.root / sceneId / "*.json.gz"): inc result

const NodeGzipFixture = """
import fs from "node:fs";
import zlib from "node:zlib";
const body = {
  elements: [{ id: "node-element", type: "text", isDeleted: false }],
  appState: { viewBackgroundColor: "#121212" }
};
fs.writeFileSync(process.argv[2], zlib.gzipSync(JSON.stringify(body)));
"""

suite "Nim history":
  var tempDir: string
  var store: Vault
  var history: History

  setup:
    tempDir = createTempDir("sketchdex-history-test-", "")
    store = newVault(tempDir / "vault")
    history = newHistory(store)

  teardown:
    removeDir(tempDir)

  test "take stores gzip elements and appState with exact byte counts":
    let sceneId = "scene_one"
    let source = payload("live")
    source["elements"].add(%*{"id": "deleted", "isDeleted": true})
    let entry = history.take(sceneId, source, label = "add shape", origin = "agent")
    check entry["id"].getStr.len == 16
    for ch in entry["id"].getStr:
      check ch in {'0' .. '9', 'a' .. 'f'}
    check entry["label"].getStr == "add shape"
    check entry["origin"].getStr == "agent"
    check entry["elementCount"].getInt == 1
    check entry["at"].getInt > 0

    let path = history.root / sceneId / (entry["id"].getStr & ".json.gz")
    check entry["bytes"].getInt == getFileInfo(path).size.int
    let compressed = readFile(path)
    check compressed[0] == '\x1f'
    check compressed[1] == '\x8b'
    check compressed[2] == '\x08'

    let restored = history.read(sceneId, entry["id"].getStr)
    check restored == %*{
      "elements": source["elements"],
      "appState": source["appState"]
    }
    check not restored.hasKey("files")
    let nodeScript = "const fs=require('node:fs');const zlib=require('node:zlib');console.log(zlib.gunzipSync(fs.readFileSync(process.argv[1])).toString('utf8'))"
    let nodeRun = runNode(["-e", nodeScript, path])
    check nodeRun.exitCode == 0
    check nodeRun.stderr == ""
    check parseJson(nodeRun.output.strip) == restored
    let listing = history.list(sceneId)
    check listing.entries.len == 1
    check listing.bytes == entry["bytes"].getInt

  test "entries stay newest first and snapshots compare after decompression":
    let sceneId = "ordered"
    let source = payload("same")
    let first = history.take(sceneId, source, label = "first")
    let second = history.take(sceneId, source, label = "second")
    let firstPath = history.root / sceneId / (first["id"].getStr & ".json.gz")
    let secondPath = history.root / sceneId / (second["id"].getStr & ".json.gz")
    check fileExists(firstPath)
    check fileExists(secondPath)
    check history.read(sceneId, first["id"].getStr) ==
      history.read(sceneId, second["id"].getStr)
    let listing = history.list(sceneId)
    check listing.entries[0]["id"].getStr == second["id"].getStr
    check listing.entries[1]["id"].getStr == first["id"].getStr
    check listing.bytes == first["bytes"].getInt + second["bytes"].getInt

  test "history keeps only the newest twenty snapshots":
    let sceneId = "capped"
    var firstId = ""
    for index in 0 ..< 22:
      let entry = history.take(sceneId, payload("element-" & $index), label = $index)
      if index == 0: firstId = entry["id"].getStr
    let listing = history.list(sceneId)
    check listing.entries.len == 20
    check listing.entries[0]["label"].getStr == "21"
    check listing.entries[^1]["label"].getStr == "2"
    check snapshotCount(history, sceneId) == 20
    check not fileExists(history.root / sceneId / (firstId & ".json.gz"))
    var byteSum = 0
    for entry in listing.entries: byteSum += entry["bytes"].getInt
    check listing.bytes == byteSum

  test "restore snapshots current state, merges appState, and preserves files":
    let meta = store.create("Restore")
    let sceneId = meta["id"].getStr
    let oldAppState = %*{
      "viewBackgroundColor": "#121212",
      "currentItemStrokeColor": "#e9ecef",
      "shared": "old",
      "onlyOld": true
    }
    discard store.save(sceneId, payload("old-element", oldAppState))
    let snapshot = history.take(sceneId, store.read(sceneId), label = "before edit")

    var current = payload("new-element", %*{"shared": "new", "onlyNew": true})
    current["files"] = %*{"current-image": "current-data"}
    current["custom"] = %*{"keep": true}
    discard store.save(sceneId, current)
    let result = history.restore(store, sceneId, snapshot["id"].getStr)
    check result["restored"].getStr == snapshot["id"].getStr
    check result["elements"].getInt == 1

    let restored = store.read(sceneId)
    check restored["elements"][0]["id"].getStr == "old-element"
    check restored["appState"]["shared"].getStr == "old"
    check restored["appState"]["onlyOld"].getBool
    check restored["appState"]["onlyNew"].getBool
    check restored["files"]["current-image"].getStr == "current-data"
    check restored["custom"]["keep"].getBool
    let listing = history.list(sceneId)
    check listing.entries.len == 2
    check listing.entries[0]["label"].getStr == "restore snapshot"
    check history.isClaimed(sceneId, store.scenePath(sceneId).get)

  test "discard removes one entry and clear removes the scene history":
    let sceneId = "discard"
    let first = history.take(sceneId, payload("one"), label = "one")
    let second = history.take(sceneId, payload("two"), label = "two")
    let entries = history.`discard`(sceneId, first["id"].getStr)
    check entries.len == 1
    check entries[0]["id"].getStr == second["id"].getStr
    check not fileExists(history.root / sceneId / (first["id"].getStr & ".json.gz"))
    check history.read(sceneId, second["id"].getStr)["elements"][0]["id"].getStr == "two"

    check history.clear(sceneId).len == 0
    check not dirExists(history.root / sceneId)
    check history.list(sceneId).entries.len == 0
    check history.list(sceneId).bytes == 0
    check history.clear(sceneId).len == 0

  test "claims use exact stat values and never expire":
    let meta = store.create("Claim")
    let sceneId = meta["id"].getStr
    let path = store.scenePath(sceneId).get
    history.claim(sceneId, path)
    check history.isClaimed(sceneId, path)
    let claimPath = history.root / sceneId / "claim.json"
    let claim = parseJson(readFile(claimPath))
    claim["at"] = %0
    writeFile(claimPath, $claim)
    check history.isClaimed(sceneId, path)

    let file = open(path, fmAppend)
    file.write(" ")
    file.close()
    check not history.isClaimed(sceneId, path)
    history.claim(sceneId, path)
    check history.isClaimed(sceneId, path)

  test "Nim reads gzip bytes produced by Node zlib":
    let sceneId = "node-gzip"
    let snapId = "node-snapshot"
    createDir(history.root / sceneId)
    let scriptPath = "/tmp/sketchdex-node-gzip-fixture-" & $getCurrentProcessId() & ".mjs"
    writeFile(scriptPath, NodeGzipFixture)
    defer: removeFile(scriptPath)
    let snapshotPath = history.root / sceneId / (snapId & ".json.gz")
    let run = runNode([scriptPath, snapshotPath])
    check run.exitCode == 0
    check run.stderr == ""
    check history.read(sceneId, snapId) == %*{
      "elements": [%*{"id": "node-element", "type": "text", "isDeleted": false}],
      "appState": %*{"viewBackgroundColor": "#121212"}
    }

  test "invalid ids follow the Node boundary behavior":
    check history.list("../bad").entries.len == 0
    check history.list("../bad").bytes == 0
    var rejected = false
    try:
      discard history.take("../bad", payload("bad"))
    except ValueError:
      rejected = true
    check rejected
