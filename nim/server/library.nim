import std/[algorithm, hashes, json, options, os, osproc, sets, strutils, tables,
  times, unicode]

import ../core/[jsvalue, random_ids]
import ./vault

type
  LibraryError* = object of CatchableError
    status*: int

  LibraryStore* = ref object
    path*: string
    maxBytes*: int

  CatalogRow = tuple[entry: JsonNode, score: int, name: string, updated: int64]

const
  LibraryFileName* = "library.excalidrawlib"
  CatalogBase = "https://libraries.excalidraw.com/libraries/"
  CatalogUrl* = "https://libraries.excalidraw.com/libraries.json"
  MaxItems = 1000
  CatalogTtl = 6.0 * 60.0 * 60.0

var cachedCatalog: JsonNode
var catalogFetchedAt = 0.0

proc fail(message: string; status: int) {.noreturn.} =
  let error = newException(LibraryError, message)
  error.status = status
  raise error

proc newLibraryStore*(vault: Vault): LibraryStore =
  LibraryStore(
    path: vault.root / LibraryFileName,
    maxBytes: 8 * 1024 * 1024
  )

proc rev*(store: LibraryStore): Option[string] =
  revisionForPath(store.path)

proc readItems*(store: LibraryStore): JsonNode =
  result = newJArray()
  try:
    let parsed = parseJson(readFile(store.path))
    let items = parsed.field("libraryItems")
    if items.isArr: result = items
  except IOError, OSError, JsonParsingError:
    discard

proc encodeWrapper(items: JsonNode): string =
  var wrapper = newJObject()
  wrapper["type"] = %"excalidrawlib"
  wrapper["version"] = %2
  wrapper["source"] = %"sketchdex"
  wrapper["libraryItems"] = items
  $wrapper

proc normalizeItem(item: JsonNode; created: int64): JsonNode =
  if not item.isObj: fail("library item must be an object", 400)
  let id = item.field("id")
  if id.kind != JString or id.getStr.strip().len == 0:
    fail("library item needs a non-empty string id", 400)
  let elements = item.field("elements")
  if not elements.isArr:
    fail("library item needs an elements array", 400)
  let name = item.field("name")
  if not name.isNil and name.kind != JString:
    fail("library item name must be a string", 400)
  result = copyNode(item)
  let status = result.field("status")
  if status.isNil or status.kind != JString:
    result["status"] = %"unpublished"
  let createdNode = result.field("created")
  if createdNode.isNil or not createdNode.isFiniteNumber:
    result["created"] = %created

proc normalizeArray(store: LibraryStore; items: JsonNode): JsonNode =
  if not items.isArr: fail("library items must be an array", 400)
  if items.len > MaxItems: fail("library holds more than 1000 items", 400)
  let created = nowMs()
  # a browser that restores its own library and merges the vault copy can send
  # the same id twice; one item per id is the invariant the panel relies on
  var order: seq[string]
  var byId = initTable[string, JsonNode]()
  for item in items:
    let next = normalizeItem(item, created)
    let id = next["id"].getStr
    if not byId.hasKey(id): order.add(id)
    byId[id] = next
  result = newJArray()
  for id in order: result.add(byId[id])
  if encodeWrapper(result).len > store.maxBytes:
    fail("library exceeds the size limit", 400)

proc replace*(store: LibraryStore; items: JsonNode; ifRev: Option[string]): JsonNode =
  if ifRev.isSome:
    let current = store.rev
    if current.isSome and current.get != ifRev.get:
      fail("library changed on disk since it was read", 409)
  result = normalizeArray(store, items)
  writeAtomic(store.path, encodeWrapper(result))

proc append*(store: LibraryStore; items: JsonNode): tuple[added, skipped: int, items: JsonNode] =
  if not items.isArr: fail("library items must be an array", 400)
  let stored = readItems(store)
  var seen = initHashSet[string]()
  for item in stored:
    let id = item.field("id").stringOr("")
    if id.len > 0: seen.incl(id)
  result.items = newJArray()
  for item in stored: result.items.add(copyNode(item))
  let created = nowMs()
  for item in items:
    let next = normalizeItem(item, created)
    let id = next["id"].getStr
    if seen.containsOrIncl(id): inc result.skipped
    else:
      result.items.add(next)
      inc result.added
  if result.added > 0:
    result.items = replace(store, result.items, none(string))

proc itemsFromLibraryFile*(raw: JsonNode; now: int64; source = ""): seq[JsonNode] =
  if not raw.isObj or raw.field("type").stringOr("") != "excalidrawlib":
    fail("not an excalidraw library file", 400)
  let v2 = raw.field("libraryItems")
  let v1 = raw.field("library")
  if v2.isArr:
    for item in v2:
      if not item.isObj: fail("library item must be an object", 400)
      let id = item.field("id")
      if id.kind != JString or id.getStr.len == 0:
        fail("library item needs an id", 400)
      let elements = item.field("elements")
      if not elements.isArr:
        fail("library item needs an elements array", 400)
      result.add(copyNode(item))
  elif v1.isArr:
    # a version 1 file has no ids. Derive one from the source and the entry's
    # position, so installing the same file twice adds nothing instead of
    # cloning every item under a fresh id.
    var index = 0
    for elements in v1:
      if not elements.isArr:
        fail("library entry must be an array of elements", 400)
      let digest = toHex(cast[uint64](hash(source & "#" & $index)), 16)
      result.add(%*{
        "id": "lib" & digest,
        "status": "unpublished",
        "created": now,
        "elements": elements
      })
      inc index
  else:
    fail("library file has no items", 400)

proc catalogEntry*(catalog: JsonNode; id: string): Option[JsonNode] =
  if catalog.isArr:
    for entry in catalog:
      if entry.isObj and entry.field("id").stringOr("") == id:
        return some(entry)
  none(JsonNode)

proc catalogName*(catalog: JsonNode; source: string): string =
  if catalog.isArr:
    for entry in catalog:
      if entry.isObj and entry.field("source").stringOr("") == source:
        return entry.field("name").stringOr("")
  ""

proc stringValues(node: JsonNode): seq[string] =
  if node.isArr:
    for value in node:
      if value.kind == JString: result.add(value.getStr)

proc authorNames(entry: JsonNode): seq[string] =
  let authors = entry.field("authors")
  if authors.isArr:
    for author in authors:
      if author.isObj:
        let name = author.field("name").stringOr("")
        if name.len > 0: result.add(name)

proc itemNames(entry: JsonNode): seq[string] =
  let node = entry.field("itemNames")
  if node.isArr: return stringValues(node)
  stringValues(entry.field("libraryItems"))

proc everyToken(haystack: string; tokens: seq[string]): bool =
  for token in tokens:
    if not haystack.contains(token): return false
  true

proc shortText(value: string; limit: int): string =
  var count = 0
  for ch in strutils.splitWhitespace(value).join(" ").runes:
    if count >= limit: break
    result.add(toUTF8(ch))
    inc count

proc itemSummary*(item: JsonNode): JsonNode =
  let elements = item.field("elements")
  var types = newJObject()
  var snippets = newJArray()
  var minX = Inf
  var minY = Inf
  var maxX = -Inf
  var maxY = -Inf
  if elements.isArr:
    for element in elements:
      let kind = element.field("type").stringOr("")
      if kind.len > 0:
        types[kind] = %(if types.hasKey(kind): types[kind].getInt + 1 else: 1)
      for key in ["text", "originalText"]:
        let value = element.field(key)
        if jsTruthy(value) and snippets.len < 3:
          snippets.add(%shortText(jsString(value), 60))
      let x = floatOr(element.field("x"), 0.0)
      let y = floatOr(element.field("y"), 0.0)
      minX = min(minX, x)
      minY = min(minY, y)
      maxX = max(maxX, x + floatOr(element.field("width"), 0.0))
      maxY = max(maxY, y + floatOr(element.field("height"), 0.0))
  result = %*{
    "id": item.field("id").stringOr(""),
    "elements": if elements.isArr: elements.len else: 0,
    "types": types,
    "bounds": %*{
      "x": numberNode(if minX == Inf: 0.0 else: minX),
      "y": numberNode(if minY == Inf: 0.0 else: minY),
      "width": numberNode(if maxX == -Inf: 0.0 else: maxX - minX),
      "height": numberNode(if maxY == -Inf: 0.0 else: maxY - minY)
    },
    "text": snippets
  }
  let name = item.field("name")
  if not name.isNil and name.kind == JString: result["name"] = name

proc findItem*(store: LibraryStore; key: string): Option[JsonNode] =
  let wanted = key.strip
  if wanted.len == 0: return none(JsonNode)
  let items = store.readItems()
  for item in items:
    if item.field("id").stringOr("") == wanted: return some(item)
  for item in items:
    if item.field("name").stringOr("") == wanted: return some(item)
  let lower = wanted.toLowerAscii
  for item in items:
    if item.field("name").stringOr("").toLowerAscii == lower: return some(item)
  var matches: seq[JsonNode]
  for item in items:
    if item.field("name").stringOr("").toLowerAscii.contains(lower):
      matches.add(item)
  if matches.len == 1: return some(matches[0])
  if matches.len > 1:
    var candidates: seq[string]
    for item in matches:
      candidates.add(item.field("id").stringOr("") & " " &
        item.field("name").stringOr(""))
    fail("library item \"" & wanted & "\" matches " & $matches.len &
      " items: " & candidates.join(", "), 400)
  none(JsonNode)

proc matchingItems*(store: LibraryStore; query, kind: string; limit: int): JsonNode =
  let items = store.readItems()
  let cap = max(0, min(limit, 100))
  var rows = newJArray()
  if cap == 0: return %*{"total": items.len, "items": rows}
  let tokens = strutils.splitWhitespace(query.strip.toLowerAscii)
  let wantedKind = kind.strip
  for item in items:
    let elements = item.field("elements")
    var haystack = item.field("id").stringOr("").toLowerAscii & "\n" &
      item.field("name").stringOr("").toLowerAscii
    var kindHit = wantedKind.len == 0
    if elements.isArr:
      for element in elements:
        let elementType = element.field("type").stringOr("")
        haystack.add("\n" & elementType.toLowerAscii)
        for key in ["text", "originalText"]:
          let value = element.field(key)
          if jsTruthy(value): haystack.add("\n" & jsString(value).toLowerAscii)
        if wantedKind.len > 0 and elementType == wantedKind: kindHit = true
    if not kindHit or not everyToken(haystack, tokens): continue
    rows.add(itemSummary(item))
    if rows.len >= cap: break
  %*{"total": items.len, "items": rows}

proc biggestIntOr(node: JsonNode; fallback: int64): int64 =
  if not node.isFiniteNumber: return fallback
  if node.kind == JInt: node.getBiggestInt else: int64(node.getFloat)

proc shapeEntry(entry: JsonNode): JsonNode =
  let source = entry.field("source").stringOr("")
  let preview = entry.field("preview").stringOr("")
  var authors = entry.field("authors")
  if not authors.isArr: authors = newJArray()
  result = %*{
    "id": entry.field("id").stringOr(""),
    "name": entry.field("name").stringOr(""),
    "description": entry.field("description").stringOr(""),
    "authors": authors,
    "source": source,
    "preview": CatalogBase & preview,
    "url": CatalogBase & source
  }
  let names = entry.field("itemNames")
  if names.isArr: result["items"] = %(stringValues(names).len)

proc browseCatalog*(catalog: JsonNode; query: string; limit = 20): JsonNode =
  let cap = max(0, min(limit, 100))
  let cleaned = query.strip
  var rows: seq[CatalogRow]
  if catalog.isArr:
    for entry in catalog:
      if not entry.isObj: continue
      let name = entry.field("name").stringOr("")
      let description = entry.field("description").stringOr("")
      let names = itemNames(entry)
      let lowerName = name.toLowerAscii
      let updated = biggestIntOr(entry.field("updated"), 0)
      if cleaned.len == 0:
        rows.add((entry, 0, name, updated))
        continue
      let needle = cleaned.toLowerAscii
      let tokens = strutils.splitWhitespace(needle)
      let haystack = lowerName & "\n" & description.toLowerAscii & "\n" &
        authorNames(entry).join("\n").toLowerAscii & "\n" &
        names.join("\n").toLowerAscii
      if not everyToken(haystack, tokens): continue
      var score = 10
      if lowerName == needle: score = 100
      elif lowerName.startsWith(needle): score = 80
      elif everyToken(lowerName, tokens): score = 60
      elif everyToken(description.toLowerAscii, tokens): score = 40
      elif everyToken(authorNames(entry).join("\n").toLowerAscii, tokens): score = 30
      elif everyToken(names.join("\n").toLowerAscii, tokens): score = 25
      rows.add((entry, score, name, updated))
  if cleaned.len == 0:
    rows.sort(proc(a, b: CatalogRow): int =
      if a.updated != b.updated: cmp(b.updated, a.updated)
      else: cmp(a.name.toLowerAscii, b.name.toLowerAscii))
  else:
    rows.sort(proc(a, b: CatalogRow): int =
      if a.score != b.score: cmp(b.score, a.score)
      else: cmp(a.name.toLowerAscii, b.name.toLowerAscii))
  result = newJArray()
  for row in rows:
    if result.len >= cap: break
    result.add(shapeEntry(row.entry))

proc fetchText*(url: string; timeoutSec = 20; maxBytes = 8 * 1024 * 1024): string =
  if not (url.startsWith("http://") or url.startsWith("https://")):
    fail("only http and https URLs are supported", 400)
  let command = "curl -fsSL --max-time " & $timeoutSec & " --max-filesize " &
    $maxBytes & " " & quoteShell(url)
  let outcome = execCmdEx(command, options = {poUsePath, poStdErrToStdOut})
  if outcome.exitCode != 0:
    let lines = outcome.output.splitLines()
    fail(if lines.len > 0: lines[0] else: "curl failed", 502)
  outcome.output

proc loadCatalog*(url = CatalogUrl): JsonNode =
  let timestamp = epochTime()
  if not cachedCatalog.isNil and timestamp - catalogFetchedAt < CatalogTtl:
    return cachedCatalog
  let parsed = parseJson(fetchText(url))
  cachedCatalog = parsed
  catalogFetchedAt = timestamp
  parsed

proc installFrom*(store: LibraryStore; catalog: JsonNode; refOrUrl: string): JsonNode =
  var url = refOrUrl.strip
  var name = ""
  let entry = catalogEntry(catalog, url)
  if entry.isSome:
    let found = entry.get
    url = CatalogBase & found.field("source").stringOr("")
    name = found.field("name").stringOr("")
  else:
    name = lastPathPart(url)
    const suffix = ".excalidrawlib"
    if name.endsWith(suffix): name = name[0 ..< name.len - suffix.len]
  let incoming = itemsFromLibraryFile(parseJson(fetchText(url)), nowMs(), url)
  var values = newJArray()
  for item in incoming: values.add(item)
  let appended = store.append(values)
  let currentRev = store.rev
  %*{
    "name": name,
    "url": url,
    "added": appended.added,
    "skipped": appended.skipped,
    "total": appended.items.len,
    "rev": (if currentRev.isSome: %currentRev.get else: newJNull())
  }
