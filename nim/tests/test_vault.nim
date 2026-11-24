import std/[json, locks, monotimes, options, os, osproc, streams, strutils, tempfiles, times, unittest]

import ../core/jsvalue
import ../server/[lock, vault, watch]

const repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))

type EventSink = object
  events: seq[WatchChange]
  mutex: Lock

proc record(sink: ptr EventSink; change: WatchChange) {.gcsafe.} =
  sink.mutex.withLock:
    sink.events.add(change)

proc changes(sink: ptr EventSink): seq[WatchChange] =
  sink.mutex.withLock:
    result = sink.events

proc waitForEvents(sink: ptr EventSink; count: int; timeoutMs = 3_000): bool =
  let deadline = getMonoTime() + initDuration(milliseconds = timeoutMs)
  while getMonoTime() < deadline:
    if changes(sink).len >= count: return true
    sleep(25)
  false

proc runNode(arguments: openArray[string]): tuple[output, stderr: string, exitCode: int] =
  let process = startProcess("node", args = arguments, options = {poUsePath})
  defer: process.close()
  result.output = process.outputStream.readAll()
  result.stderr = process.errorStream.readAll()
  result.exitCode = process.waitForExit(timeout = 10_000)

proc samplePayload(elementId: string): JsonNode =
  %*{
    "elements": [%*{"id": elementId, "type": "rectangle", "isDeleted": false}],
    "appState": %*{"viewBackgroundColor": "#121212"},
    "files": %*{}
  }

proc normalizeMeta(value: JsonNode): JsonNode =
  result = copyNode(value)
  result["id"] = %"<id>"
  result["createdAt"] = %0
  result["updatedAt"] = %0

const NodeStoreFixture = """
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [storeModule, vaultPath, payloadPath] = process.argv.slice(2);
const { createStore } = await import(pathToFileURL(storeModule));
const store = createStore(vaultPath);
const payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
const meta = await store.create({ name: "Node fixture" });
await store.save(meta.id, payload, { touch: false });
"""

suite "Nim vault":
  var tempDir, root: string
  var store: Vault

  setup:
    tempDir = createTempDir("sketchdex-vault-test-", "")
    root = tempDir / "vault"
    store = newVault(root)

  teardown:
    removeDir(tempDir)

  test "SKETCHDEX_VAULT supplies the default root":
    let hadValue = existsEnv("SKETCHDEX_VAULT")
    let oldValue = getEnv("SKETCHDEX_VAULT")
    let configured = tempDir / "environment-vault"
    putEnv("SKETCHDEX_VAULT", configured)
    defer:
      if hadValue: putEnv("SKETCHDEX_VAULT", oldValue)
      else: delEnv("SKETCHDEX_VAULT")
    let environmentStore = newVault()
    check environmentStore.root == absolutePath(configured)
    check dirExists(environmentStore.scenesDir)

  test "create writes the Excalidraw shape and save preserves unknown fields":
    let meta = store.create("First")
    let id = meta["id"].getStr
    check id.len == 36
    check id[8] == '-' and id[13] == '-' and id[18] == '-' and id[23] == '-'
    check dirExists(store.scenesDir)
    check dirExists(store.trashDir)
    check dirExists(store.historyDir)

    let path = store.scenePath(id).get
    let raw = parseJson(readFile(path))
    check raw["type"].getStr == "excalidraw"
    check raw["version"].getInt == 2
    check raw["source"].getStr == "sketchdex"
    check raw["name"].getStr == "First"
    check raw["elements"].len == 0
    check raw["appState"]["viewBackgroundColor"].getStr == "#121212"
    check raw["appState"]["currentItemStrokeColor"].getStr == "#e9ecef"
    check raw["files"].len == 0

    let before = store.read(id)
    var payload = samplePayload("rectangle-1")
    payload["custom"] = %*{"keep": [1, true, "value"]}
    discard store.save(id, payload, SaveOptions(touch: true, ifRev: some(before["rev"].getStr)))
    let after = store.read(id)
    check after["rev"].getStr != before["rev"].getStr
    check after["custom"]["keep"][2].getStr == "value"
    check after["type"].getStr == "excalidraw"
    check store.list()[0]["elementCount"].getInt == 1

  test "conditional conflict carries the current revision and missing files still save":
    let meta = store.create("Conflict")
    let id = meta["id"].getStr
    let original = store.read(id)
    discard store.save(id, samplePayload("newer"))
    let current = store.rev(id).get

    var conflict: ref SceneConflict
    try:
      discard store.save(id, samplePayload("stale"),
        SaveOptions(touch: true, ifRev: some(original["rev"].getStr)))
    except SceneConflict as error:
      conflict = error
    check not conflict.isNil
    if not conflict.isNil:
      check conflict.status == 409
      check conflict.code == "conflict"
      check conflict.currentRev == current
    check store.read(id)["elements"][0]["id"].getStr == "newer"

    discard store.save("missing", samplePayload("created"),
      SaveOptions(touch: true, ifRev: some("not-the-current-revision")))
    check fileExists(store.scenePath("missing").get)
    check store.read("missing")["elements"][0]["id"].getStr == "created"
    check store.scenePath("../escape").isNone

  test "revision formatting matches Node stat":
    let meta = store.create("Revision")
    let id = meta["id"].getStr
    discard store.save(id, samplePayload("fractional-time"))
    let path = store.scenePath(id).get
    let script = "const fs=require('node:fs');const s=fs.statSync(process.argv[1]);console.log(`${s.mtimeMs}-${s.size}`)"
    let run = runNode(["-e", script, path])
    check run.exitCode == 0
    check run.stderr == ""
    check store.rev(id).get == run.output.strip()

  test "list and delete keep index order and move scenes to dot trash":
    let first = store.create("First")["id"].getStr
    let second = store.create("Second")["id"].getStr
    let listed = store.list()
    check listed.len == 2
    check listed[0]["id"].getStr == second
    check listed[1]["id"].getStr == first

    discard store.delete(first)
    check not fileExists(store.scenePath(first).get)
    check store.list().len == 1
    check store.list()[0]["id"].getStr == second
    var trashCount = 0
    for path in walkFiles(store.trashDir / "*.excalidraw"):
      check path.endsWith("-" & first & ".excalidraw")
      inc trashCount
    check trashCount == 1
    discard store.delete(first)

  test "valid stale indexes stay stale and corrupt or missing indexes rebuild":
    let meta = store.create("Recoverable")
    let id = meta["id"].getStr
    let stale = %*[{
      "id": "stale",
      "name": "Stale entry",
      "createdAt": 1,
      "updatedAt": 2,
      "elementCount": 0
    }]
    writeFile(store.indexFile, pretty(stale, indent = 2))
    check store.list() == stale

    writeFile(store.indexFile, "{")
    let rebuilt = store.list()
    check rebuilt.len == 1
    check rebuilt[0]["id"].getStr == id
    check rebuilt[0]["name"].getStr == "Recoverable"

    removeFile(store.indexFile)
    writeFile(store.scenesDir / "bad!.excalidraw", "{}")
    check store.list().len == 1
    check parseJson(readFile(store.indexFile)).len == 1

  test "startup removes abandoned atomic temp files":
    let sceneTemp = store.scenesDir / "abandoned.excalidraw.123.4.tmp"
    let indexTemp = store.root / "index.json.123.4.tmp"
    let historyTemp = store.historyDir / "log.json.123.4.tmp"
    writeFile(sceneTemp, "partial")
    writeFile(indexTemp, "partial")
    writeFile(historyTemp, "partial")
    discard newVault(root)
    check not fileExists(sceneTemp)
    check not fileExists(indexTemp)
    check not fileExists(historyTemp)

  test "real Node store fixture matches scene and normalized index shapes":
    let payload = samplePayload("fixture-element")
    payload["appState"]["currentItemStrokeColor"] = %"#e9ecef"
    payload["files"] = %*{"image": %*{"dataURL": "data:image/png;base64,AA=="}}
    let nodeVault = tempDir / "node-vault"
    let payloadPath = tempDir / "payload.json"
    writeFile(payloadPath, $payload)
    let scriptPath = "/tmp/sketchdex-node-store-fixture-" & $getCurrentProcessId() & ".mjs"
    writeFile(scriptPath, NodeStoreFixture)
    defer: removeFile(scriptPath)

    let run = runNode([scriptPath, repoRoot / "server" / "store.js", nodeVault, payloadPath])
    check run.exitCode == 0
    check run.stderr == ""

    let nimMeta = store.create("Node fixture")
    let nimId = nimMeta["id"].getStr
    discard store.save(nimId, payload, SaveOptions(touch: false))
    let nodeScene = parseJson(readFile(nodeVault / "scenes" /
      (parseJson(readFile(nodeVault / "index.json"))[0]["id"].getStr & ".excalidraw")))
    let nimSceneText = readFile(store.scenePath(nimId).get)
    check '\n' notin nimSceneText
    let nimScene = parseJson(nimSceneText)
    check nimScene == nodeScene
    check pretty(nimScene, indent = 2) == pretty(nodeScene, indent = 2)

    let nodeIndex = parseJson(readFile(nodeVault / "index.json"))
    let nimIndex = parseJson(readFile(store.indexFile))
    check normalizeMeta(nimIndex[0]) == normalizeMeta(nodeIndex[0])

  test "POSIX lifetime lock uses an external file and refuses a second owner":
    let missing = root / "not-created" / "nested"
    check canonicalizeVaultPath(missing) ==
      canonicalizeVaultPath(root) / "not-created" / "nested"
    let lockPath = lockFilePath(root)
    check not lockPath.startsWith(root / "")

    var first = acquireVaultLock(root)
    defer: release(first)
    check first.held
    check fileExists(lockPath)
    var busy = false
    try:
      var second = acquireVaultLock(root)
      release(second)
    except LockBusyError:
      busy = true
    check busy
    release(first)
    var third = acquireVaultLock(root)
    release(third)
    check fileExists(lockPath)

  test "watcher reports external revisions, ignores exact notes, debounces, and stops":
    let meta = store.create("Watched")
    let id = meta["id"].getStr
    var sink: EventSink
    let sinkPtr = addr sink
    proc recordChange(change: WatchChange) {.gcsafe.} =
      sinkPtr.record(change)
    var watcher = newWatcher(store, recordChange)
    watcher.start()
    defer: watcher.stop()
    sleep(400)
    check changes(sinkPtr).len == 0

    discard store.save(id, samplePayload("external-one"))
    let firstRev = store.rev(id).get
    check waitForEvents(sinkPtr, 1)
    let firstEvents = changes(sinkPtr)
    check firstEvents[0].kind == changeScene
    check firstEvents[0].sceneId == id
    check firstEvents[0].rev == firstRev

    discard store.save(id, samplePayload("noted"))
    watcher.noteWrite(id, store.rev(id).get)
    sleep(800)
    check changes(sinkPtr).len == 1

    discard store.save(id, samplePayload("external-two"))
    sleep(50)
    discard store.save(id, samplePayload("external-three"))
    let finalRev = store.rev(id).get
    check waitForEvents(sinkPtr, 2)
    let secondEvents = changes(sinkPtr)
    check secondEvents[1].rev == finalRev
    sleep(500)
    check changes(sinkPtr).len == 2

    discard store.delete(id)
    check waitForEvents(sinkPtr, 3)
    let removedEvents = changes(sinkPtr)
    check removedEvents[2].kind == changeRemoved
    check removedEvents[2].rev == ""
    sleep(500)
    check changes(sinkPtr).len == 3

    watcher.stop()
    discard store.save(id, samplePayload("after-stop"))
    sleep(500)
    check changes(sinkPtr).len == 3

  test "watcher reports scenes created after its initial baseline":
    var sink: EventSink
    let sinkPtr = addr sink
    proc recordChange(change: WatchChange) {.gcsafe.} =
      sinkPtr.record(change)
    var watcher = newWatcher(store, recordChange)
    watcher.start()
    defer: watcher.stop()
    sleep(400)
    check changes(sinkPtr).len == 0

    let meta = store.create("Created later")
    let id = meta["id"].getStr
    check waitForEvents(sinkPtr, 1)
    let events = changes(sinkPtr)
    check events[0].kind == changeScene
    check events[0].sceneId == id
    check events[0].rev == store.rev(id).get
