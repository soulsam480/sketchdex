import std/[atomics, json, options, os, random, sets, strutils, times]

import ../core/[jsvalue, paper, random_ids]

type
  BadIdError* = object of CatchableError
    status*: int

  SceneConflict* = object of CatchableError
    status*: int
    code*: string
    currentRev*: string

  SaveOptions* = object
    touch*: bool
    ifRev*: Option[string]

  IndexPatch* = proc(meta: JsonNode): JsonNode

  Vault* = object
    root*: string
    scenesDir*: string
    thumbsDir*: string
    trashDir*: string
    historyDir*: string
    indexFile*: string

const
  ReservedIds = ["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4",
    "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]
  SceneExtension = ".excalidraw"

var tempSequence: Atomic[int]

randomize()

proc timeMs(value: Time): float =
  float(value.toUnix) * 1000.0 + float(value.nanosecond) / 1_000_000.0

proc revisionForPath*(path: string): Option[string] =
  try:
    let info = getFileInfo(path)
    some(jsNumberString(timeMs(info.lastWriteTime)) & "-" & $info.size)
  except OSError:
    none(string)

proc isSafeId(id: string): bool =
  if id.len == 0 or id.len > 64: return false
  for ch in id:
    if ch notin {'A' .. 'Z', 'a' .. 'z', '0' .. '9', '_', '-'}:
      return false
  id.toLowerAscii notin ReservedIds

proc badId() {.noreturn.} =
  let error = newException(BadIdError, "bad id")
  error.status = 400
  raise error

proc randomUuid(): string =
  const digits = "0123456789abcdef"
  var bytes: array[16, uint8]
  for value in bytes.mitems:
    value = uint8(rand(0 .. 255))
  bytes[6] = (bytes[6] and 0x0f'u8) or 0x40'u8
  bytes[8] = (bytes[8] and 0x3f'u8) or 0x80'u8
  result = newStringOfCap(36)
  for index, value in bytes:
    if index in {4, 6, 8, 10}: result.add('-')
    result.add(digits[int(value shr 4)])
    result.add(digits[int(value and 0x0f'u8)])

proc defaultRoot(): string =
  let configured = getEnv("SKETCHDEX_VAULT")
  if configured.len > 0: absolutePath(configured)
  else: getHomeDir() / "Documents" / "sketchdex"

proc isAtomicTempName(path: string): bool =
  let name = lastPathPart(path)
  if not name.endsWith(".tmp"): return false
  name.startsWith("index.json.") or name.startsWith("log.json.") or
    name.startsWith("claim.json.") or name.contains(".excalidraw.") or
    name.contains(".json.gz.")

proc cleanupTempFiles(root: string) =
  for path in walkDirRec(root):
    if isAtomicTempName(path):
      try: removeFile(path)
      except OSError: discard

proc newVault*(path: string = ""): Vault =
  result = Vault(
    root: absolutePath(if path.len > 0: path else: defaultRoot()),
    scenesDir: "",
    thumbsDir: "",
    trashDir: "",
    historyDir: "",
    indexFile: ""
  )
  result.scenesDir = result.root / "scenes"
  result.thumbsDir = result.root / "thumbs"
  result.trashDir = result.root / ".trash"
  result.historyDir = result.root / "history"
  result.indexFile = result.root / "index.json"
  createDir(result.scenesDir)
  createDir(result.thumbsDir)
  createDir(result.trashDir)
  createDir(result.historyDir)
  cleanupTempFiles(result.root)

proc writeAtomic*(path, contents: string) =
  let sequence = fetchAdd(tempSequence, 1)
  let temporary = path & "." & $getCurrentProcessId() & "." & $sequence & ".tmp"
  try:
    let file = open(temporary, fmWrite)
    try:
      file.write(contents)
      file.flushFile()
    finally:
      file.close()
    moveFile(temporary, path)
  except:
    try: removeFile(temporary)
    except OSError: discard
    raise

proc scenePath*(vault: Vault; id: string): Option[string] =
  if isSafeId(id): some(vault.scenesDir / (id & SceneExtension))
  else: none(string)

proc pathFor(vault: Vault; id: string): string =
  vault.scenesDir / (id & SceneExtension)

proc rev*(vault: Vault; id: string): Option[string] =
  let path = vault.scenePath(id)
  if path.isSome: revisionForPath(path.get)
  else: none(string)

proc readScenePayload(path: string): JsonNode =
  let parsed = parseJson(readFile(path))
  result = if parsed.isObj: parsed else: newJObject()
  if result.field("elements").isNil or result["elements"].kind == JNull:
    result["elements"] = newJArray()
  if result.field("appState").isNil or result["appState"].kind == JNull:
    result["appState"] = newJObject()
  if result.field("files").isNil or result["files"].kind == JNull:
    result["files"] = newJObject()

proc liveCount(payload: JsonNode): int =
  let elements = payload.field("elements")
  if not elements.isArr: return 0
  for element in elements:
    if not jsTruthy(element.field("isDeleted")): inc result

proc sceneName(index: JsonNode; id: string): JsonNode =
  if index.isArr:
    for meta in index:
      if meta.isObj:
        let metaId = meta.field("id")
        if metaId.kind == JString and metaId.getStr == id:
          return meta.field("name")
  nil

proc writeScene(vault: Vault; id: string; payload: JsonNode; name: JsonNode) =
  var scene = newJObject()
  scene["type"] = %"excalidraw"
  scene["version"] = %2
  scene["source"] = %"sketchdex"
  if not name.isNil: scene["name"] = copyNode(name)
  scene["elements"] =
    if payload.field("elements").isNil or payload["elements"].kind == JNull:
      newJArray()
    else: payload["elements"]
  scene["appState"] =
    if payload.field("appState").isNil or payload["appState"].kind == JNull:
      newJObject()
    else: payload["appState"]
  scene["files"] =
    if payload.field("files").isNil or payload["files"].kind == JNull:
      newJObject()
    else: payload["files"]

  if payload.isObj:
    for key, value in payload:
      if key notin ["type", "version", "source", "name", "elements", "appState",
          "files", "rev"]:
        scene[key] = value
  # Scene files are machine-read. Compact JSON deliberately changes only
  # whitespace from the previous pretty format; parsed JSON is identical.
  writeAtomic(pathFor(vault, id), $scene)

proc stableSortByUpdated(metas: var seq[JsonNode]) =
  for index in 1 ..< metas.len:
    let current = metas[index]
    var target = index
    let updated = current["updatedAt"].getInt
    while target > 0 and metas[target - 1]["updatedAt"].getInt < updated:
      metas[target] = metas[target - 1]
      dec target
    metas[target] = current

proc rebuildIndex(vault: Vault): JsonNode =
  var metas: seq[JsonNode]
  for path in walkFiles(vault.scenesDir / ("*" & SceneExtension)):
    let fileName = lastPathPart(path)
    let id = fileName[0 ..< fileName.len - SceneExtension.len]
    if not isSafeId(id): continue
    let info = try: getFileInfo(path) except OSError: continue
    let payload = try: readScenePayload(path) except: continue
    let name = payload.field("name")
    let fallback = "Recovered " & id[0 ..< min(8, id.len)]
    let meta = %*{
      "id": id,
      "name": if name.kind == JString and name.getStr.len > 0: name.getStr
        else: fallback,
      "createdAt": jsRoundInt(timeMs(info.creationTime)),
      "updatedAt": jsRoundInt(timeMs(info.lastWriteTime)),
      "elementCount": liveCount(payload)
    }
    metas.add(meta)
  stableSortByUpdated(metas)
  result = newJArray()
  for meta in metas: result.add(meta)
  writeAtomic(vault.indexFile, pretty(result, indent = 2))

proc readIndex(vault: Vault): JsonNode =
  try:
    let parsed = parseJson(readFile(vault.indexFile))
    if parsed.isArr: return parsed
  except IOError, OSError, JsonParsingError:
    discard
  rebuildIndex(vault)

proc writeIndex(vault: Vault; values: JsonNode): JsonNode =
  var seen = initHashSet[string]()
  result = newJArray()
  for meta in values:
    if not meta.isObj: continue
    let id = meta.field("id")
    if not jsTruthy(id): continue
    let key = jsString(id)
    if seen.containsOrIncl(key): continue
    result.add(meta)
  writeAtomic(vault.indexFile, pretty(result, indent = 2))

proc patchIndex*(vault: Vault; id: string; patch: IndexPatch): JsonNode

proc list*(vault: Vault): JsonNode =
  readIndex(vault)

proc create*(vault: Vault; name: string = "Untitled"; paper = DEFAULT_PAPER): JsonNode =
  let now = nowMs()
  let background = if paper.len > 0: paper else: DEFAULT_PAPER
  result = %*{
    "id": randomUuid(),
    "name": name,
    "createdAt": now,
    "updatedAt": now,
    "elementCount": 0
  }
  let id = result["id"].getStr
  writeScene(vault, id, %*{
    "elements": newJArray(),
    "appState": freshAppState(background),
    "files": newJObject()
  }, %name)
  let existing = readIndex(vault)
  var next = newJArray()
  next.add(result)
  for meta in existing: next.add(meta)
  discard writeIndex(vault, next)

proc read*(vault: Vault; id: string): JsonNode =
  if not isSafeId(id): badId()
  let payload = readScenePayload(pathFor(vault, id))
  let revision = rev(vault, id)
  if revision.isNone: raise newException(IOError, "scene disappeared while reading")
  result = newJObject()
  result["elements"] = payload["elements"]
  result["appState"] = payload["appState"]
  result["files"] = payload["files"]
  for key, value in payload:
    if key notin ["elements", "appState", "files", "rev"]:
      result[key] = value
  result["rev"] = %revision.get

proc save*(vault: Vault; id: string; payload: JsonNode;
    options: SaveOptions = SaveOptions(touch: true)): JsonNode =
  if not isSafeId(id): badId()
  if options.ifRev.isSome:
    let current = rev(vault, id)
    if current.isSome and current.get != options.ifRev.get:
      let error = newException(SceneConflict,
        "scene changed on disk since it was loaded")
      error.status = 409
      error.code = "conflict"
      error.currentRev = current.get
      raise error

  let index = readIndex(vault)
  writeScene(vault, id, payload, sceneName(index, id))
  if not options.touch: return index
  patchIndex(vault, id, proc(meta: JsonNode): JsonNode =
    var next = copyNode(meta)
    next["updatedAt"] = %nowMs()
    next["elementCount"] = %liveCount(payload)
    next
  )

proc patchIndex*(vault: Vault; id: string; patch: IndexPatch): JsonNode =
  let index = readIndex(vault)
  var next = newJArray()
  for meta in index:
    let metaId = meta.field("id")
    if metaId.kind == JString and metaId.getStr == id:
      next.add(patch(meta))
    else:
      next.add(meta)
  writeIndex(vault, next)

proc thumbPath(vault: Vault; id: string): string =
  vault.thumbsDir / (id & ".svg")

proc patch*(vault: Vault; id: string; changes: JsonNode): JsonNode =
  if not isSafeId(id): badId()
  let rename = changes.hasKey("name")
  let name =
    if rename:
      let value = changes.field("name")
      if value.isNil or value.kind != JString:
        raise newException(ValueError, "name must be a string")
      let trimmed = value.getStr.strip
      if trimmed.len > 0: trimmed else: "Untitled"
    else:
      ""
  let payload = if rename: readScenePayload(pathFor(vault, id)) else: nil
  result = patchIndex(vault, id, proc(meta: JsonNode): JsonNode =
    var next = copyNode(meta)
    if rename: next["name"] = %name
    if changes.hasKey("starred"):
      let starred = changes.field("starred")
      if starred.kind != JBool:
        raise newException(ValueError, "starred must be a boolean")
      next["starred"] = %starred.getBool
    next
  )
  if rename:
    writeScene(vault, id, payload, %name)

proc readThumb*(vault: Vault; id: string): string =
  if not isSafeId(id): badId()
  try:
    readFile(thumbPath(vault, id))
  except IOError, OSError:
    ""

proc writeThumb*(vault: Vault; id, svg: string) =
  if not isSafeId(id): badId()
  if svg.len == 0:
    try: removeFile(thumbPath(vault, id))
    except OSError: discard
    return
  writeAtomic(thumbPath(vault, id), svg)
  discard patchIndex(vault, id, proc(meta: JsonNode): JsonNode =
    var next = copyNode(meta)
    next["thumbAt"] = %nowMs()
    next
  )

proc duplicate*(vault: Vault; id: string): JsonNode =
  if not isSafeId(id): badId()
  let index = readIndex(vault)
  var source: JsonNode
  var sourceIndex = -1
  for position in 0 ..< index.len:
    let meta = index[position]
    if meta.field("id").stringOr("") == id:
      source = meta
      sourceIndex = position
      break
  if source.isNil: return nil
  let payload = readScenePayload(pathFor(vault, id))
  let now = nowMs()
  result = %*{
    "id": randomUuid(),
    "name": source.field("name").stringOr("Untitled") & " copy",
    "createdAt": now,
    "updatedAt": now,
    "elementCount": liveCount(payload),
    "starred": false
  }
  writeScene(vault, result["id"].getStr, payload, result["name"])
  let sourceThumb = thumbPath(vault, id)
  if fileExists(sourceThumb):
    copyFile(sourceThumb, thumbPath(vault, result["id"].getStr))
  var next = newJArray()
  for position in 0 ..< index.len:
    let meta = index[position]
    next.add(meta)
    if position == sourceIndex: next.add(result)
  discard writeIndex(vault, next)

proc timestampField(meta: JsonNode; key: string; fallback: int64): JsonNode =
  let value = meta.field(key)
  if value.isFiniteNumber: %value.getBiggestInt else: %fallback

proc importScene*(vault: Vault; imported: JsonNode): JsonNode =
  let meta = imported.field("meta")
  let payloadNode = imported.field("payload")
  let payload = if payloadNode.isNil or payloadNode.kind == JNull: newJObject()
    else: payloadNode
  let requestedId = meta.field("id").stringOr("")
  let id = if isSafeId(requestedId): requestedId else: randomUuid()
  let now = nowMs()
  let name = meta.field("name").stringOr("Untitled")
  result = %*{
    "id": id,
    "name": name,
    "createdAt": timestampField(meta, "createdAt", now),
    "updatedAt": timestampField(meta, "updatedAt", now),
    "elementCount": liveCount(payload)
  }
  let starred = meta.field("starred")
  if not starred.isNil and starred.kind == JBool: result["starred"] = %starred.getBool
  writeScene(vault, id, payload, %name)
  var next = newJArray()
  next.add(result)
  for existing in readIndex(vault):
    if existing.field("id").stringOr("") != id: next.add(existing)
  discard writeIndex(vault, next)
  let thumb = imported.field("thumb")
  if not thumb.isNil and thumb.kind == JString and thumb.getStr.len > 0:
    vault.writeThumb(id, thumb.getStr)

proc delete*(vault: Vault; id: string): JsonNode =
  if not isSafeId(id): badId()
  let source = pathFor(vault, id)
  if fileExists(source):
    let stamp = utc(getTime()).format("yyyy-MM-dd'T'HH:mm:ss.fff'Z'").
      replace(':', '-').replace('.', '-')
    moveFile(source, vault.trashDir / (stamp & "-" & id & SceneExtension))
  try: removeFile(thumbPath(vault, id))
  except OSError: discard
  let index = readIndex(vault)
  var next = newJArray()
  for meta in index:
    let metaId = meta.field("id")
    if metaId.kind != JString or metaId.getStr != id: next.add(meta)
  writeIndex(vault, next)
