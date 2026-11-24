import std/[json, math, options, re, sequtils, sets, strutils, tables, unicode]
import ../core/[jsvalue, resample, textmetrics]

const
  IdentityMatrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
  CommandLetters = "MmLlHhVvCcSsQqTtAaZz"

let
  NumberPattern = re"[+-]?(?:[0-9]*\.[0-9]+|[0-9]+\.?)(?:[eE][+-]?[0-9]+)?"
  TransformPattern = re"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)"
  SplitPattern = re"[\s,]+"
  UrlPattern = re"url\(\s*#([^)\s]+)\s*\)"
  RgbPattern = re"rgba?\(([^)]+)\)"
  CssRulePattern = re"([^{}]+)\{([^{}]*)\}"
  SimpleSelectorPattern = re"^[.#]?[A-Za-z0-9_-]+$"

type
  Point = object
    x, y: float
  Matrix = array[6, float]
  XmlNode = ref object
    tag: string
    attrs: Table[string, string]
    children: seq[XmlNode]
    text: string
    viaUse: bool
  Style = object
    fill, stroke, strokeWidth, opacity: Option[string]
    fillOpacity, strokeOpacity, dash: Option[string]
    fontSize, fontFamily, textAnchor, baseline: Option[string]
    display, stopColor: Option[string]
  NativeKind = enum
    nkRectangle, nkEllipse
  DrawableKind = enum
    dkText, dkNative, dkRun
  Drawable = object
    case kind: DrawableKind
    of dkText:
      textValue: string
      at: Point
    of dkNative:
      nativeKind: NativeKind
      cx, cy, rx, ry: float
      rounded: bool
    of dkRun:
      points: seq[Point]
      closed, curved, isHole: bool
    style: Style
    matrix: Matrix
  PathRun = object
    points: seq[Point]
    closed, curved: bool
  SvgOptions = object
    tolerance, step: float
    currentColor, holeColor, roughness, forcedFill: JsonNode
    mode: JsonNode
    x, y, width, height: Option[float]
    widthTruthy: bool
  WarningSink = ref object
    messages: seq[string]

var namedColors = initTable[string, string]()
for entry in [
  ("black", "#000000"), ("white", "#ffffff"), ("red", "#ff0000"),
  ("green", "#008000"), ("blue", "#0000ff"), ("yellow", "#ffff00"),
  ("orange", "#ffa500"), ("purple", "#800080"), ("gray", "#808080"),
  ("grey", "#808080"), ("silver", "#c0c0c0"), ("maroon", "#800000"),
  ("navy", "#000080"), ("teal", "#008080"), ("olive", "#808000"),
  ("lime", "#00ff00"), ("aqua", "#00ffff"), ("cyan", "#00ffff"),
  ("fuchsia", "#ff00ff"), ("magenta", "#ff00ff"), ("pink", "#ffc0cb"),
  ("brown", "#a52a2a"), ("gold", "#ffd700"), ("darkgray", "#a9a9a9"),
  ("darkgrey", "#a9a9a9"), ("lightgray", "#d3d3d3"),
  ("lightgrey", "#d3d3d3"), ("transparent", "transparent"),
  ("none", "transparent")
]:
  namedColors[entry[0]] = entry[1]

proc numberNode(value: float): JsonNode =
  if value.classify in {fcNan, fcInf, fcNegInf}: return newJNull()
  if value == 0.0: return newJInt(0)
  if value == floor(value) and value >= -9_223_372_036_854_775_808.0 and
      value < 9_223_372_036_854_775_808.0:
    return newJInt(int64(value))
  newJFloat(value)

proc jsHypot2(x, y: float): float =
  let ax = abs(x)
  let ay = abs(y)
  if ax.classify == fcNan or ay.classify == fcNan: return NaN
  let maximum = max(ax, ay)
  if maximum == Inf: return Inf
  if maximum == 0.0: return 0.0
  var sum = 0.0
  var compensation = 0.0
  for value in [ax / maximum, ay / maximum]:
    let square = value * value
    let summand = square - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  sqrt(sum) * maximum

proc pointNode(point: Point): JsonNode =
  result = newJArray()
  result.add(numberNode(point.x))
  result.add(numberNode(point.y))

proc sampleCount(value: float; minimum, maximum: int): int

proc typedBounds(points: seq[Point]): tuple[minX, minY, maxX, maxY: float] =
  result = (minX: Inf, minY: Inf, maxX: -Inf, maxY: -Inf)
  for point in points:
    if point.x < result.minX: result.minX = point.x
    if point.x > result.maxX: result.maxX = point.x
    if point.y < result.minY: result.minY = point.y
    if point.y > result.maxY: result.maxY = point.y
  if result.minX == Inf: result = (0.0, 0.0, 0.0, 0.0)

proc nativeGeometry(shape: Drawable; tolerance: float): seq[Point] =
  if shape.kind != dkNative: return @[]
  if shape.nativeKind == nkRectangle:
    return @[
      Point(x: shape.cx - shape.rx, y: shape.cy - shape.ry),
      Point(x: shape.cx + shape.rx, y: shape.cy - shape.ry),
      Point(x: shape.cx + shape.rx, y: shape.cy + shape.ry),
      Point(x: shape.cx - shape.rx, y: shape.cy + shape.ry),
      Point(x: shape.cx - shape.rx, y: shape.cy - shape.ry)
    ]
  let steps = sampleCount(max(shape.rx, shape.ry) * 2.0 * math.PI / tolerance, 12, 96)
  for index in 0 .. steps:
    let angle = float(index) / float(steps) * math.PI * 2.0
    result.add(Point(x: shape.cx + cos(angle) * shape.rx,
      y: shape.cy + sin(angle) * shape.ry))

proc finitePoint(point: Point): bool =
  point.x.classify notin {fcNan, fcInf, fcNegInf} and
    point.y.classify notin {fcNan, fcInf, fcNegInf}

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

proc parseFloatPrefix(value: string): float =
  let text = value.strip()
  let prefix = re"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
  let bounds = findBounds(text, prefix)
  if bounds.first < 0: return NaN
  parseJsNumberString(text[bounds.first .. bounds.last])

proc num(value: Option[string]; fallback = 0.0): float =
  if value.isNone: return fallback
  let parsed = parseFloatPrefix(value.get)
  if parsed.classify in {fcNan, fcInf, fcNegInf}: fallback else: parsed

proc nullish(value: JsonNode): bool =
  value.isNil or value.kind == JNull

proc optionNumber(value: JsonNode; fallback: float): float =
  if value.isNil: return fallback
  jsToNumber(value)

proc parseOptions(options: JsonNode): SvgOptions =
  let source = if options.isNil or options.kind == JNull: newJObject() else: options
  let mode =
    if source.hasField("style"): copyNode(source["style"])
    else: %"sketch"
  let precise = mode.kind == JString and mode.getStr == "precise"
  result.tolerance = optionNumber(source.field("tolerance"), 3.0)
  result.step = optionNumber(source.field("step"), 18.0)
  result.currentColor =
    if source.hasField("currentColor"): copyNode(source["currentColor"])
    else: %"#1e1e1e"
  result.holeColor =
    if source.hasField("holeColor"): copyNode(source["holeColor"])
    else: newJNull()
  result.roughness =
    if source.hasField("roughness"): copyNode(source["roughness"])
    elif precise: newJInt(0)
    else: newJInt(1)
  result.forcedFill =
    if source.hasField("fillStyle"): copyNode(source["fillStyle"])
    else: newJNull()
  result.mode = mode
  result.widthTruthy = jsTruthy(source.field("width"))
  for key in ["x", "y", "width", "height"]:
    let value = source.field(key)
    if not nullish(value):
      let parsed = jsToNumber(value)
      case key
      of "x": result.x = some(parsed)
      of "y": result.y = some(parsed)
      of "width": result.width = some(parsed)
      else: result.height = some(parsed)

proc parseXml(source: string): XmlNode =
  var clean = source
    .replace(re"<!--[\s\S]*?-->", "")
    .replacef(re"<!\[CDATA\[([\s\S]*?)\]\]>", "$1")
    .replace(re"<\?[\s\S]*?\?>", "")
    .replace(re"(?i)<!DOCTYPE[^>]*>", "")

  let root = XmlNode(tag: "#root", attrs: initTable[string, string](),
    children: @[])
  var stack = @[root]
  let tagPattern = re"<\s*(\/?)([A-Za-z_][A-Za-z0-9_:.-]*)((?:\s+[^<>]*?)?)(\/?)\s*>|([^<]+)"
  let attrPattern = re"""([A-Za-z0-9_:.-]+)\s*=\s*("([^"]*)"|'([^']*)')"""
  var position = 0
  while true:
    var captures: array[5, string]
    let bounds = findBounds(clean, tagPattern, captures, position)
    if bounds.first < 0: break
    position = bounds.last + 1
    if captures[4].len > 0:
      let value = captures[4].strip()
      if value.len > 0:
        stack[^1].children.add(XmlNode(tag: "#text", attrs: initTable[string, string](),
          children: @[], text: value))
      continue
    if captures[0].len > 0:
      if stack.len > 1: stack.setLen(stack.len - 1)
      continue

    var attrs = initTable[string, string]()
    var attrPosition = 0
    while true:
      var attrCaptures: array[4, string]
      let attrBounds = findBounds(captures[2], attrPattern, attrCaptures, attrPosition)
      if attrBounds.first < 0: break
      attrPosition = attrBounds.last + 1
      attrs[attrCaptures[0]] =
        if attrCaptures[2].len > 0: attrCaptures[2]
        elif attrCaptures[3].len > 0: attrCaptures[3]
        else: ""
    let node = XmlNode(tag: captures[1].toLowerAscii, attrs: attrs, children: @[])
    stack[^1].children.add(node)
    if captures[3].len == 0: stack.add(node)

  root

proc findSvg(node: XmlNode): XmlNode =
  if node.tag == "svg": return node
  for child in node.children:
    let found = findSvg(child)
    if found != nil: return found
  nil

proc multiply(a, b: Matrix): Matrix =
  [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ]

proc applyMatrix(matrix: Matrix; point: Point): Point =
  Point(
    x: matrix[0] * point.x + matrix[2] * point.y + matrix[4],
    y: matrix[1] * point.x + matrix[3] * point.y + matrix[5]
  )

proc transformNumber(values: seq[string]; index: int): float =
  if index < 0 or index >= values.len: NaN
  else: parseJsNumberString(values[index])

proc parseTransform(value: Option[string]): Matrix =
  if value.isNone or value.get.len == 0: return IdentityMatrix
  var matrix = IdentityMatrix
  var position = 0
  while true:
    var captures: array[2, string]
    let bounds = findBounds(value.get, TransformPattern, captures, position)
    if bounds.first < 0: break
    position = bounds.last + 1
    let values = captures[1].split(SplitPattern).filterIt(it.len > 0)
    var step = IdentityMatrix
    case captures[0]
    of "matrix":
      if values.len >= 6:
        for index in 0 ..< 6: step[index] = parseJsNumberString(values[index])
    of "translate":
      let x = transformNumber(values, 0)
      let y = transformNumber(values, 1)
      step = [1.0, 0.0, 0.0, 1.0,
        (if x.classify == fcNan or x == 0.0: 0.0 else: x),
        (if y.classify == fcNan or y == 0.0: 0.0 else: y)]
    of "scale":
      let x =
        if values.len > 0: parseJsNumberString(values[0])
        else: 1.0
      let y =
        if values.len > 1: parseJsNumberString(values[1])
        else: x
      step = [x, 0.0, 0.0, y, 0.0, 0.0]
    of "rotate":
      let angle = transformNumber(values, 0)
      let centerX =
        if values.len > 1: transformNumber(values, 1)
        else: 0.0
      let centerY =
        if values.len > 2: transformNumber(values, 2)
        else: 0.0
      let radians = angle * math.PI / 180.0
      let cosine = cos(radians)
      let sine = sin(radians)
      step = multiply([1.0, 0.0, 0.0, 1.0, centerX, centerY],
        multiply([cosine, sine, -sine, cosine, 0.0, 0.0],
          [1.0, 0.0, 0.0, 1.0, -centerX, -centerY]))
    of "skewX":
      let angle = transformNumber(values, 0)
      let safeAngle =
        if angle.classify == fcNan or angle == 0.0: 0.0
        else: angle
      step = [1.0, 0.0, tan(safeAngle * math.PI / 180.0), 1.0, 0.0, 0.0]
    of "skewY":
      let angle = transformNumber(values, 0)
      let safeAngle =
        if angle.classify == fcNan or angle == 0.0: 0.0
        else: angle
      step = [1.0, tan(safeAngle * math.PI / 180.0), 0.0, 1.0, 0.0, 0.0]
    else: discard
    matrix = multiply(matrix, step)
  matrix

proc colorToHex(value: Option[string]): JsonNode =
  if value.isNone: return newJNull()
  let text = value.get.strip().toLowerAscii()
  if text.len == 0 or text == "none" or text == "transparent":
    return %"transparent"
  if namedColors.hasKey(text): return %namedColors[text]
  if text.startsWith("#"):
    let hex = text[1 .. ^1]
    if hex.len == 3:
      return %("#" & hex[0] & hex[0] & hex[1] & hex[1] & hex[2] & hex[2])
    if hex.len == 6 or hex.len == 8: return %("#" & hex[0 ..< 6])
    return newJNull()
  var captures: array[1, string]
  let bounds = findBounds(text, RgbPattern, captures)
  if bounds.first >= 0:
    let parts = captures[0].split(re"[\s,/]+").filterIt(it.len > 0)
    if parts.len < 3:
      raise newException(ValueError, "Cannot read properties of undefined (reading 'endsWith')")
    const digits = "0123456789abcdef"
    var hex = "#"
    for index in 0 ..< 3:
      let raw = if index < parts.len: parts[index] else: ""
      let parsed = parseFloatPrefix(raw)
      let scaled = if raw.endsWith("%"): parsed / 100.0 * 255.0 else: parsed
      let safe = if scaled.classify == fcNan or scaled == 0.0: 0.0 else: scaled
      let channel = jsRoundInt(max(0.0, min(255.0, safe)))
      hex.add(digits[channel shr 4])
      hex.add(digits[channel and 15])
    return %hex
  newJNull()

proc mergeDeclarations(target: var Table[string, string]; source: Table[string, string]) =
  for key, value in source: target[key] = value

proc parseCss(source: string): Table[string, Table[string, string]] =
  let body = source
    .replace(re"@[^{]+\{[\s\S]*?\}\s*\}", "")
    .replace(re"/\*[\s\S]*?\*/", "")
  result = initTable[string, Table[string, string]]()
  var position = 0
  while true:
    var captures: array[2, string]
    let bounds = findBounds(body, CssRulePattern, captures, position)
    if bounds.first < 0: break
    position = bounds.last + 1
    var declarations = initTable[string, string]()
    for pair in captures[1].split(';'):
      let parts = pair.split(':')
      if parts.len >= 2 and parts[0].strip().len > 0 and parts[1].strip().len > 0:
        declarations[parts[0].strip().toLowerAscii()] = parts[1].strip()
    for selector in captures[0].split(','):
      let key = selector.strip()
      if matchLen(key, SimpleSelectorPattern) >= 0:
        var merged = initTable[string, string]()
        if result.hasKey(key): merged = result[key]
        mergeDeclarations(merged, declarations)
        result[key] = merged

proc readStyle(attrs: Table[string, string]; tag: string;
    css: Table[string, Table[string, string]]): Style =
  var merged = attrs
  var selectors = @[tag]
  if attrs.hasKey("class"):
    for className in attrs["class"].split(SplitPattern).filterIt(it.len > 0):
      selectors.add("." & className)
  if attrs.hasKey("id") and attrs["id"].len > 0: selectors.add("#" & attrs["id"])
  for selector in selectors:
    if css.hasKey(selector): mergeDeclarations(merged, css[selector])
  if attrs.hasKey("style"):
    for pair in attrs["style"].split(';'):
      let parts = pair.split(':')
      if parts.len >= 2 and parts[0].strip().len > 0 and parts[1].strip().len > 0:
        merged[parts[0].strip().toLowerAscii()] = parts[1].strip()

  proc get(key: string): Option[string] =
    if merged.hasKey(key): some(merged[key]) else: none(string)

  result.fill = get("fill")
  result.stroke = get("stroke")
  result.strokeWidth = get("stroke-width")
  result.opacity = get("opacity")
  result.fillOpacity = get("fill-opacity")
  result.strokeOpacity = get("stroke-opacity")
  result.dash = get("stroke-dasharray")
  result.fontSize = get("font-size")
  result.fontFamily = get("font-family")
  result.textAnchor = get("text-anchor")
  result.baseline = get("dominant-baseline")
  if result.baseline.isNone: result.baseline = get("alignment-baseline")
  result.display = get("display")
  result.stopColor = get("stop-color")

proc inheritStyle(parent: Style; child: Style): Style =
  result = parent
  if child.fill.isSome: result.fill = child.fill
  if child.stroke.isSome: result.stroke = child.stroke
  if child.strokeWidth.isSome: result.strokeWidth = child.strokeWidth
  if child.opacity.isSome: result.opacity = child.opacity
  if child.fillOpacity.isSome: result.fillOpacity = child.fillOpacity
  if child.strokeOpacity.isSome: result.strokeOpacity = child.strokeOpacity
  if child.dash.isSome: result.dash = child.dash
  if child.fontSize.isSome: result.fontSize = child.fontSize
  if child.fontFamily.isSome: result.fontFamily = child.fontFamily
  if child.textAnchor.isSome: result.textAnchor = child.textAnchor
  if child.baseline.isSome: result.baseline = child.baseline
  if child.display.isSome: result.display = child.display
  if child.stopColor.isSome: result.stopColor = child.stopColor

proc indexNode(node: XmlNode; css: var Table[string, Table[string, string]];
    byId: var Table[string, XmlNode]) =
  for child in node.children:
    if child.tag == "style":
      var text: seq[string]
      for part in child.children:
        if part.tag == "#text": text.add(part.text)
      for selector, declarations in parseCss(text.join("")):
        var merged = initTable[string, string]()
        if css.hasKey(selector): merged = css[selector]
        mergeDeclarations(merged, declarations)
        css[selector] = merged
    if child.attrs.hasKey("id") and child.attrs["id"].len > 0:
      byId[child.attrs["id"]] = child
    indexNode(child, css, byId)

proc sampleCount(value: float; minimum, maximum: int): int =
  if value.classify == fcNan: return 0
  if value <= float(minimum): return minimum
  if value >= float(maximum): return maximum
  int(ceil(value))

proc cubic(output: var seq[Point]; p0, p1, p2, p3: Point; tolerance: float) =
  let rough = jsHypot2(p1.x - p0.x, p1.y - p0.y) +
    jsHypot2(p2.x - p1.x, p2.y - p1.y) +
    jsHypot2(p3.x - p2.x, p3.y - p2.y)
  let steps = sampleCount(rough / tolerance, 3, 64)
  for index in 1 .. steps:
    let t = float(index) / float(steps)
    let u = 1.0 - t
    output.add(Point(
      x: u * u * u * p0.x + 3.0 * u * u * t * p1.x +
        3.0 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3.0 * u * u * t * p1.y +
        3.0 * u * t * t * p2.y + t * t * t * p3.y
    ))

proc angleOf(ux, uy, vx, vy: float): float =
  let dot = ux * vx + uy * vy
  let length = jsHypot2(ux, uy) * jsHypot2(vx, vy)
  let cosine = dot / length
  if cosine.classify == fcNan: return NaN
  let sign = if ux * vy - uy * vx < 0.0: -1.0 else: 1.0
  sign * arccos(max(-1.0, min(1.0, cosine)))

proc arcTo(output: var seq[Point]; p0: Point; rx, ry, angle: float;
    largeArc, sweep: int; p1: Point; tolerance: float) =
  if rx == 0.0 or ry == 0.0 or rx.classify == fcNan or ry.classify == fcNan:
    output.add(p1)
    return
  if p0.x == p1.x and p0.y == p1.y: return
  let radians = angle * math.PI / 180.0
  let cosine = cos(radians)
  let sine = sin(radians)
  let dx = (p0.x - p1.x) / 2.0
  let dy = (p0.y - p1.y) / 2.0
  let x1 = cosine * dx + sine * dy
  let y1 = -sine * dx + cosine * dy
  var radiusX = abs(rx)
  var radiusY = abs(ry)
  let check = (x1 * x1) / (radiusX * radiusX) +
    (y1 * y1) / (radiusY * radiusY)
  if check > 1.0:
    let scale = sqrt(check)
    radiusX *= scale
    radiusY *= scale
  let termX = ((radiusX * radiusX) * y1) * y1
  let termY = ((radiusY * radiusY) * x1) * x1
  let denominator = termX + termY
  let radiusProduct = ((radiusX * radiusX) * radiusY) * radiusY
  let numerator = radiusProduct - denominator
  let ratio = numerator / denominator
  let root = if ratio.classify == fcNan: NaN else: sqrt(max(0.0, ratio))
  let factor = (if largeArc == sweep: -1.0 else: 1.0) * root
  let centerX1 = factor * radiusX * y1 / radiusY
  let centerY1 = -factor * radiusY * x1 / radiusX
  let centerX = cosine * centerX1 - sine * centerY1 + (p0.x + p1.x) / 2.0
  let centerY = sine * centerX1 + cosine * centerY1 + (p0.y + p1.y) / 2.0
  let start = angleOf(1.0, 0.0, (x1 - centerX1) / radiusX,
    (y1 - centerY1) / radiusY)
  var sweepAngle = angleOf((x1 - centerX1) / radiusX,
    (y1 - centerY1) / radiusY, (-x1 - centerX1) / radiusX,
    (-y1 - centerY1) / radiusY)
  if sweep == 0 and sweepAngle > 0.0: sweepAngle -= math.PI * 2.0
  if sweep != 0 and sweepAngle < 0.0: sweepAngle += math.PI * 2.0
  let steps = sampleCount(abs(sweepAngle) * max(radiusX, radiusY) / tolerance,
    3, 90)
  for index in 1 .. steps:
    let a = start + sweepAngle * float(index) / float(steps)
    let px = cos(a) * radiusX
    let py = sin(a) * radiusY
    output.add(Point(
      x: cosine * px - sine * py + centerX,
      y: sine * px + cosine * py + centerY
    ))

proc numberAt(text: string; position: int; flag: bool): tuple[ok: bool, value: float, next: int] =
  var index = position
  while index < text.len and (text[index] in {' ', '\t', '\r', '\n', ',', '\f', '\v'}):
    inc index
  let pattern = if flag: re"[01]" else: NumberPattern
  let bounds = findBounds(text, pattern, index)
  if bounds.first != index: return (false, NaN, position)
  (true, parseJsNumberString(text[bounds.first .. bounds.last]), bounds.last + 1)

proc arcArgs(text: string): seq[float] =
  var position = 0
  while true:
    let before = result.len
    for argument in 0 ..< 7:
      let parsed = numberAt(text, position, argument == 3 or argument == 4)
      if not parsed.ok: break
      result.add(parsed.value)
      position = parsed.next
    if result.len - before < 7: return

proc pathNumber(values: seq[float]; index: int): float =
  if index < 0 or index >= values.len: NaN else: values[index]

proc parsePath(data: Option[string]; tolerance: float;
    warnings: WarningSink): seq[PathRun] =
  let text = if data.isNone: "" else: data.get
  var runs: seq[PathRun]
  var points: seq[Point]
  var active = false
  var current = Point(x: 0.0, y: 0.0)
  var start = Point(x: 0.0, y: 0.0)
  var lastControl, lastQuad: Option[Point]
  var curved = false
  var reported = initHashSet[string]()

  proc dropped(code: string) =
    if reported.contains(code): return
    reported.incl(code)
    warnings.messages.add("path command \"" & code &
      "\" had missing or non-numeric arguments; that point was dropped")

  proc flush(closed: bool) =
    if not active: return
    var kept: seq[Point]
    for point in points:
      if finitePoint(point): kept.add(point)
    if kept.len != points.len and not reported.contains("nan"):
      reported.incl("nan")
      warnings.messages.add("a path produced a non-numeric point (a degenerate curve, most likely); it was dropped")
    if kept.len > 1: runs.add(PathRun(points: kept, closed: closed, curved: curved))

  proc begin() =
    flush(false)
    points = @[]
    active = true
    curved = false

  var chunks: seq[string]
  var index = 0
  while index < text.len:
    if text[index] in CommandLetters:
      let startIndex = index
      inc index
      while index < text.len and text[index] notin CommandLetters: inc index
      chunks.add(text[startIndex ..< index])
    else:
      inc index

  for chunk in chunks:
    let code = chunk[0]
    let command = $code.toUpperAscii
    let relative = code != command[0]
    let values =
      if command == "A": arcArgs(chunk[1 .. ^1])
      else:
        var parsed: seq[float]
        for token in findAll(chunk[1 .. ^1], NumberPattern):
          parsed.add(parseJsNumberString(token))
        parsed
    proc relativePoint(x, y: float): Point =
      Point(x: (if relative: current.x + x else: x),
        y: (if relative: current.y + y else: y))

    if command == "Z":
      if active and points.len > 1:
        flush(true)
        points = @[start]
        current = start
        curved = false
      continue

    var argument = 0
    while argument < values.len or (command == "M" and argument == 0):
      case command
      of "M":
        let point = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        argument += 2
        begin()
        if not finitePoint(point):
          dropped($code)
          break
        points.add(point)
        current = point
        start = point
        while argument < values.len:
          let next = relativePoint(pathNumber(values, argument),
            pathNumber(values, argument + 1))
          argument += 2
          if not finitePoint(next):
            dropped($code)
            break
          points.add(next)
          current = next
      of "L":
        let point = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        argument += 2
        if not finitePoint(point):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        points.add(point)
        current = point
      of "H":
        let x = pathNumber(values, argument)
        let point = Point(x: (if relative: current.x + x else: x), y: current.y)
        argument += 1
        if not finitePoint(point):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        points.add(point)
        current = point
      of "V":
        let y = pathNumber(values, argument)
        let point = Point(x: current.x, y: (if relative: current.y + y else: y))
        argument += 1
        if not finitePoint(point):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        points.add(point)
        current = point
      of "C":
        let control1 = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        let control2 = relativePoint(pathNumber(values, argument + 2),
          pathNumber(values, argument + 3))
        let endpoint = relativePoint(pathNumber(values, argument + 4),
          pathNumber(values, argument + 5))
        argument += 6
        if not finitePoint(control1) or not finitePoint(control2) or not finitePoint(endpoint):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        curved = true
        cubic(points, current, control1, control2, endpoint, tolerance)
        lastControl = some(control2)
        current = endpoint
      of "S":
        let control2 = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        let endpoint = relativePoint(pathNumber(values, argument + 2),
          pathNumber(values, argument + 3))
        argument += 4
        if not finitePoint(control2) or not finitePoint(endpoint):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        let control1 =
          if lastControl.isSome:
            Point(x: 2.0 * current.x - lastControl.get.x,
              y: 2.0 * current.y - lastControl.get.y)
          else: current
        curved = true
        cubic(points, current, control1, control2, endpoint, tolerance)
        lastControl = some(control2)
        current = endpoint
      of "Q":
        let control = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        let endpoint = relativePoint(pathNumber(values, argument + 2),
          pathNumber(values, argument + 3))
        argument += 4
        if not finitePoint(control) or not finitePoint(endpoint):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        curved = true
        cubic(points, current,
          Point(x: current.x + (2.0 / 3.0) * (control.x - current.x),
            y: current.y + (2.0 / 3.0) * (control.y - current.y)),
          Point(x: endpoint.x + (2.0 / 3.0) * (control.x - endpoint.x),
            y: endpoint.y + (2.0 / 3.0) * (control.y - endpoint.y)),
          endpoint, tolerance)
        lastQuad = some(control)
        current = endpoint
      of "T":
        let endpoint = relativePoint(pathNumber(values, argument),
          pathNumber(values, argument + 1))
        argument += 2
        if not finitePoint(endpoint):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        let control =
          if lastQuad.isSome:
            Point(x: 2.0 * current.x - lastQuad.get.x,
              y: 2.0 * current.y - lastQuad.get.y)
          else: current
        curved = true
        cubic(points, current,
          Point(x: current.x + (2.0 / 3.0) * (control.x - current.x),
            y: current.y + (2.0 / 3.0) * (control.y - current.y)),
          Point(x: endpoint.x + (2.0 / 3.0) * (control.x - endpoint.x),
            y: endpoint.y + (2.0 / 3.0) * (control.y - endpoint.y)),
          endpoint, tolerance)
        lastQuad = some(control)
        current = endpoint
      of "A":
        let radiusX = pathNumber(values, argument)
        let radiusY = pathNumber(values, argument + 1)
        let rotation = pathNumber(values, argument + 2)
        let largeArc = pathNumber(values, argument + 3)
        let sweep = pathNumber(values, argument + 4)
        let endpoint = relativePoint(pathNumber(values, argument + 5),
          pathNumber(values, argument + 6))
        argument += 7
        if not finitePoint(Point(x: radiusX, y: radiusY)) or
            rotation.classify in {fcNan, fcInf, fcNegInf} or
            largeArc.classify in {fcNan, fcInf, fcNegInf} or
            sweep.classify in {fcNan, fcInf, fcNegInf} or not finitePoint(endpoint):
          dropped($code)
          break
        if not active:
          raise newException(ValueError, "Cannot read properties of null (reading 'push')")
        curved = true
        arcTo(points, current, radiusX, radiusY, rotation, int(largeArc),
          int(sweep), endpoint, tolerance)
        current = endpoint
      else:
        argument = values.len
      if command notin ["C", "S"]: lastControl = none(Point)
      if command notin ["Q", "T"]: lastQuad = none(Point)
      if command == "M": break
      if argument >= values.len: break
  flush(false)
  runs

proc contains(ring: seq[Point]; point: Point): bool =
  var inside = false
  var previous = ring.high
  for index in 0 .. ring.high:
    let a = ring[index]
    let b = ring[previous]
    if (a.y > point.y) != (b.y > point.y) and
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x:
      inside = not inside
    previous = index
  inside

proc pickFont(stack: Option[string]): int =
  let name = if stack.isSome: stack.get.toLowerAscii() else: ""
  if name.len == 0: return 5
  if name.contains("mono") or name.contains("courier") or name.contains("consolas") or
      name.contains("menlo") or name.contains("cascadia") or name.contains("code"): return 3
  if name.contains("comic") or name.contains("marker") or name.contains("hand") or
      name.contains("caveat") or name.contains("virgil") or name.contains("excalifont"): return 5
  if name.contains("arial") or name.contains("helvetica") or name.contains("inter") or
      name.contains("roboto") or name.contains("sans") or name.contains("segoe") or
      name.contains("verdana") or name.contains("tahoma") or name.contains("system") or
      name.contains("georgia") or name.contains("times") or name.contains("serif"): return 2
  5

proc transparent(value: JsonNode): bool =
  value.kind == JString and value.getStr == "transparent"

proc fillFor(fill: JsonNode; area: float): JsonNode =
  let wanted = if nullish(fill): %"solid" else: fill
  if not (wanted.kind == JString and wanted.getStr == "solid") and area < 400.0:
    %"solid"
  else: copyNode(wanted)

proc snapStrokeWidth(width: float): int =
  if width < 1.5: 1 elif width < 3.0: 2 else: 4

proc resamplePoints(points: JsonNode; step: float): JsonNode =
  if points.len < 3: return copyNode(points)
  if step.classify in {fcNan, fcInf, fcNegInf}:
    if step.classify == fcInf:
      return resample(points, step)
    if step.classify == fcNan:
      var total = 0.0
      for index in 1 ..< points.len:
        total += jsHypot2(points[index][0].getFloat - points[index - 1][0].getFloat,
          points[index][1].getFloat - points[index - 1][1].getFloat)
      if total == 0.0: return copyNode(points)
      return %*[points[0], points[^1]]
  if step == 0.0: return copyNode(points)
  resample(points, step)

proc sketchLine(spec: JsonNode; curved: bool; step: float; fill: JsonNode): JsonNode =
  result = copyNode(spec)
  if curved:
    result["points"] = resamplePoints(result["points"], step)
    if not result.hasField("roundness"): result["roundness"] = %*{"type": 2}
  elif not result.hasField("roundness"):
    result["roundness"] = newJNull()
  if not result.hasField("roughness"): result["roughness"] = newJInt(1)
  if jsTruthy(result.field("backgroundColor")) and
      not transparent(result.field("backgroundColor")):
    result["fillStyle"] = fillFor(fill,
      jsToNumber(result.field("width")) * jsToNumber(result.field("height")))

proc svgToSpecs*(svg: JsonNode; options: JsonNode = nil): JsonNode

proc svgToSpecs*(svg: string; options: JsonNode = nil): JsonNode =
  svgToSpecs(%svg, options)

proc svgToSpecs*(svg: JsonNode; options: JsonNode = nil): JsonNode =
  let settings = parseOptions(options)
  let sketch = not (settings.mode.kind == JString and settings.mode.getStr == "precise")
  let warningState = WarningSink(messages: @[])
  var dropped = initOrderedSet[string]()
  var shapes: seq[Drawable]
  var holes = false

  let root = parseXml(jsString(svg))
  let svgNode = findSvg(root)
  if svgNode.isNil: raise newException(ValueError, "no <svg> element found")

  var css = initTable[string, Table[string, string]]()
  var byId = initTable[string, XmlNode]()
  indexNode(svgNode, css, byId)

  proc firstStop(node: XmlNode; hops = 0): Option[string] =
    if node.isNil or hops > 8: return none(string)
    for child in node.children:
      if child.tag == "stop": return readStyle(child.attrs, "stop", css).stopColor
      let deeper = firstStop(child, hops)
      if deeper.isSome and deeper.get.len > 0: return deeper
    let href =
      if node.attrs.hasKey("href"): node.attrs["href"]
      elif node.attrs.hasKey("xlink:href"): node.attrs["xlink:href"]
      else: ""
    var reference = href
    if reference.startsWith("#"): reference = reference[1 .. ^1]
    if reference.len == 0: return none(string)
    firstStop(if byId.hasKey(reference): byId[reference] else: nil, hops + 1)

  proc paint(value: Option[string]): JsonNode =
    if value.isNone: return newJNull()
    if value.get == "currentColor": return copyNode(settings.currentColor)
    var captures: array[1, string]
    let bounds = findBounds(value.get, UrlPattern, captures)
    if bounds.first >= 0:
      let stop = firstStop(if byId.hasKey(captures[0]): byId[captures[0]] else: nil)
      if stop.isSome and stop.get.len > 0:
        warningState.messages.add("gradient \"" & captures[0] & "\" flattened to its first stop")
        return colorToHex(stop)
      warningState.messages.add("could not resolve paint \"" & value.get & "\"")
      return newJNull()
    colorToHex(value)

  proc walk(node: XmlNode; matrix: Matrix; inherited: Style; depth = 0) =
    if depth > 24: return
    for child in node.children:
      if child.tag == "#text": continue
      let style = inheritStyle(inherited, readStyle(child.attrs, child.tag, css))
      if style.display.isSome and style.display.get == "none": continue
      let local = multiply(matrix, parseTransform(
        if child.attrs.hasKey("transform"): some(child.attrs["transform"]) else: none(string)))

      if child.tag == "use":
        let href =
          if child.attrs.hasKey("href"): child.attrs["href"]
          elif child.attrs.hasKey("xlink:href"): child.attrs["xlink:href"]
          else: ""
        var reference = href
        if reference.startsWith("#"): reference = reference[1 .. ^1]
        if not byId.hasKey(reference):
          warningState.messages.add("<use> pointed at \"#" & reference & "\", which is not in the file")
          continue
        let placed = multiply(local, [1.0, 0.0, 0.0, 1.0,
          num(if child.attrs.hasKey("x"): some(child.attrs["x"]) else: none(string)),
          num(if child.attrs.hasKey("y"): some(child.attrs["y"]) else: none(string))])
        let target = byId[reference]
        var attrs = target.attrs
        attrs.del("id")
        let via = XmlNode(tag: target.tag, attrs: attrs, children: target.children,
          text: target.text, viaUse: true)
        walk(XmlNode(tag: "#root", attrs: initTable[string, string](), children: @[via]),
          placed, style, depth + 1)
        continue

      case child.tag
      of "symbol":
        if child.viaUse: walk(child, local, style, depth + 1)
      of "g", "svg", "a":
        if (child.attrs.hasKey("clip-path") and child.attrs["clip-path"].len > 0) or
            (child.attrs.hasKey("mask") and child.attrs["mask"].len > 0):
          warningState.messages.add("a clip-path or mask was ignored, so something may extend past where it should")
        walk(child, local, style, depth + 1)
      of "path":
        let runs = parsePath(
          if child.attrs.hasKey("d"): some(child.attrs["d"]) else: none(string),
          settings.tolerance, warningState)
        let filled = style.fill.isSome and style.fill.get.len > 0 and style.fill.get != "none"
        for index, run in runs:
          let inner = filled and index > 0 and run.closed and runs[0].closed and
            contains(runs[0].points, run.points[0])
          if inner: holes = true
          shapes.add(Drawable(kind: dkRun, points: run.points, closed: run.closed,
            curved: run.curved, isHole: inner, style: style, matrix: local))
      of "rect":
        let x = num(if child.attrs.hasKey("x"): some(child.attrs["x"]) else: none(string))
        let y = num(if child.attrs.hasKey("y"): some(child.attrs["y"]) else: none(string))
        let width = num(if child.attrs.hasKey("width"): some(child.attrs["width"]) else: none(string))
        let height = num(if child.attrs.hasKey("height"): some(child.attrs["height"]) else: none(string))
        shapes.add(Drawable(kind: dkNative, nativeKind: nkRectangle,
          cx: x + width / 2.0, cy: y + height / 2.0,
          rx: width / 2.0, ry: height / 2.0,
          rounded: num(if child.attrs.hasKey("rx"): some(child.attrs["rx"]) else: none(string)) > 0.0,
          style: style, matrix: local))
      of "circle":
        let radius = num(if child.attrs.hasKey("r"): some(child.attrs["r"]) else: none(string))
        let centerX = num(if child.attrs.hasKey("cx"): some(child.attrs["cx"]) else: none(string))
        let centerY = num(if child.attrs.hasKey("cy"): some(child.attrs["cy"]) else: none(string))
        shapes.add(Drawable(kind: dkNative, nativeKind: nkEllipse,
          cx: centerX, cy: centerY, rx: radius, ry: radius,
          style: style, matrix: local))
      of "ellipse":
        let centerX = num(if child.attrs.hasKey("cx"): some(child.attrs["cx"]) else: none(string))
        let centerY = num(if child.attrs.hasKey("cy"): some(child.attrs["cy"]) else: none(string))
        let radiusX = num(if child.attrs.hasKey("rx"): some(child.attrs["rx"]) else: none(string))
        let radiusY = num(if child.attrs.hasKey("ry"): some(child.attrs["ry"]) else: none(string))
        shapes.add(Drawable(kind: dkNative, nativeKind: nkEllipse,
          cx: centerX, cy: centerY, rx: radiusX, ry: radiusY,
          style: style, matrix: local))
      of "line":
        var points: seq[Point]
        points.add(Point(
          x: num(if child.attrs.hasKey("x1"): some(child.attrs["x1"]) else: none(string)),
          y: num(if child.attrs.hasKey("y1"): some(child.attrs["y1"]) else: none(string))))
        points.add(Point(
          x: num(if child.attrs.hasKey("x2"): some(child.attrs["x2"]) else: none(string)),
          y: num(if child.attrs.hasKey("y2"): some(child.attrs["y2"]) else: none(string))))
        shapes.add(Drawable(kind: dkRun, points: points, closed: false, curved: false,
          style: style, matrix: local))
      of "polyline", "polygon":
        var values: seq[float]
        if child.attrs.hasKey("points"):
          for token in findAll(child.attrs["points"], NumberPattern):
            values.add(parseJsNumberString(token))
        var points: seq[Point]
        var index = 0
        while index + 1 < values.len:
          points.add(Point(x: values[index], y: values[index + 1]))
          index += 2
        if points.len > 1:
          shapes.add(Drawable(kind: dkRun, points: points, closed: child.tag == "polygon",
            curved: false, style: style, matrix: local))
      of "text":
        var parts: seq[string]
        for part in child.children:
          if part.tag == "#text": parts.add(part.text)
          else:
            var nested: seq[string]
            for textPart in part.children:
              if textPart.tag == "#text": nested.add(textPart.text)
            parts.add(nested.join(""))
        let value = parts.join(" ").strip()
        if value.len > 0:
          shapes.add(Drawable(kind: dkText, textValue: value,
            at: Point(
              x: num(if child.attrs.hasKey("x"): some(child.attrs["x"]) else: none(string)),
              y: num(if child.attrs.hasKey("y"): some(child.attrs["y"]) else: none(string))),
            style: style, matrix: local))
      of "image":
        warningState.messages.add("an embedded <image> was skipped: this converts vector artwork to editable elements, and a raster has none")
      of "title", "desc", "defs", "style", "metadata", "clippath", "mask":
        discard
      else:
        dropped.incl(child.tag)

  walk(svgNode, parseTransform(
    if svgNode.attrs.hasKey("transform"): some(svgNode.attrs["transform"]) else: none(string)),
    readStyle(svgNode.attrs, "svg", css))
  if dropped.len > 0:
    warningState.messages.add("ignored unsupported elements: " & toSeq(dropped.items).join(", "))
  if holes:
    warningState.messages.add(
      if jsTruthy(settings.holeColor):
        "compound paths had their inner rings painted in the supplied holeColor; Excalidraw has no true even-odd fill"
      else:
        "a compound path has inner rings that should be holes. Excalidraw has no even-odd fill, so they are filled over. Pass holeColor with the backdrop colour to punch them visually.")
  if shapes.len == 0:
    raise newException(ValueError,
      if warningState.messages.len > 0:
        "nothing drawable was produced. " & warningState.messages.join(" ")
      else: "nothing drawable found in the SVG")

  for shapeIndex in 0 ..< shapes.len:
    var shape = shapes[shapeIndex]
    case shape.kind
    of dkText:
      shape.at = applyMatrix(shape.matrix, shape.at)
    of dkNative:
      discard
    of dkRun:
      for index in 0 ..< shape.points.len:
        shape.points[index] = applyMatrix(shape.matrix, shape.points[index])
    shapes[shapeIndex] = shape

  var painted = (minX: Inf, minY: Inf, maxX: -Inf, maxY: -Inf)
  for shape in shapes:
    var points: seq[Point]
    case shape.kind
    of dkText: points = @[shape.at]
    of dkNative:
      for point in nativeGeometry(shape, settings.tolerance):
        points.add(applyMatrix(shape.matrix, point))
    of dkRun: points = shape.points
    let bounds = typedBounds(points)
    painted.minX = min(painted.minX, bounds.minX)
    painted.minY = min(painted.minY, bounds.minY)
    painted.maxX = max(painted.maxX, bounds.maxX)
    painted.maxY = max(painted.maxY, bounds.maxY)

  var viewBoxValues: seq[float]
  if svgNode.attrs.hasKey("viewBox"):
    for token in findAll(svgNode.attrs["viewBox"], NumberPattern):
      viewBoxValues.add(parseJsNumberString(token))
  let declared = viewBoxValues.len == 4 and viewBoxValues[2] > 0.0 and
    viewBoxValues[3] > 0.0
  let minX = if declared: viewBoxValues[0] else: painted.minX
  let minY = if declared: viewBoxValues[1] else: painted.minY
  let sourceWidth = if declared: viewBoxValues[2]
    else: max(1e-6, painted.maxX - minX)
  let sourceHeight = if declared: viewBoxValues[3]
    else: max(1e-6, painted.maxY - minY)
  let targetWidth = if settings.width.isSome: settings.width.get else: sourceWidth
  let targetHeight =
    if settings.height.isSome: settings.height.get
    elif settings.width.isSome and settings.widthTruthy:
      sourceHeight * settings.width.get / sourceWidth
    else: sourceHeight
  let scale = min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  let offsetX = (if settings.x.isSome: settings.x.get else: 0.0) - minX * scale
  let offsetY = (if settings.y.isSome: settings.y.get else: 0.0) - minY * scale
  proc place(point: Point): Point =
    Point(x: point.x * scale + offsetX, y: point.y * scale + offsetY)

  proc alpha(style: Style; fill: bool): float =
    let specific = if fill: num(style.fillOpacity, 1.0) else: num(style.strokeOpacity, 1.0)
    specific * num(style.opacity, 1.0)

  proc resolvedFill(style: Style; isHole: bool): JsonNode =
    let fill = paint(style.fill)
    var resolved =
      if style.fill.isNone and style.stroke.isSome and style.stroke.get.len > 0:
        %"transparent"
      elif nullish(fill): %"transparent"
      else: fill
    if isHole and jsTruthy(settings.holeColor): resolved = copyNode(settings.holeColor)
    resolved

  proc strokeStyle(style: Style): string =
    if style.dash.isSome and style.dash.get.len > 0 and style.dash.get != "none":
      "dashed"
    else: "solid"

  proc emitRun(points: var seq[Point]; style: Style; curved, closed, isHole: bool;
      strokeAlpha, fillAlpha: float): JsonNode =
    if closed and (points[0].x != points[^1].x or points[0].y != points[^1].y):
      points.add(points[0])
    let fill = resolvedFill(style, isHole)
    let stroke = paint(style.stroke)
    let bounds = typedBounds(points)
    let originX = points[0].x
    let originY = points[0].y
    let relative = newJArray()
    for point in points:
      relative.add(pointNode(Point(x: point.x - originX, y: point.y - originY)))
    let strokeColor =
      if not nullish(stroke): stroke
      elif not transparent(fill): fill
      else: copyNode(settings.currentColor)
    let strokeWidth =
      if jsTruthy(stroke):
        if sketch: snapStrokeWidth(num(style.strokeWidth, 1.0) * scale)
        else: max(1, jsRoundInt(num(style.strokeWidth, 1.0) * scale))
      else: 1
    var line = %*{
      "type": "line",
      "x": numberNode(originX),
      "y": numberNode(originY),
      "width": numberNode(bounds.maxX - bounds.minX),
      "height": numberNode(bounds.maxY - bounds.minY),
      "points": relative,
      "strokeColor": strokeColor,
      "backgroundColor": fill,
      "strokeWidth": strokeWidth,
      "strokeStyle": strokeStyle(style),
      "roughness": copyNode(settings.roughness),
      "opacity": jsRoundInt((if jsTruthy(stroke): strokeAlpha else: fillAlpha) * 100.0)
    }
    if transparent(stroke) and not transparent(fill): line["strokeColor"] = fill
    if sketch:
      sketchLine(line, curved, settings.step, settings.forcedFill)
    else:
      line["fillStyle"] = %"solid"
      line["roundness"] = newJNull()
      line

  var specs: seq[JsonNode]
  for shape in shapes:
    let strokeAlpha = alpha(shape.style, false)
    let fillAlpha = alpha(shape.style, true)
    case shape.kind
    of dkText:
      let position = place(shape.at)
      let fontSize = max(6.0, num(shape.style.fontSize, 16.0) * scale)
      let fontFamily = pickFont(shape.style.fontFamily)
      let width = measureText(shape.textValue, fontSize, float(fontFamily)).width
      let anchor =
        if shape.style.textAnchor.isSome: shape.style.textAnchor.get.toLowerAscii()
        else: "start"
      let left = if anchor == "middle": position.x - width / 2.0
        elif anchor == "end": position.x - width else: position.x
      let baseline =
        if shape.style.baseline.isSome: shape.style.baseline.get.toLowerAscii()
        else: ""
      let top = if baseline in ["middle", "central"]: position.y - fontSize * 0.5
        elif baseline in ["hanging", "text-before-edge"]: position.y
        else: position.y - fontSize * 0.85
      let stroke = paint(shape.style.fill)
      specs.add(%*{
        "type": "text",
        "x": numberNode(left),
        "y": numberNode(top),
        "text": shape.textValue,
        "fontSize": jsRoundInt(fontSize),
        "fontFamily": fontFamily,
        "textAlign": if anchor == "middle": "center" elif anchor == "end": "right" else: "left",
        "width": numberNode(width),
        "strokeColor": if nullish(stroke): copyNode(settings.currentColor) else: stroke,
        "opacity": jsRoundInt(fillAlpha * 100.0)
      })
    of dkNative:
      let m = shape.matrix
      let skew = abs(m[0] * m[2] + m[1] * m[3])
      let scaleX = jsHypot2(m[0], m[1])
      let scaleY = jsHypot2(m[2], m[3])
      if sketch and scaleX > 0.0 and scaleY > 0.0 and
          skew < 1e-6 * scaleX * scaleY + 1e-9:
        let center = place(applyMatrix(m, Point(x: shape.cx, y: shape.cy)))
        let width = 2.0 * shape.rx * scaleX * scale
        let height = 2.0 * shape.ry * scaleY * scale
        let fill = paint(shape.style.fill)
        let stroke = paint(shape.style.stroke)
        var fillResolved =
          if shape.style.fill.isNone and shape.style.stroke.isSome and
              shape.style.stroke.get.len > 0: %"transparent"
          elif nullish(fill): %"transparent"
          else: fill
        let filled = not transparent(fillResolved)
        let determinant = m[0] * m[3] - m[1] * m[2]
        let angle = arctan2(m[1], m[0]) * (if determinant < 0.0: -1.0 else: 1.0)
        let strokeColor =
          if jsTruthy(stroke) and not transparent(stroke): stroke
          elif filled: fillResolved
          else: copyNode(settings.currentColor)
        specs.add(%*{
          "type": if shape.nativeKind == nkRectangle: "rectangle" else: "ellipse",
          "x": numberNode(center.x - width / 2.0),
          "y": numberNode(center.y - height / 2.0),
          "width": numberNode(width),
          "height": numberNode(height),
          "angle": numberNode(angle),
          "strokeColor": strokeColor,
          "backgroundColor": fillResolved,
          "fillStyle": if filled: fillFor(settings.forcedFill, width * height) else: %"solid",
          "strokeWidth": if jsTruthy(stroke): snapStrokeWidth(num(shape.style.strokeWidth, 1.0) * scale) else: 1,
          "strokeStyle": strokeStyle(shape.style),
          "roughness": copyNode(settings.roughness),
          "roundness": if shape.nativeKind == nkRectangle and shape.rounded: %*{"type": 3} else: newJNull(),
          "opacity": jsRoundInt((if jsTruthy(stroke): strokeAlpha else: fillAlpha) * 100.0)
        })
      else:
        var points: seq[Point]
        for point in nativeGeometry(shape, settings.tolerance):
          points.add(place(applyMatrix(m, point)))
        specs.add(emitRun(points, shape.style, shape.nativeKind == nkEllipse,
          true, false, strokeAlpha, fillAlpha))
    of dkRun:
      var points: seq[Point]
      for point in shape.points: points.add(place(point))
      specs.add(emitRun(points, shape.style, shape.curved, shape.closed,
        shape.isHole, strokeAlpha, fillAlpha))

  var specArray = newJArray()
  for spec in specs: specArray.add(spec)
  var warningArray = newJArray()
  for warning in warningState.messages: warningArray.add(%warning)
  %*{
    "specs": specArray,
    "warnings": warningArray,
    "source": {"width": numberNode(sourceWidth), "height": numberNode(sourceHeight)},
    "placed": {"width": numberNode(sourceWidth * scale), "height": numberNode(sourceHeight * scale)},
    "shapes": specs.len
  }
