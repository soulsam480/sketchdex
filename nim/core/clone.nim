import std/[json, math, sets, tables]

import ./[elements, jsvalue, random_ids]

type
  CloneResult* = object
    elements*: JsonNode
    idMap*: JsonNode
    warnings*: seq[string]

proc freshIdentity(taken: var HashSet[string]): string =
  while true:
    let candidate = newId()
    if not taken.containsOrIncl(candidate): return candidate

proc groupsOf(element: JsonNode): seq[string] =
  let values = element.field("groupIds")
  if not values.isArr: return
  for value in values:
    if value.kind == JString and value.getStr.len > 0: result.add(value.getStr)

proc originOf(elements: seq[JsonNode]): tuple[x, y: float] =
  var minX = Inf
  var minY = Inf
  for element in elements:
    minX = min(minX, floatOr(element.field("x"), 0.0))
    minY = min(minY, floatOr(element.field("y"), 0.0))
  if minX == Inf: (0.0, 0.0) else: (minX, minY)

proc remapRef(value: JsonNode; idMap: JsonNode; warnings: var seq[string];
    label: string): JsonNode =
  let key = value.getStr
  if idMap.hasKey(key): return %idMap[key].getStr
  warnings.add(label & " \"" & key & "\" points outside the item")
  newJNull()

proc remapOptionalRef(next, source: JsonNode; key, label: string;
    idMap: JsonNode; warnings: var seq[string]) =
  let value = source.field(key)
  if value.isNil or value.kind != JString or value.getStr.len == 0: return
  next[key] = remapRef(value, idMap, warnings, label)

proc remapGroups(next, source: JsonNode; groupMap: Table[string, string]) =
  let values = source.field("groupIds")
  if not values.isArr: return
  var mapped = newJArray()
  for value in values:
    if value.kind == JString and groupMap.hasKey(value.getStr):
      mapped.add(%groupMap[value.getStr])
    else:
      mapped.add(copyNode(value))
  next["groupIds"] = mapped

proc remapBoundElements(next, source: JsonNode; idMap: JsonNode;
    warnings: var seq[string]) =
  let entries = source.field("boundElements")
  if not entries.isArr: return
  var kept = newJArray()
  for entry in entries:
    let idValue = if entry.isObj: entry.field("id") else: nil
    if idValue.kind == JString and idValue.getStr.len > 0 and
        idMap.hasKey(idValue.getStr):
      var copy = copyNode(entry)
      copy["id"] = %idMap[idValue.getStr].getStr
      kept.add(copy)
    else:
      let dropped = if idValue.kind == JString: "\"" & idValue.getStr & "\""
        else: "with no id"
      warnings.add("dropped boundElements entry " & dropped)
  next["boundElements"] = kept

proc remapBinding(next, source: JsonNode; key: string; idMap: JsonNode;
    warnings: var seq[string]) =
  let binding = source.field(key)
  if not binding.isObj: return
  let idValue = binding.field("elementId")
  if idValue.isNil or idValue.kind != JString or idValue.getStr.len == 0: return
  var copy = copyNode(binding)
  copy["elementId"] = remapRef(idValue, idMap, warnings, key & " elementId")
  next[key] = copy

proc cloneElementsForInsert*(itemElements, existing: JsonNode;
    targetX, targetY: float; now: int64): CloneResult =
  result.elements = newJArray()
  result.idMap = newJObject()
  if not itemElements.isArr or itemElements.len == 0:
    raise newException(ValueError, "library item has no elements")

  var usable: seq[JsonNode]
  var sourceIds = initHashSet[string]()
  for index in 0 ..< itemElements.len:
    let element = itemElements[index]
    if not element.isObj:
      result.warnings.add("dropped element " & $index & ": expected an object")
      continue
    let kind = element.field("type")
    if kind.isNil or kind.kind != JString or kind.getStr.len == 0:
      raise newException(ValueError, "element " & $index & " needs a string type")
    let id = element.field("id").stringOr("")
    if id.len > 0 and sourceIds.containsOrIncl(id):
      raise newException(ValueError, "duplicate element id \"" & id & "\"")
    usable.add(element)

  var taken = initHashSet[string]()
  var groupsTaken = initHashSet[string]()
  if existing.isArr:
    for element in existing:
      let id = element.field("id").stringOr("")
      if id.len > 0: taken.incl(id)
      for group in groupsOf(element): groupsTaken.incl(group)
  for id in sourceIds: taken.incl(id)

  var groupMap = initTable[string, string]()
  for element in usable:
    for group in groupsOf(element):
      if not groupMap.hasKey(group):
        groupMap[group] = freshIdentity(groupsTaken)

  let nextIndex = indexFactory(if existing.isArr: existing else: newJArray())
  let origin = originOf(usable)
  let tx = (if classify(targetX) in {fcNan, fcInf, fcNegInf}: 0.0 else: targetX)
  let ty = (if classify(targetY) in {fcNan, fcInf, fcNegInf}: 0.0 else: targetY)
  let dx = tx - origin.x
  let dy = ty - origin.y

  var identities: seq[string]
  for element in usable:
    let oldId = element.field("id").stringOr("")
    let identity = freshIdentity(taken)
    if oldId.len > 0: result.idMap[oldId] = %identity
    identities.add(identity)

  for index in 0 ..< usable.len:
    let element = usable[index]
    var next = copyNode(element)
    let identity = identities[index]
    next["id"] = %identity
    next["seed"] = %nonce()
    let version = element.field("version")
    next["version"] = %(if version.isFiniteNumber: intOr(version, 0) + 1 else: 1)
    next["versionNonce"] = %nonce()
    next["updated"] = %now
    next["index"] = %nextIndex()
    next["x"] = numberNode(floatOr(element.field("x"), 0.0) + dx)
    next["y"] = numberNode(floatOr(element.field("y"), 0.0) + dy)
    remapGroups(next, element, groupMap)
    remapOptionalRef(next, element, "containerId", "containerId",
      result.idMap, result.warnings)
    remapOptionalRef(next, element, "frameId", "frameId",
      result.idMap, result.warnings)
    remapBoundElements(next, element, result.idMap, result.warnings)
    remapBinding(next, element, "startBinding", result.idMap, result.warnings)
    remapBinding(next, element, "endBinding", result.idMap, result.warnings)
    result.elements.add(next)
