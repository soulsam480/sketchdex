import std/[algorithm, json, math, options, random, re, sets, strutils, tables,
  times, unicode]

import ../core/[elements, jsvalue, paper, random_ids]
import ./[comments, history, inspect, library, svg, vault]

type
  AgentError* = object of CatchableError
    status*: int

  LastKnownState = object
    elements, appState: JsonNode

  CachedScene = object
    rev: string
    payload: JsonNode

  Mutation* = object
    elements*, appState*, result*: JsonNode

  ApplyMutation = proc(payload, meta: JsonNode): Mutation

  AgentApi* = ref object
    vault*: Vault
    history*: History
    library*: LibraryStore
    lastKnown: OrderedTable[string, LastKnownState]
    sceneCache: OrderedTable[string, CachedScene]

const
  LastKnownMax = 5
  SceneCacheMax = 5

var groupRng = initRand(int64(nonce()) shl 32 or int64(nonce()))

proc newAgentApi*(vaultPath = ""): AgentApi =
  let vault = newVault(vaultPath)
  AgentApi(
    vault: vault,
    history: newHistory(vault),
    library: newLibraryStore(vault),
    lastKnown: initOrderedTable[string, LastKnownState](),
    sceneCache: initOrderedTable[string, CachedScene]()
  )

proc isNullish(value: JsonNode): bool =
  value.isNil or value.kind == JNull

proc toNumber(value: JsonNode): float =
  if value.isNil: return NaN
  case value.kind
  of JNull: 0.0
  of JBool: (if value.getBool: 1.0 else: 0.0)
  of JInt: float(value.getInt)
  of JFloat: value.getFloat
  of JString:
    let text = value.getStr.strip()
    case text
    of "Infinity", "+Infinity": Inf
    of "-Infinity": NegInf
    of "NaN": NaN
    else:
      try: parseFloat(text)
      except ValueError: NaN
  of JArray:
    let text = jsString(value).strip()
    try: parseFloat(text)
    except ValueError: NaN
  of JObject: NaN

proc primitive(value: JsonNode): JsonNode =
  if value.isNil: return nil
  if value.kind in {JArray, JObject}: %jsString(value) else: value

proc addJs(left, right: JsonNode): JsonNode =
  let a = primitive(left)
  let b = primitive(right)
  if not a.isNil and not b.isNil and (a.kind == JString or b.kind == JString):
    %(jsString(a) & jsString(b))
  else:
    numberNode(toNumber(a) + toNumber(b))

proc roundedNumber(value: float): JsonNode =
  numberNode(jsRound(value))

proc fixed3(value: float): JsonNode =
  if value.classify in {fcNan, fcInf, fcNegInf}: return newJNull()
  let scaled = jsRound(abs(value) * 1000.0) / 1000.0
  numberNode(if value < 0.0: -scaled else: scaled)

proc utf16Slice(value: string; length: int): string =
  var units: seq[uint16]
  for ch in value.runes:
    let code = uint32(ch)
    if code <= 0xffff:
      units.add(uint16(code))
    else:
      let offset = code - 0x10000
      units.add(uint16(0xd800 + (offset shr 10)))
      units.add(uint16(0xdc00 + (offset and 0x3ff)))
  let stop = min(length, units.len)
  var index = 0
  while index < stop:
    let code = units[index]
    if code in uint16(0xd800) .. uint16(0xdbff) and index + 1 < stop and
        units[index + 1] in uint16(0xdc00) .. uint16(0xdfff):
      let offset = (uint32(code) - 0xd800) * 0x400 +
        uint32(units[index + 1] - 0xdc00)
      result.add(toUTF8(Rune(0x10000 + offset)))
      index += 2
    else:
      result.add(toUTF8(Rune(code)))
      index += 1

proc lowerJs(value: string): string =
  for ch in value.runes: result.add(toUTF8(unicode.toLower(ch)))

proc withUpdated(elements, updated: JsonNode): JsonNode =
  if not updated.isArr or updated.len == 0: return elements
  var replacements = initTable[string, JsonNode]()
  for element in updated:
    replacements[jsString(element.field("id"))] = element
  result = newJArray()
  for element in elements:
    let key = jsString(element.field("id"))
    result.add(replacements.getOrDefault(key, element))

proc newSvgGroup(): string =
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  result = "svg-"
  for _ in 0 ..< 8: result.add(alphabet[rand(groupRng, 0 .. 35)])

proc withGroup(elements: JsonNode; group: string): JsonNode =
  result = newJArray()
  for element in elements:
    var next = copyNode(element)
    var groups = newJArray()
    let existing = element.field("groupIds")
    if existing.isArr:
      for value in existing: groups.add(copyNode(value))
    groups.add(%group)
    next["groupIds"] = groups
    result.add(next)

proc bounds(elements: JsonNode): JsonNode =
  if not elements.isArr or elements.len == 0: return newJNull()
  var minX = Inf
  var minY = Inf
  var maxX = -Inf
  var maxY = -Inf
  for element in elements:
    let x = toNumber(element.field("x"))
    let y = toNumber(element.field("y"))
    let width = element.field("width")
    let height = element.field("height")
    minX = min(minX, x)
    minY = min(minY, y)
    maxX = max(maxX, x + (if isNullish(width): 0.0 else: toNumber(width)))
    maxY = max(maxY, y + (if isNullish(height): 0.0 else: toNumber(height)))
  %*{
    "x": roundedNumber(minX),
    "y": roundedNumber(minY),
    "width": roundedNumber(maxX - minX),
    "height": roundedNumber(maxY - minY)
  }

proc describe(element: JsonNode): JsonNode =
  result = newJObject()
  for key in ["id", "type"]:
    let value = element.field(key)
    if not value.isNil: result[key] = copyNode(value)
  result["x"] = roundedNumber(toNumber(element.field("x")))
  result["y"] = roundedNumber(toNumber(element.field("y")))
  result["width"] = roundedNumber(toNumber(element.field("width")))
  result["height"] = roundedNumber(toNumber(element.field("height")))
  if jsTruthy(element.field("text")): result["text"] = copyNode(element["text"])
  if jsTruthy(element.field("containerId")):
    result["containerId"] = copyNode(element["containerId"])
  let stroke = element.field("strokeColor")
  if jsTruthy(stroke) and stroke.stringOr("") != "#1e1e1e":
    result["strokeColor"] = copyNode(stroke)
  let background = element.field("backgroundColor")
  if jsTruthy(background) and background.stringOr("") != "transparent":
    result["backgroundColor"] = copyNode(background)
  if jsTruthy(element.field("fontSize")):
    result["fontSize"] = roundedNumber(toNumber(element["fontSize"]))
  if jsTruthy(element.field("angle")):
    result["angle"] = fixed3(toNumber(element["angle"]))
  if element.hasField("opacity") and
      (not element["opacity"].isNumber or toNumber(element["opacity"]) != 100.0):
    result["opacity"] = copyNode(element["opacity"])
  let strokeWidth = element.field("strokeWidth")
  if jsTruthy(strokeWidth) and
      (not strokeWidth.isNumber or toNumber(strokeWidth) != 2.0):
    result["strokeWidth"] = copyNode(strokeWidth)
  let groups = element.field("groupIds")
  if groups.isArr and groups.len > 0: result["groupIds"] = copyNode(groups)
  let startBinding = element.field("startBinding")
  let endBinding = element.field("endBinding")
  if jsTruthy(startBinding) or jsTruthy(endBinding):
    let startId = startBinding.field("elementId")
    let endId = endBinding.field("elementId")
    result["binding"] = %*{
      "start": if isNullish(startId): newJNull() else: copyNode(startId),
      "end": if isNullish(endId): newJNull() else: copyNode(endId)
    }
  if element.field("type").stringOr("") in ["freedraw", "line", "arrow"]:
    let points = element.field("points")
    result["pointCount"] = %(if points.isArr: points.len else: 0)
  let comments = countsOf(element)
  if comments.open + comments.resolved > 0:
    result["comments"] = %*{"open": comments.open, "resolved": comments.resolved}

proc brief(element: JsonNode): JsonNode =
  result = %*{"id": element.field("id"), "type": element.field("type")}
  if jsTruthy(element.field("text")):
    let text = jsString(element["text"]).replace(re"\s+", " ")
    result["text"] = %utf16Slice(text, 48)
  if jsTruthy(element.field("containerId")):
    result["containerId"] = copyNode(element["containerId"])

proc mergeObjects(base, overlay: JsonNode): JsonNode =
  result = if base.isObj: copyNode(base) else: newJObject()
  if overlay.isObj:
    for key, value in overlay: result[key] = copyNode(value)

proc requireLabel(label: string; snapshot = false) =
  if label.strip().len == 0:
    let message =
      if snapshot: "label is required: say why this snapshot is being taken"
      else: "label is required: a short description of this change, e.g. 'add the dog illustration'"
    let error = newException(AgentError, message)
    error.status = 400
    raise error

proc oldestKey[T](cache: OrderedTable[string, T]): string =
  for key in cache.keys: return key
  ""

proc cacheScene(api: AgentApi; sceneId, revision: string; payload: JsonNode) =
  api.sceneCache.del(sceneId)
  api.sceneCache[sceneId] = CachedScene(rev: revision, payload: payload)
  while api.sceneCache.len > SceneCacheMax:
    api.sceneCache.del(oldestKey(api.sceneCache))

proc invalidateScene*(api: AgentApi; sceneId: string) =
  api.sceneCache.del(sceneId)

proc readPayload(api: AgentApi; sceneId: string): JsonNode =
  let revision = api.vault.rev(sceneId)
  if revision.isSome and api.sceneCache.hasKey(sceneId):
    let cached = api.sceneCache[sceneId]
    if cached.rev == revision.get:
      api.sceneCache.del(sceneId)
      api.sceneCache[sceneId] = cached
      return cached.payload
  let payload = api.vault.read(sceneId)
  let cachedRevision =
    if revision.isSome: revision.get else: payload.field("rev").stringOr("")
  cacheScene(api, sceneId, cachedRevision, payload)
  payload

proc remember(api: AgentApi; id: string; payload: JsonNode) =
  api.lastKnown.del(id)
  api.lastKnown[id] = LastKnownState(
    elements: payload.field("elements"),
    appState: payload.field("appState")
  )
  while api.lastKnown.len > LastKnownMax:
    api.lastKnown.del(oldestKey(api.lastKnown))

proc observe*(api: AgentApi; id: string; payload: JsonNode) =
  remember(api, id, payload)

proc live(elements: JsonNode): JsonNode =
  result = newJArray()
  if elements.isArr:
    for element in elements:
      if not jsTruthy(element.field("isDeleted")): result.add(element)

proc resolve(api: AgentApi; idOrName: string): JsonNode =
  let scenes = api.vault.list
  for meta in scenes:
    if meta.field("id").stringOr("") == idOrName: return meta

  let needle = lowerJs(idOrName)
  var exact: seq[JsonNode]
  var partial: seq[JsonNode]
  for meta in scenes:
    let name = lowerJs(meta.field("name").stringOr(""))
    if name == needle: exact.add(meta)
    elif name.contains(needle): partial.add(meta)

  let candidates = if exact.len > 0: exact else: partial
  if candidates.len == 1: return candidates[0]
  if candidates.len == 0:
    raise newException(ValueError, "no scene matching \"" & idOrName & "\"")
  var lines: seq[string]
  for meta in candidates:
    lines.add("  " & meta["id"].getStr & "  " & meta["name"].getStr)
  raise newException(ValueError,
    "\"" & idOrName & "\" matches " & $candidates.len & " scenes. Use an id:\n" &
    lines.join("\n"))

proc isoAt(milliseconds: int64): string =
  utc(fromUnixFloat(float(milliseconds) / 1000.0)).format("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")

proc listScenes*(api: AgentApi): JsonNode =
  result = newJArray()
  for meta in api.vault.list:
    let starred = meta.field("starred")
    result.add(%*{
      "id": meta["id"],
      "name": meta["name"],
      "elements": meta["elementCount"],
      "updatedAt": %isoAt(meta["updatedAt"].getBiggestInt),
      "starred": if isNullish(starred): %false else: copyNode(starred)
    })

proc scenePath*(api: AgentApi; idOrName: string): JsonNode =
  let meta = resolve(api, idOrName)
  let path = api.vault.scenePath(meta["id"].getStr)
  %*{
    "id": meta["id"],
    "name": meta["name"],
    "path": path.get,
    "vault": %api.vault.root
  }

proc deleteScene*(api: AgentApi; idOrName: string): JsonNode =
  let meta = resolve(api, idOrName)
  let sceneId = meta["id"].getStr
  invalidateScene(api, sceneId)
  api.vault.delete(sceneId)

proc readScene*(api: AgentApi; idOrName: string; options: JsonNode = nil): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  remember(api, meta["id"].getStr, payload)
  let includeFiles = jsTruthy(options.field("includeFiles"))
  var fileValue: JsonNode
  if includeFiles:
    fileValue = if isNullish(payload.field("files")): newJObject()
      else: copyNode(payload["files"])
  else:
    fileValue = newJArray()
    let files = payload.field("files")
    if files.isObj:
      for id in files.keys: fileValue.add(%id)
  var output = %*{
    "id": meta["id"],
    "name": meta["name"],
    "path": %(api.vault.scenePath(meta["id"].getStr).get),
    "vault": %api.vault.root,
    "elements": payload["elements"],
    "appState": payload["appState"]
  }
  output[if includeFiles: "files" else: "fileIds"] = fileValue
  output

proc build(elements, existing: JsonNode; ink: string): JsonNode =
  let scene = if existing.isNil: newJArray() else: existing
  buildElements(elements, scene, ink, nowMs())

proc createScene*(api: AgentApi; name = "Untitled"; elements: JsonNode = nil): JsonNode =
  let meta = api.vault.create(name)
  if not elements.isArr or elements.len == 0:
    return %*{
      "sceneId": meta["id"], "name": meta["name"], "added": 0,
      "elements": newJArray(), "warnings": newJArray()
    }
  let appState = freshAppState()
  let built = build(elements, newJArray(), inkFor(paperOf(appState)))
  discard api.vault.save(meta["id"].getStr, %*{
    "elements": built["elements"], "appState": appState, "files": newJObject()
  })
  var descriptions = newJArray()
  for element in built["elements"]: descriptions.add(brief(element))
  %*{
    "sceneId": meta["id"], "name": meta["name"], "added": built["elements"].len,
    "elements": descriptions, "warnings": built["warnings"]
  }

proc mutate(api: AgentApi; idOrName, label: string;
    apply: ApplyMutation): JsonNode =
  requireLabel(label)
  let meta = resolve(api, idOrName)
  let sceneId = meta["id"].getStr
  var attempt = 0
  while true:
    let payload = readPayload(api, sceneId)
    if attempt == 0:
      discard api.history.take(sceneId, payload, label)
    let next = apply(payload, meta)
    let appState = if isNullish(next.appState): payload["appState"] else: next.appState
    let files = if isNullish(payload.field("files")): newJObject() else: payload["files"]
    let saved = %*{"elements": next.elements, "appState": appState, "files": files}
    let revision = payload.field("rev").stringOr("")
    var options = SaveOptions(touch: true, ifRev: some(revision))
    try:
      discard api.vault.save(sceneId, saved, options)
    except SceneConflict:
      if attempt >= 3: raise
      inc attempt
      continue
    let newRevision = api.vault.rev(sceneId)
    if newRevision.isSome:
      saved["rev"] = %newRevision.get
      cacheScene(api, sceneId, newRevision.get, saved)
    else:
      invalidateScene(api, sceneId)
    let path = api.vault.scenePath(sceneId)
    if path.isSome:
      try: api.history.claim(sceneId, path.get)
      except CatchableError: discard
    remember(api, sceneId, saved)
    var output = %*{"sceneId": meta["id"], "name": meta["name"]}
    if next.result.isObj:
      for key, value in next.result: output[key] = value
    return output

proc addElements*(api: AgentApi; idOrName: string; elements: JsonNode;
    label: string): JsonNode =
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    let ink = inkFor(paperOf(payload.field("appState")))
    let built = build(elements, payload["elements"], ink)
    var next = newJArray()
    for element in withUpdated(payload["elements"], built["updated"]): next.add(element)
    for element in built["elements"]: next.add(element)
    var descriptions = newJArray()
    for element in built["elements"]: descriptions.add(brief(element))
    Mutation(
      elements: next,
      result: %*{
        "added": built["elements"].len,
        "elements": descriptions,
        "warnings": built["warnings"]
      }
    )

proc snapshotScene*(api: AgentApi; idOrName, label: string): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  requireLabel(label, snapshot = true)
  let entry = api.history.take(meta["id"].getStr, payload, label)
  %*{"sceneId": meta["id"], "name": meta["name"], "snapshot": entry}

proc listHistory*(api: AgentApi; idOrName: string): JsonNode =
  let meta = resolve(api, idOrName)
  let listing = api.history.list(meta["id"].getStr)
  %*{
    "sceneId": meta["id"], "name": meta["name"],
    "bytes": listing.bytes, "entries": listing.entries
  }

proc sliceLimit(value: JsonNode; length: int): int =
  let number = toNumber(value)
  if number.classify == fcNan: return 0
  if number == Inf: return length
  if number == NegInf: return 0
  if number >= float(length): return length
  if number <= -float(length): return 0
  let integer = int(number)
  if integer < 0: max(0, length + integer) else: min(length, integer)

proc describeScene*(api: AgentApi; idOrName: string; limit = 400;
    typeFilter: string = ""): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  let all = live(payload["elements"])
  var elements = all
  if typeFilter.len > 0:
    elements = newJArray()
    for element in all:
      if element.field("type").stringOr("") == typeFilter: elements.add(element)
  let stop = sliceLimit(%limit, elements.len)
  var shown = newJArray()
  for index in 0 ..< stop: shown.add(describe(elements[index]))
  var counts = newJObject()
  for element in all:
    let kind = element.field("type")
    let key = jsString(kind)
    let previous = counts.getOrDefault(key)
    counts[key] = %(if previous.isNil: 1 else: previous.getInt + 1)
  var openComments, resolvedComments = 0
  for element in all:
    let totals = countsOf(element)
    openComments += totals.open
    resolvedComments += totals.resolved
  let background = paperOf(payload.field("appState"))
  %*{
    "id": meta["id"],
    "name": meta["name"],
    "updatedAt": %isoAt(meta["updatedAt"].getBiggestInt),
    "total": all.len,
    "counts": counts,
    "comments": %*{"open": openComments, "resolved": resolvedComments},
    "bounds": bounds(all),
    "background": %background,
    "ink": %inkFor(background),
    "truncated": shown.len < elements.len,
    "elements": shown
  }

proc readElements*(api: AgentApi; idOrName: string; options: JsonNode): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  remember(api, meta["id"].getStr, payload)
  var elements = live(payload["elements"])
  let ids = options.field("ids")
  if ids.isArr and ids.len > 0:
    var wanted = initHashSet[string]()
    for id in ids:
      if id.kind == JString: wanted.incl(id.getStr)
    let source = elements
    elements = newJArray()
    for element in source:
      if wanted.contains(element.field("id").stringOr("")): elements.add(element)
  let typeValue = options.field("type")
  if jsTruthy(typeValue):
    var types = initHashSet[string]()
    if typeValue.kind == JString: types.incl(typeValue.getStr)
    elif typeValue.isArr:
      for value in typeValue:
        if value.kind == JString: types.incl(value.getStr)
    let source = elements
    elements = newJArray()
    for element in source:
      if types.contains(element.field("type").stringOr("")): elements.add(element)
  let contains = options.field("contains")
  if jsTruthy(contains):
    let needle = lowerJs(jsString(contains))
    let source = elements
    elements = newJArray()
    for element in source:
      let text = element.field("text")
      let value = if isNullish(text): "" else: jsString(text)
      if lowerJs(value).contains(needle): elements.add(element)
  let region = options.field("region")
  if jsTruthy(region):
    let xValue = region.field("x")
    let yValue = region.field("y")
    let widthValue = region.field("width")
    let heightValue = region.field("height")
    let x = if isNullish(xValue): -Inf else: toNumber(xValue)
    let y = if isNullish(yValue): -Inf else: toNumber(yValue)
    let width = if isNullish(widthValue): Inf else: toNumber(widthValue)
    let height = if isNullish(heightValue): Inf else: toNumber(heightValue)
    let source = elements
    elements = newJArray()
    for element in source:
      let elementX = toNumber(element.field("x"))
      let elementY = toNumber(element.field("y"))
      let elementWidth = element.field("width")
      let elementHeight = element.field("height")
      if elementX + (if isNullish(elementWidth): 0.0 else: toNumber(elementWidth)) >= x and
          elementY + (if isNullish(elementHeight): 0.0 else: toNumber(elementHeight)) >= y and
          elementX <= x + width and elementY <= y + height:
        elements.add(element)
  let limitValue = if options.hasField("limit"): options["limit"] else: %100
  let stop = sliceLimit(limitValue, elements.len)
  var shown = newJArray()
  for index in 0 ..< stop: shown.add(elements[index])
  %*{
    "id": meta["id"],
    "name": meta["name"],
    "matched": elements.len,
    "truncated": float(elements.len) > toNumber(limitValue),
    "elements": shown
  }

proc typeSet(value: JsonNode): HashSet[string] =
  result = initHashSet[string]()
  if not jsTruthy(value): return
  if value.kind == JString:
    result.incl(value.getStr)
  elif value.isArr:
    for item in value:
      if item.kind == JString: result.incl(item.getStr)

proc collapsed(value: string): string =
  value.replace(re"\s+", " ").strip()

proc commentBodies(element: JsonNode): seq[string] =
  for item in itemsOf(element):
    result.add(item.field("body").stringOr(""))

proc searchElements*(api: AgentApi; idOrName, query: string;
    args: JsonNode): JsonNode =
  ## Find elements without reading the scene, and answer with summaries rather
  ## than full elements. A hit on a bound label is reported as the shape the
  ## label belongs to, because that is the thing an agent wants to edit.
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  remember(api, meta["id"].getStr, payload)
  let all = live(payload["elements"])
  let cleaned = query.strip()
  if cleaned.len == 0:
    let error = newException(AgentError,
      "query is required: a word from the element's text, id or comment")
    error.status = 400
    raise error
  let needle = lowerJs(cleaned)
  let tokens = strutils.splitWhitespace(needle)
  let wantedTypes = typeSet(args.field("type"))
  let full = jsTruthy(args.field("full"))
  let limitValue = if args.hasField("limit"): args["limit"] else: %20
  let limit = sliceLimit(limitValue, high(int))

  var byId = initTable[string, JsonNode]()
  var labels = initTable[string, string]()
  for element in all:
    byId[element.field("id").stringOr("")] = element
    let containerId = element.field("containerId")
    if jsTruthy(containerId) and jsTruthy(element.field("text")):
      labels[jsString(containerId)] = jsString(element["text"])

  proc everyToken(haystack: string): bool =
    for token in tokens:
      if not haystack.contains(token): return false
    true

  type Hit = object
    subject: string
    score: int
    match: string
    snippet: string
    order: int

  var best = initOrderedTable[string, Hit]()
  for index in 0 ..< all.len:
    let element = all[index]
    let id = element.field("id").stringOr("")
    let lowerId = lowerJs(id)
    # a container's label is the text of its bound child, so search "auth" by
    # the name the person reads on the shape, not the shape's empty text field
    let text =
      if jsTruthy(element.field("text")): jsString(element["text"])
      else: labels.getOrDefault(id, "")
    let lowerText = lowerJs(text)
    let bodies = commentBodies(element)
    let lowerComments = lowerJs(bodies.join("\n"))

    # tokens may be spread across the text, the comments and the id: "auth
    # connector" should find a box labelled Auth that has a note about the
    # connector. Rank by the strongest single field that matched.
    if not everyToken(lowerText & "\n" & lowerComments & "\n" & lowerId): continue

    var score = 30
    var matched = "element"
    var snippet = text
    if lowerId == needle:
      score = 100
      matched = "id"
      snippet = ""
    elif lowerText == needle:
      score = 90
      matched = "text"
    elif lowerText.startsWith(needle):
      score = 70
      matched = "text"
    elif everyToken(lowerText):
      score = 50
      matched = "text"
    elif everyToken(lowerComments):
      score = 40
      matched = "comment"
      snippet = ""
      for body in bodies:
        if everyToken(lowerJs(body)):
          snippet = body
          break
    elif everyToken(lowerId):
      score = 20
      matched = "id"
      snippet = ""
    elif snippet.len == 0 and bodies.len > 0:
      snippet = bodies[0]

    var subject = id
    let containerId = element.field("containerId")
    if matched == "text" and jsTruthy(containerId) and
        byId.hasKey(jsString(containerId)):
      subject = jsString(containerId)

    let previous = best.getOrDefault(subject)
    if previous.subject.len == 0 or score > previous.score:
      best[subject] = Hit(subject: subject, score: score, match: matched,
        snippet: snippet, order: index)

  var hits: seq[Hit]
  for key in best.keys:
    let subject = byId[key]
    if wantedTypes.len > 0 and
        not wantedTypes.contains(subject.field("type").stringOr("")):
      continue
    hits.add(best[key])
  hits.sort(proc(a, b: Hit): int =
    if a.score != b.score: cmp(b.score, a.score) else: cmp(a.order, b.order))

  let stop = min(limit, hits.len)
  var results = newJArray()
  for index in 0 ..< stop:
    let hit = hits[index]
    let subject = byId[hit.subject]
    var entry =
      if full: copyNode(subject)
      else: describe(subject)
    if not full:
      if not jsTruthy(entry.field("text")) and labels.hasKey(hit.subject):
        entry["text"] = %collapsed(labels[hit.subject])
      elif jsTruthy(entry.field("text")):
        entry["text"] = %collapsed(jsString(entry["text"]))
      entry["match"] = %hit.match
      let line = collapsed(hit.snippet)
      if line.len > 0: entry["snippet"] = %utf16Slice(line, 80)
    results.add(entry)

  %*{
    "id": meta["id"],
    "name": meta["name"],
    "query": cleaned,
    "matched": hits.len,
    "truncated": hits.len > stop,
    "results": results
  }

proc stringValues(values: JsonNode): seq[string] =
  if values.isNil: return
  var seen = initHashSet[string]()
  if values.isArr:
    for value in values:
      if value.kind == JString and not seen.contains(value.getStr):
        seen.incl(value.getStr)
        result.add(value.getStr)
  elif values.kind == JString:
    for value in values.getStr.runes:
      let text = $value
      if not seen.contains(text):
        seen.incl(text)
        result.add(text)

proc stringSet(values: JsonNode): HashSet[string] =
  result = initHashSet[string]()
  for value in stringValues(values): result.incl(value)

proc updateElements*(api: AgentApi; idOrName: string; patches: JsonNode;
    label: string; ids: JsonNode = nil; patch: JsonNode = nil): JsonNode =
  var list = if patches.isArr and patches.len > 0: patches else: newJArray()
  if not (patches.isArr and patches.len > 0):
    for id in stringValues(ids):
      var entry = newJObject()
      entry["id"] = %id
      if patch.isObj:
        for key, value in patch: entry[key] = copyNode(value)
      list.add(entry)
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    var wanted = initOrderedTable[string, JsonNode]()
    for entry in list:
      if entry.isObj and jsTruthy(entry.field("id")):
        wanted[jsString(entry["id"])] = entry
    var touched = initHashSet[string]()
    var elements = newJArray()
    for element in payload["elements"]:
      let key = jsString(element.field("id"))
      if wanted.hasKey(key):
        touched.incl(key)
        elements.add(patchElement(element, wanted[key], nowMs()))
      else:
        elements.add(element)
    var grown = initOrderedTable[string, JsonNode]()
    for element in elements:
      let key = jsString(element.field("id"))
      if not touched.contains(key) or not jsTruthy(element.field("containerId")):
        continue
      let containerId = jsString(element["containerId"])
      var container: JsonNode
      for candidate in elements:
        if jsString(candidate.field("id")) == containerId:
          container = candidate
          break
      if container.isNil: continue
      let bigger = growContainerFor(element, container, nowMs())
      if cast[pointer](bigger) != cast[pointer](container):
        grown[containerId] = bigger
    if grown.len > 0:
      var replaced = newJArray()
      for element in elements:
        let key = jsString(element.field("id"))
        replaced.add(grown.getOrDefault(key, element))
      elements = replaced
    var missing = newJArray()
    for key in wanted.keys:
      if not touched.contains(key): missing.add(%key)
    Mutation(elements: elements, result: %*{
      "updated": touched.len, "missing": missing
    })

proc deleteElements*(api: AgentApi; idOrName: string; ids: JsonNode;
    label: string): JsonNode =
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    var doomed = stringSet(ids)
    for element in payload["elements"]:
      let containerId = element.field("containerId")
      if jsTruthy(containerId) and doomed.contains(jsString(containerId)):
        doomed.incl(jsString(element.field("id")))
    var removed = 0
    var elements = newJArray()
    for element in payload["elements"]:
      let key = jsString(element.field("id"))
      if jsTruthy(element.field("isDeleted")):
        elements.add(element)
      elif doomed.contains(key):
        inc removed
        var next = copyNode(element)
        next["isDeleted"] = %true
        let version = element.field("version")
        next["version"] = addJs(if isNullish(version): %1 else: version, %1)
        elements.add(next)
      else:
        let startBinding = element.field("startBinding")
        let endBinding = element.field("endBinding")
        let startDoomed = jsTruthy(startBinding) and
          doomed.contains(jsString(startBinding.field("elementId")))
        let endDoomed = jsTruthy(endBinding) and
          doomed.contains(jsString(endBinding.field("elementId")))
        let boundElements = element.field("boundElements")
        var bound = false
        if boundElements.isArr:
          for entry in boundElements:
            if doomed.contains(jsString(entry.field("id"))):
              bound = true
              break
        if not startDoomed and not endDoomed and not bound:
          elements.add(element)
        else:
          var next = copyNode(element)
          if startDoomed: next["startBinding"] = newJNull()
          if endDoomed: next["endBinding"] = newJNull()
          if bound:
            var kept = newJArray()
            for entry in boundElements:
              if not doomed.contains(jsString(entry.field("id"))):
                kept.add(copyNode(entry))
            next["boundElements"] = kept
          let version = element.field("version")
          next["version"] = addJs(if isNullish(version): %1 else: version, %1)
          elements.add(next)
    Mutation(elements: elements, result: %*{"deleted": removed})

proc commentError(message: string; status: int) {.noreturn.} =
  var error = newException(AgentError, message)
  error.status = status
  raise error

template asAgent(body: untyped): untyped =
  try:
    body
  except CommentError as error:
    var wrapped = newException(AgentError, error.msg)
    wrapped.status = error.status
    raise wrapped

proc liveElement(payload: JsonNode; elementId: string): JsonNode =
  for element in payload["elements"]:
    if element.field("id").stringOr("") == elementId and
        not jsTruthy(element.field("isDeleted")):
      return element
  nil

proc commentTarget(payload: JsonNode; elementId: string): JsonNode =
  if elementId.strip().len == 0:
    commentError("elementId is required: a comment attaches to one element", 400)
  result = liveElement(payload, elementId)
  if result.isNil:
    commentError("no live element \"" & elementId & "\" in this scene", 404)

proc addComment*(api: AgentApi; idOrName, elementId, body, label: string;
    authorName = "", authorKind = ""): JsonNode =
  requireLabel(label)
  let meta = resolve(api, idOrName)
  let preview = readPayload(api, meta["id"].getStr)
  discard commentTarget(preview, elementId)
  mutate(api, idOrName, label) do (payload, _: JsonNode) -> Mutation:
    let target = commentTarget(payload, elementId)
    let next = asAgent(appendComment(target, body, authorName, authorKind, nowMs()))
    let items = itemsOf(next)
    let counts = countsOf(next)
    Mutation(
      elements: withUpdated(payload["elements"], %*[next]),
      result: %*{
        "elementId": elementId,
        "comment": shapeComment(target, items[items.len - 1]),
        "open": counts.open,
        "resolved": counts.resolved
      }
    )

proc listComments*(api: AgentApi; idOrName, elementId, status: string;
    limit = 500): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  let wanted = status.strip().toLowerAscii
  if wanted.len > 0 and wanted notin ["open", "resolved"]:
    commentError("status must be open or resolved", 400)
  let only = elementId.strip()
  if only.len > 0: discard commentTarget(payload, only)
  var total, open, resolved, shown = 0
  var truncated = false
  var comments = newJArray()
  for element in payload["elements"]:
    if jsTruthy(element.field("isDeleted")): continue
    if only.len > 0 and element.field("id").stringOr("") != only: continue
    for item in itemsOf(element):
      let state = item.field("status").stringOr("open")
      inc total
      if state == "resolved": inc resolved else: inc open
      if wanted.len > 0 and state != wanted: continue
      inc shown
      if shown > limit:
        truncated = true
        continue
      comments.add(shapeComment(element, item))
  %*{
    "sceneId": meta["id"],
    "name": meta["name"],
    "total": total,
    "open": open,
    "resolved": resolved,
    "truncated": truncated,
    "comments": comments
  }

proc updateComment*(api: AgentApi; idOrName, elementId, commentId, action,
    label: string): JsonNode =
  requireLabel(label)
  let meta = resolve(api, idOrName)
  let kind = asAgent(parseAction(action))
  if commentId.strip().len == 0:
    commentError("commentId is required", 400)
  let preview = readPayload(api, meta["id"].getStr)
  let before = commentTarget(preview, elementId)
  let state = stateOf(before, commentId)
  if state.len == 0:
    commentError("no comment \"" & commentId & "\" on element " & elementId, 404)
  if kind != caDelete and
      ((kind == caResolve and state == "resolved") or
       (kind == caReopen and state == "open")):
    return %*{
      "sceneId": meta["id"],
      "name": meta["name"],
      "elementId": elementId,
      "commentId": commentId,
      "status": state,
      "changed": false
    }
  mutate(api, idOrName, label) do (payload, _: JsonNode) -> Mutation:
    let target = commentTarget(payload, elementId)
    let outcome = applyAction(target, commentId, kind, nowMs())
    let counts = countsOf(outcome.element)
    var output = %*{
      "elementId": elementId,
      "commentId": commentId,
      "status": outcome.status,
      "changed": outcome.changed,
      "open": counts.open,
      "resolved": counts.resolved
    }
    if kind != caDelete:
      let item = commentOf(outcome.element, commentId)
      if not item.isNil: output["comment"] = shapeComment(outcome.element, item)
    Mutation(
      elements: withUpdated(payload["elements"], %*[outcome.element]),
      result: output
    )

proc moveElements*(api: AgentApi; idOrName: string; args: JsonNode;
    label: string): JsonNode =
  let requestedIds = stringValues(args.field("ids"))
  let wantedIds = stringSet(args.field("ids"))
  let wantedGroups = stringSet(args.field("groupIds"))
  let region = args.field("region")
  let hasBox = jsTruthy(region)
  let boxX = if isNullish(region.field("x")): -Inf else: toNumber(region["x"])
  let boxY = if isNullish(region.field("y")): -Inf else: toNumber(region["y"])
  let boxWidth = if isNullish(region.field("width")): Inf else: toNumber(region["width"])
  let boxHeight = if isNullish(region.field("height")): Inf else: toNumber(region["height"])
  let dx = if args.hasField("dx"): args["dx"] else: %0
  let dy = if args.hasField("dy"): args["dy"] else: %0
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    proc inBox(element: JsonNode): bool =
      hasBox and
        toNumber(element.field("x")) +
          (if isNullish(element.field("width")): 0.0 else: toNumber(element["width"])) >= boxX and
        toNumber(element.field("y")) +
          (if isNullish(element.field("height")): 0.0 else: toNumber(element["height"])) >= boxY and
        toNumber(element.field("x")) <= boxX + boxWidth and
        toNumber(element.field("y")) <= boxY + boxHeight
    var moving = initHashSet[string]()
    for element in payload["elements"]:
      if jsTruthy(element.field("isDeleted")): continue
      let groups = stringSet(element.field("groupIds"))
      var grouped = false
      for group in groups:
        if wantedGroups.contains(group): grouped = true
      if wantedIds.contains(jsString(element.field("id"))) or inBox(element) or grouped:
        moving.incl(jsString(element.field("id")))
    for element in payload["elements"]:
      let containerId = element.field("containerId")
      if jsTruthy(containerId) and moving.contains(jsString(containerId)):
        moving.incl(jsString(element.field("id")))
    var moved = newJArray()
    var followed = 0
    var elements = newJArray()
    for element in payload["elements"]:
      let key = jsString(element.field("id"))
      if moving.contains(key):
        let next = patchElement(element, %*{
          "x": addJs(element.field("x"), dx),
          "y": addJs(element.field("y"), dy)
        }, nowMs())
        moved.add(next)
        elements.add(next)
        continue
      if element.field("type").stringOr("") != "arrow":
        elements.add(element)
        continue
      let pointsValue = element.field("points")
      if not pointsValue.isArr or pointsValue.len < 2:
        elements.add(element)
        continue
      let startBinding = element.field("startBinding")
      let endBinding = element.field("endBinding")
      let startFollows = jsTruthy(startBinding) and
        moving.contains(jsString(startBinding.field("elementId")))
      let endFollows = jsTruthy(endBinding) and
        moving.contains(jsString(endBinding.field("elementId")))
      if not startFollows and not endFollows:
        elements.add(element)
        continue
      var points: seq[tuple[x, y: JsonNode]]
      for point in pointsValue:
        let px = if point.isArr and point.len > 0: copyNode(point[0]) else: newJNull()
        let py = if point.isArr and point.len > 1: copyNode(point[1]) else: newJNull()
        points.add((x: px, y: py))
      var x = element.field("x")
      var y = element.field("y")
      if startFollows:
        x = addJs(x, dx)
        y = addJs(y, dy)
        for index in 1 ..< points.len:
          points[index].x = numberNode(toNumber(points[index].x) - toNumber(dx))
          points[index].y = numberNode(toNumber(points[index].y) - toNumber(dy))
      if endFollows:
        points[^1].x = addJs(points[^1].x, dx)
        points[^1].y = addJs(points[^1].y, dy)
      var pointArray = newJArray()
      for point in points: pointArray.add(%*[point.x, point.y])
      var minX = Inf
      var minY = Inf
      var maxX = -Inf
      var maxY = -Inf
      for point in points:
        let px = toNumber(point.x)
        let py = toNumber(point.y)
        minX = min(minX, px)
        minY = min(minY, py)
        maxX = max(maxX, px)
        maxY = max(maxY, py)
      inc followed
      elements.add(patchElement(element, %*{
        "x": x, "y": y, "points": pointArray,
        "width": numberNode(maxX - minX), "height": numberNode(maxY - minY)
      }, nowMs()))
    var missing = newJArray()
    for id in requestedIds:
      if not moving.contains(id): missing.add(%id)
    Mutation(elements: elements, result: %*{
      "moved": moved.len, "followed": followed,
      "missing": missing, "bounds": bounds(moved)
    })

proc replaceElements*(api: AgentApi; idOrName: string; elements: JsonNode;
    label: string): JsonNode =
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    let ink = inkFor(paperOf(payload.field("appState")))
    let built = build(elements, newJArray(), ink)
    Mutation(elements: built["elements"], result: %*{
      "total": built["elements"].len, "warnings": built["warnings"]
    })

proc writeScene*(api: AgentApi; idOrName: string; elements, appState: JsonNode;
    label: string): JsonNode =
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    let built = build(elements, newJArray(), inkFor(paperOf(payload.field("appState"))))
    let nextState = if jsTruthy(appState):
      mergeObjects(payload.field("appState"), appState) else: payload["appState"]
    Mutation(elements: built["elements"], appState: nextState, result: %*{
      "total": built["elements"].len, "warnings": built["warnings"]
    })

proc setBackground*(api: AgentApi; idOrName, color, label: string): JsonNode =
  mutate(api, idOrName, label) do (payload, meta: JsonNode) -> Mutation:
    let ink = inkFor(color)
    Mutation(
      elements: payload["elements"],
      appState: mergeObjects(payload.field("appState"), %*{
        "viewBackgroundColor": color, "currentItemStrokeColor": ink
      }),
      result: %*{"background": color, "ink": ink}
    )

proc importSvg*(api: AgentApi; idOrName, svg: string; options: JsonNode;
    label: string): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  let ink = inkFor(paperOf(payload.field("appState")))
  let sourceOptions = if isNullish(options): nil else: options
  var settings: JsonNode = nil
  if not sourceOptions.isNil:
    settings = %*{"currentColor": ink}
    for key, value in sourceOptions: settings[key] = copyNode(value)
  let converted = svgToSpecs(svg, settings)
  let groupOption = options.field("group")
  let noGroup = not groupOption.isNil and groupOption.kind == JBool and
    not groupOption.getBool
  result = mutate(api, meta["id"].getStr, label) do (current, scene: JsonNode) -> Mutation:
    let built = build(converted["specs"], current["elements"], ink)
    let group = if noGroup: "" else: newSvgGroup()
    let grouped = if group.len > 0: withGroup(built["elements"], group)
      else: built["elements"]
    var next = newJArray()
    for element in withUpdated(current["elements"], built["updated"]): next.add(element)
    for element in grouped: next.add(element)
    var warnings = newJArray()
    for warning in converted["warnings"]: warnings.add(copyNode(warning))
    for warning in built["warnings"]: warnings.add(copyNode(warning))
    var ids = newJArray()
    for element in grouped: ids.add(copyNode(element.field("id")))
    Mutation(elements: next, result: %*{
      "added": grouped.len,
      "groupId": if group.len > 0: %group else: newJNull(),
      "ids": ids,
      "warnings": warnings
    })
  result["placed"] = copyNode(converted["placed"])
  result["source"] = copyNode(converted["source"])
  return result

proc checkScene*(api: AgentApi; idOrName: string; options: JsonNode = nil): JsonNode =
  let meta = resolve(api, idOrName)
  let payload = readPayload(api, meta["id"].getStr)
  remember(api, meta["id"].getStr, payload)
  result = %*{"id": meta["id"], "name": meta["name"]}
  let inspection = inspectScene(payload["elements"], options)
  for key, value in inspection: result[key] = value

proc noteExternalChange*(api: AgentApi; sceneId: string): JsonNode =
  invalidateScene(api, sceneId)
  if api.vault.rev(sceneId).isNone:
    api.lastKnown.del(sceneId)
    return newJNull()
  let path = api.vault.scenePath(sceneId)
  if path.isSome and api.history.isClaimed(sceneId, path.get): return newJNull()
  if not api.lastKnown.hasKey(sceneId): return newJNull()
  let previous = api.lastKnown[sceneId]
  let payload = %*{"elements": previous.elements, "appState": previous.appState}
  var entry: JsonNode
  try:
    entry = api.history.take(sceneId, payload, "edited outside Sketchdex", "external")
  except CatchableError:
    return newJNull()
  try:
    let fresh = readPayload(api, sceneId)
    remember(api, sceneId, fresh)
  except CatchableError:
    discard
  entry

proc restoreSnapshot*(api: AgentApi; idOrName, snapId: string): JsonNode =
  let meta = resolve(api, idOrName)
  let snapshot = api.history.read(meta["id"].getStr, snapId)
  mutate(api, meta["id"].getStr, "restore snapshot") do (payload, scene: JsonNode) -> Mutation:
    let savedState = snapshot.field("appState")
    let nextState = if isNullish(savedState): payload["appState"]
      else: mergeObjects(payload.field("appState"), savedState)
    Mutation(
      elements: snapshot["elements"],
      appState: nextState,
      result: %*{"restored": snapId, "elements": snapshot["elements"].len}
    )

proc discardSnapshot*(api: AgentApi; idOrName, snapId: string): JsonNode =
  let meta = resolve(api, idOrName)
  %*{"entries": api.history.discard(meta["id"].getStr, snapId)}

proc clearHistory*(api: AgentApi; idOrName: string): JsonNode =
  let meta = resolve(api, idOrName)
  %*{"entries": api.history.clear(meta["id"].getStr)}

proc listLibrary*(api: AgentApi): JsonNode =
  let items = api.library.readItems()
  var shown = newJArray()
  for item in items:
    let elements = item.field("elements")
    var entry = %*{
      "id": item.field("id").stringOr(""),
      "elements": if elements.isArr: elements.len else: 0
    }
    let name = item.field("name")
    if not name.isNil and name.kind == JString: entry["name"] = name
    shown.add(entry)
  let current = api.library.rev
  %*{
    "rev": if current.isSome: %current.get else: newJNull(),
    "total": items.len,
    "items": shown
  }

proc browseLibraries*(api: AgentApi; query: string; args: JsonNode): JsonNode =
  let catalog = loadCatalog()
  let limit = args.field("limit").intOr(20)
  %*{"total": catalog.len, "results": browseCatalog(catalog, query, limit)}

proc installLibrary*(api: AgentApi; refOrUrl: string): JsonNode =
  let wanted = refOrUrl.strip
  if wanted.len == 0:
    let error = newException(library.LibraryError,
      "library is required: a catalog id or a .excalidrawlib URL")
    error.status = 400
    raise error
  # an id needs the catalog to find its URL; a URL does not, and should still
  # install when the catalog is unreachable
  let catalog =
    if wanted.startsWith("http://") or wanted.startsWith("https://"): newJArray()
    else: loadCatalog()
  installFrom(api.library, catalog, wanted)
