import std/[algorithm, json, math, strutils, tables, unicode]

import ./[geometry, jsvalue, random_ids, textmetrics]

const
  SugaredTypes = [
    "rectangle", "ellipse", "diamond", "arrow", "line", "text", "freedraw",
    "frame"
  ]
  ShapeTypes = ["rectangle", "ellipse", "diamond"]
  LinearTypes = ["arrow", "line"]
  ConsumedFields = ["ref", "label", "start", "end", "wrap"]
  IndexDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

type
  Association = tuple[key, value: JsonNode]
  AssociationStore = object
    ordered: seq[Association]
    stringIndexes: Table[string, int]
  NormalisedPoints = tuple[points: JsonNode, dx, dy: float]

proc patchElement*(element, patch: JsonNode; now: int64): JsonNode
proc jsJson(value: JsonNode): string

proc isNullish(value: JsonNode): bool =
  value.isNil or value.kind == JNull

proc isFalse(value: JsonNode): bool =
  not value.isNil and value.kind == JBool and not value.getBool

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
  var i = 0
  while i < stop:
    let code = units[i]
    if code in uint16(0xd800) .. uint16(0xdbff) and i + 1 < stop and
        units[i + 1] in uint16(0xdc00) .. uint16(0xdfff):
      let offset = (uint32(code) - 0xd800) * 0x400 + (uint32(units[i + 1]) - 0xdc00)
      result.add(toUTF8(Rune(0x10000 + offset)))
      i += 2
    else:
      result.add(toUTF8(Rune(code)))
      i += 1

proc warningSlice(value: JsonNode): string =
  utf16Slice(jsJson(value), 80)

proc coalesce(first, second: JsonNode): JsonNode =
  if isNullish(first): second else: first

proc nullishString(value: JsonNode): string =
  if isNullish(value): "" else: jsString(value)

proc finiteNumberNode(value: JsonNode; fallback: float): JsonNode =
  if value.isFiniteNumber:
    if value.kind == JInt: return copyNode(value)
    return newJFloat(value.getFloat)
  numberNode(fallback)

proc parseJsNumberString(text: string): float =
  let value = text.strip()
  if value.len == 0: return 0.0
  case value
  of "Infinity", "+Infinity": return Inf
  of "-Infinity": return NegInf
  of "NaN": return NaN
  else: discard

  if value.startsWith("0x") or value.startsWith("0X"):
    let digits = value[2 .. ^1]
    if digits.len == 0: return NaN
    var number = 0.0
    for ch in digits.toLowerAscii:
      let digit =
        if ch in {'0' .. '9'}: int(ch) - int('0')
        elif ch in {'a' .. 'f'}: int(ch) - int('a') + 10
        else: return NaN
      number = number * 16.0 + float(digit)
    return number

  for (prefix, radix) in [("0b", 2.0), ("0o", 8.0)]:
    if value.startsWith(prefix) or value.startsWith(prefix.toUpperAscii):
      let digits = value[2 .. ^1]
      if digits.len == 0: return NaN
      var number = 0.0
      for ch in digits:
        let digit =
          if radix == 2.0 and ch in {'0' .. '1'}: int(ch) - int('0')
          elif radix == 8.0 and ch in {'0' .. '7'}: int(ch) - int('0')
          else: return NaN
        number = number * radix + float(digit)
      return number

  var i = 0
  if value[i] in {'+', '-'}: i += 1
  var mantissaDigits = 0
  while i < value.len and value[i] in {'0' .. '9'}:
    inc i
    inc mantissaDigits
  if i < value.len and value[i] == '.':
    inc i
    while i < value.len and value[i] in {'0' .. '9'}:
      inc i
      inc mantissaDigits
  if mantissaDigits == 0: return NaN
  if i < value.len and value[i] in {'e', 'E'}:
    inc i
    if i < value.len and value[i] in {'+', '-'}: inc i
    let exponentStart = i
    while i < value.len and value[i] in {'0' .. '9'}: inc i
    if i == exponentStart: return NaN
  if i != value.len: return NaN
  try: parseFloat(value)
  except ValueError: NaN

proc jsToNumber(value: JsonNode): float =
  if value.isNil: return NaN
  case value.kind
  of JNull: 0.0
  of JBool: (if value.getBool: 1.0 else: 0.0)
  of JInt: float(value.getInt)
  of JFloat: value.getFloat
  of JString: parseJsNumberString(value.getStr)
  of JArray: parseJsNumberString(jsString(value))
  of JObject: NaN

proc jsPrimitive(value: JsonNode): JsonNode =
  if value.kind in {JArray, JObject}: %jsString(value) else: value

proc jsAddValues(left, right: JsonNode): JsonNode =
  let a = jsPrimitive(left)
  let b = jsPrimitive(right)
  if a.kind == JString or b.kind == JString:
    newJString(jsString(a) & jsString(b))
  else:
    numberNode(jsToNumber(a) + jsToNumber(b))

proc jsAddNumber(left: JsonNode; right: float): JsonNode =
  let value = jsPrimitive(left)
  if value.kind == JString:
    newJString(value.getStr & jsNumberString(right))
  else:
    numberNode(jsToNumber(value) + right)

proc jsStrictEqual(left, right: JsonNode): bool =
  if left.isNil or right.isNil: return left.isNil and right.isNil
  if left.kind != right.kind:
    return left.isNumber and right.isNumber and
      jsToNumber(left) == jsToNumber(right)
  case left.kind
  of JInt, JFloat:
    let a = jsToNumber(left)
    let b = jsToNumber(right)
    a.classify != fcNan and b.classify != fcNan and a == b
  of JString: left.getStr == right.getStr
  of JBool: left.getBool == right.getBool
  of JNull: true
  of JArray, JObject: cast[pointer](left) == cast[pointer](right)

proc jsSameValueZero(left, right: JsonNode): bool =
  if left.isNumber and right.isNumber:
    let a = jsToNumber(left)
    let b = jsToNumber(right)
    (a.classify == fcNan and b.classify == fcNan) or a == b
  else:
    jsStrictEqual(left, right)

proc findAssociation(values: AssociationStore; key: JsonNode): JsonNode =
  if not key.isNil and key.kind == JString:
    let index = values.stringIndexes.getOrDefault(key.getStr, -1)
    if index >= 0: return values.ordered[index].value
    return nil
  for i in countdown(values.ordered.high, 0):
    if jsSameValueZero(values.ordered[i].key, key): return values.ordered[i].value
  nil

proc setAssociation(values: var AssociationStore; key, value: JsonNode) =
  if not key.isNil and key.kind == JString:
    let text = key.getStr
    let index = values.stringIndexes.getOrDefault(text, -1)
    if index >= 0:
      values.ordered[index].value = value
      return
    values.stringIndexes[text] = values.ordered.len
  else:
    for i in 0 .. values.ordered.high:
      if jsSameValueZero(values.ordered[i].key, key):
        values.ordered[i].value = value
        return
  values.ordered.add((key, value))

proc jsJsonQuote(value: string): string =
  result = "\""
  for ch in value:
    case ch
    of '"': result.add("\\\"")
    of '\\': result.add("\\\\")
    of '\b': result.add("\\b")
    of '\f': result.add("\\f")
    of '\n': result.add("\\n")
    of '\r': result.add("\\r")
    of '\t': result.add("\\t")
    of '\x00' .. '\x07', '\x0b', '\x0e' .. '\x1f':
      const hex = "0123456789abcdef"
      result.add("\\u00")
      result.add(hex[int(ch) shr 4])
      result.add(hex[int(ch) and 0xf])
    else: result.add(ch)
  result.add('"')

proc integerLikeKey(key: string): bool =
  if key.len == 0: return false
  if key.len > 1 and key[0] == '0': return false
  for ch in key:
    if ch notin {'0' .. '9'}: return false
  if key.len < 10: return true
  if key.len > 10: return false
  key <= "4294967294"

proc jsJson(value: JsonNode): string =
  if value.isNil: return "undefined"
  case value.kind
  of JNull: "null"
  of JBool: (if value.getBool: "true" else: "false")
  of JInt: $value.getInt
  of JFloat:
    if value.getFloat.classify in {fcNan, fcInf, fcNegInf}: "null"
    else: jsNumberString(value.getFloat)
  of JString: jsJsonQuote(value.getStr)
  of JArray:
    var parts: seq[string]
    for item in value: parts.add(if item.isNil: "null" else: jsJson(item))
    "[" & parts.join(",") & "]"
  of JObject:
    var integerKeys: seq[string]
    var stringKeys: seq[string]
    for key, item in value:
      if item.isNil: continue
      if integerLikeKey(key): integerKeys.add(key)
      else: stringKeys.add(key)
    integerKeys.sort(proc(a, b: string): int =
      cmp(parseBiggestInt(a), parseBiggestInt(b))
    )
    var parts: seq[string]
    for key in integerKeys: parts.add(jsJsonQuote(key) & ":" & jsJson(value[key]))
    for key in stringKeys: parts.add(jsJsonQuote(key) & ":" & jsJson(value[key]))
    "{" & parts.join(",") & "}"

proc integerLength(head: char): int =
  if head in {'a' .. 'z'}: return int(head) - int('a') + 2
  if head in {'A' .. 'Z'}: return int('Z') - int(head) + 2
  0

proc integerPart(key: string): string =
  if key.len == 0: return ""
  let length = integerLength(key[0])
  if length == 0 or length > key.len: return ""
  key[0 ..< length]

proc validIndex(value: JsonNode): bool =
  if value.isNil or value.kind != JString: return false
  let key = value.getStr
  if key.len == 0 or key[0] notin {'A' .. 'Z', 'a' .. 'z'}: return false
  for ch in key:
    if ch notin {'0' .. '9', 'A' .. 'Z', 'a' .. 'z'}: return false
  integerPart(key).len > 0

proc incrementInteger(integer: string): string =
  if integer.len == 0: return "a0"
  let head = integer[0]
  var digits = integer[1 .. ^1]
  var carry = true
  for i in countdown(digits.high, 0):
    if not carry: break
    let next = IndexDigits.find(digits[i]) + 1
    if next == IndexDigits.len:
      digits[i] = IndexDigits[0]
    else:
      digits[i] = IndexDigits[next]
      carry = false
  if not carry: return head & digits
  if head == 'Z': return "a0"
  if head == 'z': return ""
  let nextHead = char(int(head) + 1)
  if nextHead > 'a': digits.add(IndexDigits[0])
  else: digits.setLen(max(0, digits.len - 1))
  nextHead & digits

proc indexFactory(existing: JsonNode): proc(): string =
  if not existing.isArr:
    raise newException(ValueError, "existing is not iterable")
  var taken: seq[string]
  for element in existing:
    let index = element.field("index")
    if validIndex(index): taken.add(index.getStr)
  taken.sort()
  var current = if taken.len > 0: taken[^1] else: ""
  proc nextIndex(): string =
    current = if current.len > 0: incrementInteger(integerPart(current)) else: "a0"
    if current.len == 0: current = "a0"
    current
  nextIndex

proc defaultRoundness(kind: string): JsonNode =
  if kind in ["rectangle", "ellipse"]: return %*{"type": 3}
  if kind in ["diamond", "arrow", "line"]: return %*{"type": 2}
  newJNull()

proc base(spec: JsonNode; index, ink: string; now: int64): JsonNode =
  result = newJObject()
  for key, value in spec:
    if key notin ConsumedFields: result[key] = copyNode(value)
  setDefault(result, "id", %newId())
  setDefault(result, "x", newJInt(0))
  setDefault(result, "y", newJInt(0))
  setDefault(result, "width", newJInt(100))
  setDefault(result, "height", newJInt(100))
  setDefault(result, "angle", newJInt(0))
  setDefault(result, "strokeColor", %ink)
  setDefault(result, "backgroundColor", %"transparent")
  setDefault(result, "fillStyle", %"solid")
  setDefault(result, "strokeWidth", newJInt(2))
  setDefault(result, "strokeStyle", %"solid")
  setDefault(result, "roughness", newJInt(1))
  setDefault(result, "opacity", newJInt(100))
  setDefault(result, "groupIds", newJArray())
  setDefault(result, "frameId", newJNull())
  setDefault(result, "roundness", defaultRoundness(spec.field("type").stringOr("")))
  setDefault(result, "seed", %nonce())
  setDefault(result, "version", newJInt(1))
  setDefault(result, "versionNonce", %nonce())
  setDefault(result, "isDeleted", newJBool(false))
  setDefault(result, "boundElements", newJArray())
  setDefault(result, "updated", newJInt(now))
  setDefault(result, "link", newJNull())
  setDefault(result, "locked", newJBool(false))
  result["index"] =
    if validIndex(spec.field("index")): copyNode(spec["index"])
    else: %index

proc metricFontFamily(value: JsonNode): float =
  let key = jsString(coalesce(value, %DEFAULT_FONT_FAMILY))
  let number = parseJsNumberString(key)
  if jsNumberString(number) == key: number else: NaN

proc textFields(spec, container: JsonNode): JsonNode =
  let fontSize = floatOr(spec.field("fontSize"), DEFAULT_FONT_SIZE)
  let fontFamily = floatOr(spec.field("fontFamily"), DEFAULT_FONT_FAMILY)
  let original = nullishString(spec.field("text"))
  let containerId =
    if isNullish(container): newJNull()
    else: coalesce(container.field("id"), newJNull())

  var wrapWidth: JsonNode = nil
  if jsTruthy(container):
    wrapWidth = numberNode(max(
      labelMaxWidth(container.field("type").stringOr(""),
        floatOr(container.field("width"), 0.0)),
      fontSize
    ))
  elif spec.field("wrap").isNumber:
    wrapWidth = copyNode(spec["wrap"])
  elif not isFalse(spec.field("wrap")) and spec.field("width").isNumber:
    wrapWidth = copyNode(spec["width"])

  let text =
    if jsTruthy(wrapWidth): wrapText(original, jsToNumber(wrapWidth), fontSize, fontFamily)
    else: original
  let measured = measureText(text, fontSize, fontFamily)
  let measuredWidth =
    if jsTruthy(wrapWidth): max(jsToNumber(wrapWidth), measured.width)
    else: measured.width

  result = %*{
    "text": text,
    "originalText": original,
    "fontSize": fontSize,
    "fontFamily": fontFamily,
    "textAlign": coalesce(spec.field("textAlign"),
      %(if jsTruthy(containerId): "center" else: "left")),
    "verticalAlign": coalesce(spec.field("verticalAlign"),
      %(if jsTruthy(containerId): "middle" else: "top")),
    "containerId": containerId,
    "autoResize": not jsTruthy(containerId) and not jsTruthy(wrapWidth),
    "lineHeight": LINE_HEIGHT,
    "measured": {
      "width": numberNode(measuredWidth),
      "height": numberNode(measured.height)
    }
  }

proc normalisePoints(spec: JsonNode): NormalisedPoints =
  let raw = spec.field("points")
  if not raw.isArr or raw.len < 2:
    return (
      points: %*[
        [newJInt(0), newJInt(0)],
        [numberNode(floatOr(spec.field("width"), 100.0)),
          numberNode(floatOr(spec.field("height"), 0.0))]
      ],
      dx: 0.0,
      dy: 0.0
    )

  var points: seq[JsonNode]
  for point in raw:
    var normalised: JsonNode
    if point.isArr:
      normalised = %*[
        finiteNumberNode(arrayValue(point, 0), 0.0),
        finiteNumberNode(arrayValue(point, 1), 0.0)
      ]
    else:
      normalised = %*[
        finiteNumberNode(point.field("x"), 0.0),
        finiteNumberNode(point.field("y"), 0.0)
      ]
    points.add(normalised)

  let originX = floatOr(points[0][0], 0.0)
  let originY = floatOr(points[0][1], 0.0)
  if originX == 0.0 and originY == 0.0:
    var output = newJArray()
    for point in points: output.add(point)
    return (output, 0.0, 0.0)

  var output = newJArray()
  for point in points:
    output.add(%*[
      numberNode(floatOr(point[0], 0.0) - originX),
      numberNode(floatOr(point[1], 0.0) - originY)
    ])
  (output, originX, originY)

proc spreadValues(value: JsonNode): seq[JsonNode] =
  if isNullish(value): return @[]
  if value.isArr:
    for item in value: result.add(copyNode(item))
    return
  if value.kind == JString:
    for ch in value.getStr.runes: result.add(%($ch))
    return
  raise newException(ValueError, "value is not iterable")

proc withReverseEntry(element: JsonNode; entry: JsonNode) =
  var values = spreadValues(element.field("boundElements"))
  values.add(entry)
  element["boundElements"] = newJArray()
  for value in values: element["boundElements"].add(value)

proc labelText(label: JsonNode): string =
  if label.kind in {JObject, JArray}: nullishString(label.field("text"))
  else: nullishString(label)

proc findTarget(byRef, byId, scene: AssociationStore; target: JsonNode): JsonNode =
  if not jsTruthy(target): return nil
  if target.kind == JString:
    return coalesce(findAssociation(byRef, target),
      coalesce(findAssociation(byId, target), findAssociation(scene, target)))
  let targetRef = target.field("ref")
  if jsTruthy(targetRef): return findAssociation(byRef, targetRef)
  let targetId = target.field("id")
  if jsTruthy(targetId):
    return coalesce(findAssociation(byId, targetId), findAssociation(scene, targetId))
  nil

proc resolveBindings(specs, slots, built: JsonNode;
    byRef: AssociationStore; existing: JsonNode; warnings: var seq[string];
    now: int64): seq[JsonNode] =
  if not existing.isArr:
    raise newException(ValueError, "existing is not iterable")
  var byId: AssociationStore
  for element in built:
    setAssociation(byId, element.field("id"), element)

  var scene: AssociationStore
  for element in existing:
    let id = element.field("id")
    if jsTruthy(id) and not jsTruthy(element.field("isDeleted")) and
        findAssociation(byId, id).isNil:
      setAssociation(scene, id, element)

  var updated: AssociationStore
  if specs.isArr:
    for specIndex in 0 ..< specs.len:
      let spec = specs[specIndex]
      let element = arrayValue(slots, specIndex)
      if element.isNil or spec.field("type").stringOr("") != "arrow": continue
      for binding in [("start", "startBinding"), ("end", "endBinding")]:
        let key = binding[0]
        let bindKey = binding[1]
        let targetSpec = spec.field(key)
        if not jsTruthy(targetSpec): continue
        let target = findTarget(byRef, byId, scene, targetSpec)
        if target.isNil:
          warnings.add("arrow " & key & " target not found: " & jsJson(targetSpec))
          continue
        element[bindKey] = %*{"elementId": target.field("id"), "focus": 0, "gap": 4}
        let entry = %*{"id": element.field("id"), "type": "arrow"}
        if not findAssociation(byId, target.field("id")).isNil:
          withReverseEntry(target, entry)
        else:
          let current = coalesce(findAssociation(updated, target.field("id")), target)
          var boundElements = newJArray()
          for value in spreadValues(current.field("boundElements")):
            boundElements.add(value)
          boundElements.add(entry)
          let patched = patchElement(current, %*{"boundElements": boundElements}, now)
          setAssociation(updated, target.field("id"), patched)

  for association in updated.ordered: result.add(association.value)

proc buildElements*(rawSpecs, existing: JsonNode; ink = "#1e1e1e"; now: int64): JsonNode =
  let scene = if existing.isNil: newJArray() else: existing
  if not scene.isArr:
    raise newException(ValueError, "existing is not iterable")
  var warnings: seq[string]
  let specs = expandSpecs(rawSpecs, warnings)
  let nextIndex = indexFactory(scene)
  var built = newJArray()
  var slots = newJArray()
  var byRef: AssociationStore

  if specs.isArr:
    for spec in specs:
      if not spec.isObj or spec.field("type").isNil or
          spec.field("type").kind != JString:
        warnings.add("skipped an entry with no \"type\" field - every element is " &
          "{\"type\": \"path\" | \"rectangle\" | ..., ...fields}: " &
          warningSlice(spec))
        slots.add(newJNull())
        continue

      let kind = spec["type"].getStr
      if kind notin SugaredTypes:
        warnings.add("\"" & kind & "\" passed through without shape-specific defaults")

      let element = base(spec, nextIndex(), ink, now)
      if kind == "text":
        let fields = textFields(spec, nil)
        let measured = fields["measured"]
        for key, value in fields:
          if key == "measured": continue
          if key == "text" or key == "originalText":
            element[key] = %value.getStr
          elif spec.field(key).isNil:
            element[key] = copyNode(value)
        if spec.field("width").isNil: element["width"] = copyNode(measured["width"])
        if spec.field("height").isNil: element["height"] = copyNode(measured["height"])

      if kind in LinearTypes or kind == "freedraw":
        let normalised = normalisePoints(spec)
        element["points"] = normalised.points
        element["x"] = numberNode(floatOr(element.field("x"), 0.0) + normalised.dx)
        element["y"] = numberNode(floatOr(element.field("y"), 0.0) + normalised.dy)
        let bounds = pointBounds(normalised.points)
        if spec.field("width").isNil:
          element["width"] = numberNode(bounds.maxX - bounds.minX)
        if spec.field("height").isNil:
          element["height"] = numberNode(bounds.maxY - bounds.minY)
        if element.field("lastCommittedPoint").isNil:
          element["lastCommittedPoint"] =
            if kind == "freedraw": copyNode(normalised.points[^1])
            else: newJNull()
        if kind in LinearTypes:
          setDefault(element, "startBinding", newJNull())
          setDefault(element, "endBinding", newJNull())
          setDefault(element, "startArrowhead", newJNull())
          setDefault(element, "endArrowhead",
            if kind == "arrow": %"arrow" else: newJNull())
          setDefault(element, "elbowed", newJBool(false))
        else:
          setDefault(element, "pressures", newJArray())
          setDefault(element, "simulatePressure", newJBool(true))

      let label = spec.field("label")
      let hasLabel = not isNullish(label) and labelText(label).len > 0
      if kind == "frame":
        if element.field("name").isNil:
          element["name"] =
            if hasLabel:
              %(if label.kind in {JObject, JArray}: jsString(label.field("text"))
                else: jsString(label))
            else: newJNull()
        elif hasLabel:
          warnings.add("frame already has a name; its label was ignored")
      elif hasLabel and kind notin ShapeTypes:
        warnings.add("label on a " & kind & " was ignored: only rectangle, ellipse " &
          "and diamond take a label (a frame's label becomes its name). " &
          "Add a separate text element instead.")

      slots.add(element)
      built.add(element)
      let specRef = spec.field("ref")
      if jsTruthy(specRef): setAssociation(byRef, specRef, element)

      if kind in ShapeTypes and hasLabel:
        let objectLike = label.kind in {JObject, JArray}
        var labelSpec = newJObject()
        if not spec.field("fontSize").isNil:
          labelSpec["fontSize"] = copyNode(spec["fontSize"])
        if not spec.field("fontFamily").isNil:
          labelSpec["fontFamily"] = copyNode(spec["fontFamily"])
        if objectLike:
          for key, value in label: labelSpec[key] = copyNode(value)
        else:
          labelSpec["text"] = %jsString(label)

        let fields = textFields(labelSpec, element)
        let measured = fields["measured"]
        let needed = containerHeightFor(kind, floatOr(measured["height"], 0.0))
        if needed > jsToNumber(element.field("height")):
          element["height"] = numberNode(needed)

        labelSpec["type"] = %"text"
        labelSpec["strokeColor"] = coalesce(labelSpec.field("strokeColor"),
          coalesce(spec.field("strokeColor"), %ink))
        labelSpec["opacity"] =
          if spec.field("opacity").isNil: newJInt(100)
          else: copyNode(spec["opacity"])
        labelSpec["roundness"] = newJNull()
        labelSpec["x"] = jsAddNumber(element.field("x"),
          (jsToNumber(element.field("width")) - floatOr(measured["width"], 0.0)) / 2.0)
        labelSpec["y"] = jsAddNumber(element.field("y"),
          (jsToNumber(element.field("height")) - floatOr(measured["height"], 0.0)) / 2.0)
        labelSpec["width"] = copyNode(measured["width"])
        labelSpec["height"] = copyNode(measured["height"])
        for key, value in fields:
          if key == "measured": continue
          if key == "text" or key == "originalText":
            labelSpec[key] = %value.getStr
          else:
            labelSpec[key] = copyNode(value)

        let text = base(labelSpec, nextIndex(), ink, now)
        withReverseEntry(element, %*{"id": text.field("id"), "type": "text"})
        built.add(text)

  let updated = resolveBindings(specs, slots, built, byRef, scene, warnings, now)
  var warningArray = newJArray()
  for warning in warnings: warningArray.add(%warning)
  var updatedArray = newJArray()
  for element in updated: updatedArray.add(element)
  %*{"elements": built, "warnings": warningArray, "updated": updatedArray}

proc patchElement(element, patch: JsonNode; now: int64): JsonNode =
  if patch.isNil or patch.kind == JNull:
    raise newException(ValueError, "patch must be an object")
  result = copyNode(element)
  if result.isNil or not result.isObj: result = newJObject()
  if patch.isObj:
    for key, value in patch:
      if key == "id": continue
      if key == "index" and not validIndex(value): continue
      if key == "wrap": continue
      result[key] = copyNode(value)

  var retext = false
  for key in ["text", "fontSize", "fontFamily", "width", "wrap"]:
    if patch.hasField(key):
      retext = true
      break
  if element.field("type").stringOr("") == "text" and retext:
    let original = nullishString(coalesce(patch.field("text"),
      coalesce(element.field("originalText"), element.field("text"))))
    let fontSize = jsToNumber(coalesce(result.field("fontSize"), %DEFAULT_FONT_SIZE))
    let fontFamily = metricFontFamily(result.field("fontFamily"))

    let patchWrap = patch.field("wrap")
    var wrapWidth: JsonNode = nil
    if patchWrap.isNumber:
      wrapWidth = copyNode(patchWrap)
    elif isFalse(element.field("autoResize")) or jsTruthy(element.field("containerId")):
      wrapWidth = coalesce(patch.field("width"), element.field("width"))

    let text =
      if jsTruthy(wrapWidth): wrapText(original, jsToNumber(wrapWidth), fontSize, fontFamily)
      else: original
    let measured = measureText(text, fontSize, fontFamily)
    result["text"] = %text
    result["originalText"] = %original
    if not patch.hasField("width") and not jsTruthy(wrapWidth):
      result["width"] = numberNode(measured.width)
    if not patch.hasField("height"):
      result["height"] = numberNode(measured.height)

  result["version"] = jsAddValues(coalesce(element.field("version"), %1), %1)
  result["versionNonce"] = %nonce()
  result["updated"] = newJInt(now)

proc growContainerFor*(text, container: JsonNode; now: int64): JsonNode =
  if not jsTruthy(text) or not jsTruthy(container): return container
  if not jsStrictEqual(text.field("containerId"), container.field("id")): return container
  let needed = containerHeightFor(container.field("type").stringOr(""),
    jsToNumber(coalesce(text.field("height"), %0.0)))
  if not (needed > jsToNumber(coalesce(container.field("height"), %0.0))):
    return container
  patchElement(container, %*{"height": numberNode(needed)}, now)
