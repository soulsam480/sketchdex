import std/[atomics, json, math, options, os, random, times]

import ../core/[jsvalue, random_ids]
import ./vault

type
  History* = object
    root*: string

  HistoryListing* = object
    entries*: JsonNode
    bytes*: int

const MaxPerScene = 20

type GzFile = pointer

when defined(windows):
  proc gzopen(path: cstring; mode: cstring): GzFile {.
    importc: "gzopen", header: "<zlib.h>".}
  proc gzwrite(file: GzFile; buffer: pointer; length: cuint): cint {.
    importc: "gzwrite", header: "<zlib.h>".}
  proc gzread(file: GzFile; buffer: pointer; length: cuint): cint {.
    importc: "gzread", header: "<zlib.h>".}
  proc gzclose(file: GzFile): cint {.
    importc: "gzclose", header: "<zlib.h>".}
  proc gzerror(file: GzFile; errorNumber: ptr cint): cstring {.
    importc: "gzerror", header: "<zlib.h>".}
  {.passL: "zlib1.lib".}
else:
  proc gzopen(path: cstring; mode: cstring): GzFile {.
    importc: "gzopen", header: "<zlib.h>".}
  proc gzwrite(file: GzFile; buffer: pointer; length: cuint): cint {.
    importc: "gzwrite", header: "<zlib.h>".}
  proc gzread(file: GzFile; buffer: pointer; length: cuint): cint {.
    importc: "gzread", header: "<zlib.h>".}
  proc gzclose(file: GzFile): cint {.
    importc: "gzclose", header: "<zlib.h>".}
  proc gzerror(file: GzFile; errorNumber: ptr cint): cstring {.
    importc: "gzerror", header: "<zlib.h>".}
  {.passL: "-lz".}

var tempSequence: Atomic[int]

randomize()

proc timeMs(value: Time): float =
  float(value.toUnix) * 1000.0 + float(value.nanosecond) / 1_000_000.0

proc jsonNumber(value: float): JsonNode =
  if value == floor(value) and value >= -9_223_372_036_854_775_808.0 and
      value < 9_223_372_036_854_775_808.0:
    %int64(value)
  else:
    %value

proc isSafeId(id: string): bool =
  if id.len == 0 or id.len > 64: return false
  for ch in id:
    if ch notin {'A' .. 'Z', 'a' .. 'z', '0' .. '9', '_', '-'}:
      return false
  true

proc badId() {.noreturn.} =
  raise newException(ValueError, "bad id")

proc newHistory*(vaultRoot: string): History =
  History(root: vaultRoot / "history")

proc newHistory*(vault: Vault): History =
  newHistory(vault.root)

proc dirFor(history: History; sceneId: string): string =
  history.root / sceneId

proc logFor(history: History; sceneId: string): string =
  dirFor(history, sceneId) / "log.json"

proc snapFor(history: History; sceneId, snapId: string): string =
  dirFor(history, sceneId) / (snapId & ".json.gz")

proc claimFor(history: History; sceneId: string): string =
  dirFor(history, sceneId) / "claim.json"

proc readLog(history: History; sceneId: string): JsonNode =
  try:
    let parsed = parseJson(readFile(logFor(history, sceneId)))
    if parsed.isArr: return parsed
  except IOError, OSError, JsonParsingError:
    discard
  newJArray()

proc writeLog(history: History; sceneId: string; entries: JsonNode): JsonNode =
  createDir(dirFor(history, sceneId))
  writeAtomic(logFor(history, sceneId), pretty(entries, indent = 2))
  entries

proc randomHex(byteCount: int): string =
  const digits = "0123456789abcdef"
  result = newStringOfCap(byteCount * 2)
  for _ in 0 ..< byteCount:
    let value = rand(0 .. 255)
    result.add(digits[value shr 4])
    result.add(digits[value and 0x0f])

proc zlibMessage(file: GzFile): string =
  var code: cint
  $gzerror(file, addr code)

proc gzipWrite(path, contents: string) =
  # Snapshots favor speed over space. Level 1 keeps the snapshot shape identical
  # while trading larger gzip files for faster writes.
  let file = gzopen(path.cstring, "wb1")
  if file.isNil: raise newException(IOError, "cannot open gzip output: " & path)
  var closed = false
  try:
    var offset = 0
    while offset < contents.len:
      let count = min(contents.len - offset, int(high(uint32)))
      let written = gzwrite(file, unsafeAddr contents[offset], cuint(count))
      if written != cint(count):
        raise newException(IOError, "gzip write failed: " & zlibMessage(file))
      offset += count
    let status = gzclose(file)
    closed = true
    if status != 0:
      raise newException(IOError, "gzip close failed: " & path)
  except:
    if not closed: discard gzclose(file)
    raise

proc appendBytes(output: var string; buffer: array[64 * 1024, char]; count: int) =
  let start = output.len
  output.setLen(start + count)
  if count > 0: copyMem(addr output[start], unsafeAddr buffer[0], count)

proc gzipRead(path: string): string =
  let file = gzopen(path.cstring, "rb")
  if file.isNil: raise newException(IOError, "cannot open gzip input: " & path)
  var closed = false
  try:
    var buffer: array[64 * 1024, char]
    while true:
      let count = gzread(file, addr buffer[0], cuint(buffer.len))
      if count < 0:
        raise newException(IOError, "gzip read failed: " & zlibMessage(file))
      if count == 0: break
      appendBytes(result, buffer, int(count))
    let status = gzclose(file)
    closed = true
    if status != 0:
      raise newException(IOError, "gzip close failed: " & path)
  except:
    if not closed: discard gzclose(file)
    raise

proc writeGzipAtomic(path, contents: string) =
  let sequence = fetchAdd(tempSequence, 1)
  let temporary = path & "." & $getCurrentProcessId() & "." & $sequence & ".tmp"
  try:
    gzipWrite(temporary, contents)
    moveFile(temporary, path)
  except:
    try: removeFile(temporary)
    except OSError: discard
    raise

proc dropSnapshot(history: History; sceneId, snapId: string) =
  try: removeFile(snapFor(history, sceneId, snapId))
  except OSError: discard

proc claim*(history: History; sceneId, file: string) =
  if not isSafeId(sceneId): return
  let info = try: getFileInfo(file) except OSError: return
  createDir(dirFor(history, sceneId))
  writeAtomic(claimFor(history, sceneId), $(%*{
    "mtimeMs": jsonNumber(timeMs(info.lastWriteTime)),
    "size": info.size,
    "at": nowMs()
  }))

proc isClaimed*(history: History; sceneId, file: string): bool =
  if not isSafeId(sceneId): return false
  let claim =
    try: parseJson(readFile(claimFor(history, sceneId)))
    except IOError, OSError, JsonParsingError: return false
  let info = try: getFileInfo(file) except OSError: return false
  let claimedMs = claim.field("mtimeMs")
  let claimedSize = claim.field("size")
  if not claimedMs.isFiniteNumber or not claimedSize.isFiniteNumber: return false
  claimedMs.getFloat == timeMs(info.lastWriteTime) and
    claimedSize.getBiggestInt == info.size

proc list*(history: History; sceneId: string): HistoryListing =
  result.entries = newJArray()
  if not isSafeId(sceneId): return
  result.entries = readLog(history, sceneId)
  for entry in result.entries:
    let bytes = entry.field("bytes")
    if bytes.isFiniteNumber: result.bytes += int(bytes.getBiggestInt)

proc liveCount(payload: JsonNode): int =
  let elements = payload.field("elements")
  if not elements.isArr: return 0
  for element in elements:
    if not jsTruthy(element.field("isDeleted")): inc result

proc take*(history: History; sceneId: string; payload: JsonNode;
    label: string = "agent edit"; origin: string = "agent"): JsonNode =
  if not isSafeId(sceneId): raise newException(ValueError, "bad scene id")
  createDir(dirFor(history, sceneId))
  let elements =
    if payload.field("elements").isNil or payload["elements"].kind == JNull:
      newJArray()
    else: payload["elements"]
  let appState =
    if payload.field("appState").isNil or payload["appState"].kind == JNull:
      newJObject()
    else: payload["appState"]
  let id = randomHex(8)
  let body = $(%*{"elements": elements, "appState": appState})
  let snapshotPath = snapFor(history, sceneId, id)
  writeGzipAtomic(snapshotPath, body)

  result = %*{
    "id": id,
    "at": nowMs(),
    "label": label,
    "origin": origin,
    "elementCount": liveCount(payload),
    "bytes": getFileInfo(snapshotPath).size
  }
  var entries = newJArray()
  entries.add(result)
  for entry in readLog(history, sceneId): entries.add(entry)
  var kept = newJArray()
  for index in 0 ..< entries.len:
    let entry = entries[index]
    if index >= MaxPerScene:
      let droppedId = entry.field("id")
      if droppedId.kind == JString:
        dropSnapshot(history, sceneId, droppedId.getStr)
    else:
      kept.add(entry)
  discard writeLog(history, sceneId, kept)

proc read*(history: History; sceneId, snapId: string): JsonNode =
  if not isSafeId(sceneId) or not isSafeId(snapId): badId()
  parseJson(gzipRead(snapFor(history, sceneId, snapId)))

proc `discard`*(history: History; sceneId, snapId: string): JsonNode =
  if not isSafeId(sceneId) or not isSafeId(snapId): badId()
  dropSnapshot(history, sceneId, snapId)
  let entries = readLog(history, sceneId)
  var next = newJArray()
  for entry in entries:
    let id = entry.field("id")
    if id.kind != JString or id.getStr != snapId: next.add(entry)
  writeLog(history, sceneId, next)

proc clear*(history: History; sceneId: string): JsonNode =
  if not isSafeId(sceneId): raise newException(ValueError, "bad scene id")
  try: removeDir(dirFor(history, sceneId))
  except OSError: discard
  newJArray()

