import std/[algorithm, json, math, strutils, tables, unicode]
import ../core/jsvalue

type
  Severity = enum
    sevError, sevWarning, sevInfo
  Box = object
    x, y, right, bottom: float
  Finding = object
    severity: Severity
    kind, message: string
    ids: JsonNode
  SceneEntry = object
    element: JsonNode
    id: string

proc parseJsNumberString(value: string): float =
  let text = value.strip()
  if text.len == 0: return 0.0
  case text
  of "Infinity", "+Infinity": return Inf
  of "-Infinity": return NegInf
  of "NaN": return NaN
  else: discard

  if text.startsWith("0x") or text.startsWith("0X"):
    if text.len == 2: return NaN
    var number = 0.0
    for ch in text[2 .. ^1].toLowerAscii:
      let digit =
        if ch in {'0' .. '9'}: int(ch) - int('0')
        elif ch in {'a' .. 'f'}: int(ch) - int('a') + 10
        else: return NaN
      number = number * 16.0 + float(digit)
    return number

  for (prefix, radix) in [("0b", 2.0), ("0o", 8.0)]:
    if text.startsWith(prefix) or text.startsWith(prefix.toUpperAscii):
      if text.len == 2: return NaN
      var number = 0.0
      for ch in text[2 .. ^1]:
        let digit =
          if radix == 2.0 and ch in {'0' .. '1'}: int(ch) - int('0')
          elif radix == 8.0 and ch in {'0' .. '7'}: int(ch) - int('0')
          else: return NaN
        number = number * radix + float(digit)
      return number

  var index = 0
  if text[index] in {'+', '-'}: inc index
  var digits = 0
  while index < text.len and text[index] in {'0' .. '9'}:
    inc index
    inc digits
  if index < text.len and text[index] == '.':
    inc index
    while index < text.len and text[index] in {'0' .. '9'}:
      inc index
      inc digits
  if digits == 0: return NaN
  if index < text.len and text[index] in {'e', 'E'}:
    inc index
    if index < text.len and text[index] in {'+', '-'}: inc index
    let exponentStart = index
    while index < text.len and text[index] in {'0' .. '9'}: inc index
    if index == exponentStart: return NaN
  if index != text.len: return NaN
  try: parseFloat(text)
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

proc primitive(value: JsonNode): JsonNode =
  if not value.isNil and value.kind in {JArray, JObject}: %jsString(value)
  else: value

proc addJs(left, right: JsonNode): JsonNode =
  let a = primitive(left)
  let b = primitive(right)
  if a != nil and b != nil and (a.kind == JString or b.kind == JString):
    %(jsString(a) & jsString(b))
  else:
    numberNode(jsToNumber(a) + jsToNumber(b))

proc strictEqual(left, right: JsonNode): bool =
  if left.isNil or right.isNil: return left.isNil and right.isNil
  if left.kind != right.kind:
    return left.isNumber and right.isNumber and jsToNumber(left) == jsToNumber(right)
  case left.kind
  of JInt, JFloat:
    let a = jsToNumber(left)
    let b = jsToNumber(right)
    a.classify != fcNan and b.classify != fcNan and a == b
  of JString: left.getStr == right.getStr
  of JBool: left.getBool == right.getBool
  of JNull: true
  of JArray, JObject: cast[pointer](left) == cast[pointer](right)

proc fieldNumber(element: JsonNode; key: string; fallback = 0.0): float =
  let value = element.field(key)
  if value.isNil or value.kind == JNull: return fallback
  jsToNumber(value)

proc boxOf(element: JsonNode): Box =
  let x = element.field("x")
  let y = element.field("y")
  let width = element.field("width")
  let height = element.field("height")
  let widthValue = if width.isNil or width.kind == JNull: newJInt(0) else: width
  let heightValue = if height.isNil or height.kind == JNull: newJInt(0) else: height
  Box(
    x: jsToNumber(x),
    y: jsToNumber(y),
    right: jsToNumber(addJs(x, widthValue)),
    bottom: jsToNumber(addJs(y, heightValue))
  )

proc overlaps(a, b: Box): bool =
  a.x < b.right and a.right > b.x and a.y < b.bottom and a.bottom > b.y

proc areaOf(element: JsonNode): float =
  abs(fieldNumber(element, "width") * fieldNumber(element, "height"))

proc roundText(value: JsonNode): string =
  jsNumberString(jsRound(jsToNumber(value)))

proc roundNumber(value: float): string =
  jsNumberString(jsRound(value))

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
        (uint32(units[index + 1]) - 0xdc00)
      result.add(toUTF8(Rune(0x10000 + offset)))
      index += 2
    else:
      result.add(toUTF8(Rune(code)))
      index += 1

proc messageSlice(element: JsonNode; length: int): string =
  utf16Slice(element.field("text").stringOr(""), length)

proc segmentsCross(a, b: tuple[x, y: float]; box: Box): bool =
  proc cross(ax, ay, bx, by, cx, cy, dx, dy: float): bool =
    let denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx)
    if denominator == 0.0: return false
    let t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator
    let u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator
    t >= 0.0 and t <= 1.0 and u >= 0.0 and u <= 1.0

  let edges =
    (if cross(a.x, a.y, b.x, b.y, box.x, box.y, box.right, box.y): 1 else: 0) +
    (if cross(a.x, a.y, b.x, b.y, box.right, box.y, box.right, box.bottom): 1 else: 0) +
    (if cross(a.x, a.y, b.x, b.y, box.right, box.bottom, box.x, box.bottom): 1 else: 0) +
    (if cross(a.x, a.y, b.x, b.y, box.x, box.bottom, box.x, box.y): 1 else: 0)
  edges >= 2

proc pointOf(element: JsonNode; index: int): tuple[x, y: float] =
  let points = element.field("points")
  let point = if points.isArr and index >= 0 and index < points.len: points[index] else: nil
  let px = if point.isArr and point.len > 0: point[0] else: nil
  let py = if point.isArr and point.len > 1: point[1] else: nil
  (jsToNumber(addJs(element.field("x"), px)),
    jsToNumber(addJs(element.field("y"), py)))

proc concatIds(ids: JsonNode): JsonNode =
  result = newJArray()
  if ids.isNil:
    result.add(newJNull())
  elif ids.isArr:
    for id in ids: result.add(copyNode(id))
  else:
    result.add(copyNode(ids))

proc addFinding(findings: var seq[Finding]; severity: Severity; kind, message: string;
    ids: JsonNode) =
  findings.add(Finding(severity: severity, kind: kind, message: message,
    ids: concatIds(ids)))

proc severityName(severity: Severity): string =
  case severity
  of sevError: "error"
  of sevWarning: "warning"
  of sevInfo: "info"

proc severityRank(severity: Severity): int =
  case severity
  of sevError: 0
  of sevWarning: 1
  of sevInfo: 2

proc stableSeveritySort(findings: var seq[Finding]) =
  for index in 1 ..< findings.len:
    let current = findings[index]
    var target = index
    while target > 0 and severityRank(findings[target - 1].severity) >
        severityRank(current.severity):
      findings[target] = findings[target - 1]
      dec target
    findings[target] = current

proc labelMaxHeight(container: JsonNode): float =
  let height = fieldNumber(container, "height")
  case container.field("type").stringOr("")
  of "diamond": float(jsRoundInt(height / 2.0)) - 10.0
  of "ellipse": float(jsRoundInt((height / 2.0) * sqrt(2.0))) - 10.0
  else: height - 10.0

proc sliceLimit(value: JsonNode; length: int): int =
  let number = jsToNumber(value)
  if number.classify == fcNan: return 0
  if number == Inf: return length
  if number == NegInf: return 0
  let integer = int(number)
  if integer < 0: max(0, length + integer) else: min(length, integer)

proc inspectScene*(elements: JsonNode; options: JsonNode = nil): JsonNode =
  if options != nil and options.kind == JNull:
    raise newException(ValueError, "Cannot read properties of null (reading 'limit')")
  var liveElements = newJArray()
  if not elements.isNil and elements.kind != JNull:
    if not elements.isArr:
      raise newException(ValueError, "(elements ?? []).filter is not a function")
    for element in elements:
      if element.isNil or element.kind == JNull:
        raise newException(ValueError, "Cannot read properties of null (reading 'isDeleted')")
      if not jsTruthy(element.field("isDeleted")): liveElements.add(element)

  var entries: seq[SceneEntry]
  var order = initTable[string, int]()
  var byId = initTable[string, int]()
  for index in 0 ..< liveElements.len:
    let element = liveElements[index]
    let id = jsString(element.field("id"))
    entries.add(SceneEntry(element: element, id: id))
    order[id] = index
    byId[id] = index

  var findings: seq[Finding]
  var opaque: seq[int]
  for index, entry in entries:
    let element = entry.element
    if element.field("type").stringOr("") in
        ["rectangle", "ellipse", "diamond", "line", "freedraw"] and
        jsTruthy(element.field("backgroundColor")) and
        element.field("backgroundColor").stringOr("") != "transparent" and
        fieldNumber(element, "opacity", 100.0) > 60.0:
      opaque.add(index)

  for textIndex, entry in entries:
    let textElement = entry.element
    if textElement.field("type").stringOr("") != "text": continue
    let textBox = boxOf(textElement)
    for shapeIndex in opaque:
      let shape = entries[shapeIndex]
      if strictEqual(shape.element.field("id"),
          textElement.field("containerId")): continue
      if order[shape.id] < order[entry.id]: continue
      let shapeBox = boxOf(shape.element)
      if not overlaps(textBox, shapeBox): continue
      let hidden = min(textBox.right, shapeBox.right) - max(textBox.x, shapeBox.x)
      if hidden > 2.0:
        addFinding(findings, sevError, "text-hidden",
          "\"" & messageSlice(textElement, 40) & "\" is covered for ~" &
          roundNumber(hidden) & "px by a filled " &
          shape.element.field("type").stringOr("") &
          " drawn after it. Move the text, shrink the shape, or draw the shape first.",
          %*[textElement.field("id"), shape.element.field("id")])
        break

  const WidthSlack = 1.08
  const Padding = 8.0
  var panels: seq[int]
  for index in opaque:
    let element = entries[index].element
    if element.field("type").stringOr("") == "rectangle" and
        areaOf(element) > 20000.0:
      panels.add(index)

  for entry in entries:
    let textElement = entry.element
    if textElement.field("type").stringOr("") != "text" or
        jsTruthy(textElement.field("containerId")): continue
    let textBox = boxOf(textElement)
    var candidates: seq[int]
    for panelIndex in panels:
      let panelBox = boxOf(entries[panelIndex].element)
      if textBox.x >= panelBox.x - 2.0 and textBox.x <= panelBox.right and
          textBox.y >= panelBox.y - 2.0 and textBox.y <= panelBox.bottom:
        candidates.add(panelIndex)
    if candidates.len == 0: continue
    algorithm.sort(candidates, proc(a, b: int): int =
      cmp(areaOf(entries[a].element), areaOf(entries[b].element))
    )
    let host = entries[candidates[0]]
    let hostBox = boxOf(host.element)
    let right = textBox.x + fieldNumber(textElement, "width") * WidthSlack - hostBox.right
    let bottom = textBox.bottom - hostBox.bottom
    let left = hostBox.x - textBox.x
    let top = hostBox.y - textBox.y
    let escaped = max(right, max(bottom, max(left, top)))
    if escaped > 2.0:
      let edge = if escaped == right: "right" elif escaped == bottom: "bottom"
        elif escaped == left: "left" else: "top"
      addFinding(findings, sevWarning, "text-escapes-panel",
        "\"" & messageSlice(textElement, 40) & "\" runs " & roundNumber(escaped) &
        "px past the " & edge &
        " edge of the panel it sits in. Shorten it, reduce fontSize, or set a width so it wraps.",
        %*[textElement.field("id"), host.element.field("id")])
    elif escaped > -Padding:
      addFinding(findings, sevInfo, "text-tight",
        "\"" & messageSlice(textElement, 40) & "\" sits " &
        roundNumber(-escaped) &
        "px from the panel edge. Under 8px reads as a mistake rather than a margin.",
        %*[textElement.field("id"), host.element.field("id")])

  var texts: seq[int]
  for index, entry in entries:
    if entry.element.field("type").stringOr("") == "text" and
        not jsTruthy(entry.element.field("containerId")):
      texts.add(index)

  for first in 0 ..< texts.len:
    let a = boxOf(entries[texts[first]].element)
    for second in first + 1 ..< texts.len:
      let b = boxOf(entries[texts[second]].element)
      if not overlaps(a, b): continue
      let width = min(a.right, b.right) - max(a.x, b.x)
      let height = min(a.bottom, b.bottom) - max(a.y, b.y)
      if width > 3.0 and height > 3.0:
        let firstElement = entries[texts[first]].element
        let secondElement = entries[texts[second]].element
        addFinding(findings, sevError, "text-collision",
          "\"" & messageSlice(firstElement, 28) & "\" and \"" &
          messageSlice(secondElement, 28) & "\" overlap by " & roundNumber(width) &
          "x" & roundNumber(height) & "px. Move one.",
          %*[firstElement.field("id"), secondElement.field("id")])

  var strokes: seq[int]
  for index, entry in entries:
    let element = entry.element
    let points = element.field("points")
    let background = element.field("backgroundColor")
    if element.field("type").stringOr("") in ["line", "arrow"] and
        points.isArr and points.len > 1 and points.len <= 8 and
        (not jsTruthy(background) or background.stringOr("") == "transparent"):
      strokes.add(index)

  for textIndex in texts:
    let textElement = entries[textIndex].element
    let textBox = boxOf(textElement)
    for strokeIndex in strokes:
      let stroke = entries[strokeIndex].element
      let points = stroke.field("points")
      var hit = false
      for pointIndex in 1 ..< points.len:
        let a = pointOf(stroke, pointIndex - 1)
        let b = pointOf(stroke, pointIndex)
        if segmentsCross(a, b, textBox):
          hit = true
          break
      if hit:
        let long = max(fieldNumber(stroke, "width"),
          fieldNumber(stroke, "height")) > 400.0
        let message =
          if long:
            "\"" & messageSlice(textElement, 32) &
            "\" sits on top of a full-length rule (" &
            roundText(stroke.field("width")) & "x" &
            roundText(stroke.field("height")) &
            "). Move the label clear of the frame or divider, or break the rule around it."
          else:
            "A " & stroke.field("type").stringOr("") & " runs through \"" &
            messageSlice(textElement, 32) &
            "\". Stop the leader at the edge of the label instead of crossing it."
        addFinding(findings, sevWarning, "line-through-text", message,
          %*[textElement.field("id"), stroke.field("id")])
        break

  for entry in entries:
    let textElement = entry.element
    if textElement.field("type").stringOr("") != "text" or
        not jsTruthy(textElement.field("containerId")): continue
    let containerId = jsString(textElement.field("containerId"))
    if not byId.hasKey(containerId):
      addFinding(findings, sevError, "orphan-label",
        "A bound label points at a container that is not in the scene.",
        textElement.field("id"))
      continue
    let container = entries[byId[containerId]].element
    if container.field("type").stringOr("") in ["arrow", "line"]: continue
    if fieldNumber(textElement, "height") > labelMaxHeight(container) + 4.0:
      addFinding(findings, sevWarning, "label-too-tall",
        "The label on this " & container.field("type").stringOr("") & " needs " &
        roundText(textElement.field("height")) & "px but the container is " &
        roundText(container.field("height")) &
        "px. Excalidraw clips it - make the container taller.",
        %*[textElement.field("id"), container.field("id")])

  for entry in entries:
    let element = entry.element
    if element.field("type").stringOr("") == "text": continue
    let width = abs(fieldNumber(element, "width"))
    let height = abs(fieldNumber(element, "height"))
    if width < 1.0 and height < 1.0:
      addFinding(findings, sevWarning, "zero-size",
        "A " & element.field("type").stringOr("") & " has no size (" &
        roundNumber(width) & "x" & roundNumber(height) &
        ") and will not be visible.", element.field("id"))

  for entry in entries:
    let element = entry.element
    if element.field("type").stringOr("") != "arrow": continue
    for key in ["startBinding", "endBinding"]:
      let binding = element.field(key)
      let target = binding.field("elementId")
      if jsTruthy(target) and not byId.hasKey(jsString(target)):
        addFinding(findings, sevError, "dangling-binding",
          "An arrow's " & key &
          " points at an element that no longer exists.", element.field("id"))

  if entries.len > 6:
    var centersX, centersY: seq[float]
    for entry in entries:
      let element = entry.element
      centersX.add(fieldNumber(element, "x") + fieldNumber(element, "width") / 2.0)
      centersY.add(fieldNumber(element, "y") + fieldNumber(element, "height") / 2.0)
    centersX.sort()
    centersY.sort()
    let x1 = centersX[int(float(centersX.len) * 0.25)]
    let x3 = centersX[int(float(centersX.len) * 0.75)]
    let y1 = centersY[int(float(centersY.len) * 0.25)]
    let y3 = centersY[int(float(centersY.len) * 0.75)]
    let padX = max(600.0, (x3 - x1) * 3.0)
    let padY = max(600.0, (y3 - y1) * 3.0)
    for entry in entries:
      let element = entry.element
      let centerX = fieldNumber(element, "x") + fieldNumber(element, "width") / 2.0
      let centerY = fieldNumber(element, "y") + fieldNumber(element, "height") / 2.0
      if centerX < x1 - padX or centerX > x3 + padX or
          centerY < y1 - padY or centerY > y3 + padY:
        addFinding(findings, sevWarning, "stray",
          "A " & element.field("type").stringOr("") &
          " sits far away from everything else, at " &
          roundText(element.field("x")) & "," & roundText(element.field("y")) & ".",
          element.field("id"))

  var seen = initTable[string, JsonNode]()
  for entry in entries:
    let element = entry.element
    let points = element.field("points")
    var endpoint = ""
    if points.isArr and points.len > 0:
      let point = points[^1]
      var coordinates: seq[string]
      if point.isArr:
        for coordinate in point:
          coordinates.add(roundNumber(jsToNumber(coordinate)))
      endpoint = coordinates.join(",")
    let key = @[
      element.field("type").stringOr(""),
      roundNumber(fieldNumber(element, "x")),
      roundNumber(fieldNumber(element, "y")),
      roundNumber(fieldNumber(element, "width")),
      roundNumber(fieldNumber(element, "height")),
      endpoint,
      element.field("text").stringOr("")
    ].join("|")
    if seen.hasKey(key) and jsTruthy(seen[key]):
      addFinding(findings, sevWarning, "duplicate",
        "Two " & element.field("type").stringOr("") &
        " elements sit exactly on top of each other.",
        %*[seen[key], element.field("id")])
    else:
      seen[key] = copyNode(element.field("id"))

  stableSeveritySort(findings)

  var counts = initTable[string, int]()
  for finding in findings:
    counts[finding.kind] = counts.getOrDefault(finding.kind, 0) + 1

  const PerKind = 6
  var kindTally = initTable[string, int]()
  var shown: seq[Finding]
  for finding in findings:
    kindTally[finding.kind] = kindTally.getOrDefault(finding.kind, 0) + 1
    if kindTally[finding.kind] <= PerKind: shown.add(finding)

  let limitValue =
    if options.isNil or not options.hasField("limit"): newJInt(60)
    else: options["limit"]
  let limit = sliceLimit(limitValue, shown.len)

  var countNode = newJObject()
  for kind, count in counts: countNode[kind] = newJInt(count)
  var findingArray = newJArray()
  for index in 0 ..< limit:
    let finding = shown[index]
    findingArray.add(%*{
      "severity": severityName(finding.severity),
      "kind": finding.kind,
      "message": finding.message,
      "ids": finding.ids
    })

  %*{
    "elements": entries.len,
    "problems": findings.len,
    "counts": countNode,
    "truncated": shown.len < findings.len,
    "findings": findingArray
  }
