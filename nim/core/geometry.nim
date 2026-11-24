import std/[json, math]

import ./jsvalue

const
  TAU = math.PI * 2.0
  MAX_POINTS = 10000
  MAX_REPEAT = 2000
  ParametricKeys = [
    "sides", "cx", "cy", "r", "rx", "ry", "innerR", "innerRatio",
    "rotation", "from", "to", "segments", "radius", "smooth", "closed",
    "resolution"
  ]
  KeyedTypes = [
    "polygon", "star", "arc", "capsule", "path", "rectangle", "ellipse",
    "diamond", "arrow", "line", "text", "freedraw", "frame", "image"
  ]
  PrototypeKeys = ["toString", "constructor", "__proto__"]

type
  Point = object
    x, y: float
  WarnProc = proc(message: string)
  WarningSink = ref object
    messages: seq[string]

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
  for n in [ax / maximum, ay / maximum]:
    let square = n * n
    let summand = square - compensation
    let preliminary = sum + summand
    compensation = (preliminary - sum) - summand
    sum = preliminary
  sqrt(sum) * maximum

proc outputPoint(x, y: float): JsonNode =
  result = newJArray()
  result.add(numberNode(x))
  result.add(numberNode(y))

proc arrayValue(point: JsonNode; index: int): JsonNode =
  if point.isArr and index >= 0 and index < point.len: point[index] else: nil

proc deleteKey(target: JsonNode; key: string) =
  if target.hasKey(key): target.delete(key)

proc pointBounds*(points: JsonNode): tuple[minX, minY, maxX, maxY: float] =
  var minX = Inf
  var minY = Inf
  var maxX = -Inf
  var maxY = -Inf
  if points.isArr:
    for point in points:
      let pxNode = arrayValue(point, 0)
      let pyNode = arrayValue(point, 1)
      if pxNode != nil:
        let px = floatOr(pxNode, 0.0)
        if px < minX: minX = px
        if px > maxX: maxX = px
      if pyNode != nil:
        let py = floatOr(pyNode, 0.0)
        if py < minY: minY = py
        if py > maxY: maxY = py
  if minX == Inf: return (0.0, 0.0, 0.0, 0.0)
  (minX, minY, maxX, maxY)

proc capped(value: int; maximum: int; what: string; warn: WarnProc): int =
  if value <= maximum: return value
  warn(what & " " & $value & " capped at " & $maximum)
  maximum

proc roundedCapped(value: float; minimum, maximum: int; what: string;
    warn: WarnProc): int =
  let rounded = max(float(minimum), jsRound(value))
  if rounded > float(maximum):
    warn(what & " " & jsNumberString(rounded) & " capped at " & $maximum)
    return maximum
  jsRoundInt(rounded)

proc num(spec: JsonNode; key: string; fallback: float): float =
  floatOr(spec.field(key), fallback)

proc exactType(spec: JsonNode): string =
  let kind = spec.field("type")
  if kind.isNil or kind.kind != JString: "" else: kind.getStr

proc curvePointX(point: JsonNode): float = floatOr(arrayValue(point, 0), 0.0)
proc curvePointY(point: JsonNode): float = floatOr(arrayValue(point, 1), 0.0)

proc finitePoint(point: Point): bool =
  point.x.classify notin {fcNan, fcInf, fcNegInf} and
    point.y.classify notin {fcNan, fcInf, fcNegInf}

proc typedPointBounds(points: seq[Point]): tuple[minX, minY, maxX, maxY: float] =
  var minX = Inf
  var minY = Inf
  var maxX = -Inf
  var maxY = -Inf
  for point in points:
    if point.x < minX: minX = point.x
    if point.x > maxX: maxX = point.x
    if point.y < minY: minY = point.y
    if point.y > maxY: maxY = point.y
  if minX == Inf: return (0.0, 0.0, 0.0, 0.0)
  (minX, minY, maxX, maxY)

proc resampleCurve(input: seq[Point]): seq[Point] =
  var points = input
  var allFinite = true
  for point in input:
    if not finitePoint(point):
      allFinite = false
      break
  if not allFinite:
    points = newSeqOfCap[Point](input.len)
    for point in input:
      if finitePoint(point): points.add(point)
  if points.len < 3: return points
  let closed = points[0].x == points[^1].x and points[0].y == points[^1].y

  var total = 0.0
  for i in 1 ..< points.len:
    total += jsHypot2(points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y)
  if total == 0.0: return points

  let count = max(if closed: 6 else: 2, jsRoundInt(total / 18.0))
  if count >= points.len - 1: return points

  let target = total / float(count)
  var sampled = newSeqOfCap[Point](count + 1)
  sampled.add(points[0])
  var previous = points[0]
  var accumulated = 0.0
  var i = 1
  while i < points.len and sampled.len < count:
    let segment = jsHypot2(points[i].x - previous.x, points[i].y - previous.y)
    if accumulated + segment >= target:
      let t = if segment == 0.0: 0.0 else: (target - accumulated) / segment
      let point = Point(
        x: previous.x + (points[i].x - previous.x) * t,
        y: previous.y + (points[i].y - previous.y) * t
      )
      sampled.add(point)
      previous = point
      accumulated = 0.0
    else:
      accumulated += segment
      previous = points[i]
      i += 1

  let last = points[^1]
  let tail = sampled[^1]
  if tail.x != last.x or tail.y != last.y: sampled.add(last)
  sampled

proc fromAbsolute(points: seq[Point], spec: JsonNode; closed = false;
    curved = false): JsonNode =
  var joined = points
  if closed and joined.len > 0:
    let first = joined[0]
    let last = joined[^1]
    if first.x != last.x or first.y != last.y:
      joined = newSeqOfCap[Point](points.len + 1)
      for point in points: joined.add(point)
      joined.add(first)

  let spaced = if curved: resampleCurve(joined) else: joined
  let bounds = typedPointBounds(spaced)
  let originX = spaced[0].x
  let originY = spaced[0].y

  result = newJObject()
  for key, value in spec:
    if key notin ParametricKeys: result[key] = copyNode(value)
  result["type"] = %"line"
  result["x"] = numberNode(originX)
  result["y"] = numberNode(originY)
  result["width"] = numberNode(bounds.maxX - bounds.minX)
  result["height"] = numberNode(bounds.maxY - bounds.minY)

  let relative = newJArray()
  for point in spaced:
    relative.add(outputPoint(point.x - originX, point.y - originY))
  result["points"] = relative

  if spec.hasField("roundness"):
    result["roundness"] = copyNode(spec["roundness"])
  elif curved or jsTruthy(spec.field("smooth")):
    result["roundness"] = %*{"type": 2}
  else:
    result["roundness"] = newJNull()

# JSON callers cross into the numeric pipeline here; only spaced output becomes JSON.
proc fromAbsolute(points: JsonNode, spec: JsonNode; closed = false;
    curved = false): JsonNode =
  var typedPoints = newSeqOfCap[Point](points.len)
  for point in points:
    typedPoints.add(Point(x: curvePointX(point), y: curvePointY(point)))
  fromAbsolute(typedPoints, spec, closed, curved)

proc polygon(spec: JsonNode; warn: WarnProc): JsonNode =
  let sides = roundedCapped(num(spec, "sides", 6.0), 3, MAX_POINTS,
    "polygon sides", warn)
  let cx = num(spec, "cx", num(spec, "x", 0.0) + num(spec, "width", 100.0) / 2.0)
  let cy = num(spec, "cy", num(spec, "y", 0.0) + num(spec, "height", 100.0) / 2.0)
  let rx = num(spec, "rx", num(spec, "r", num(spec, "width", 100.0) / 2.0))
  let ry = num(spec, "ry", num(spec, "r", num(spec, "height", num(spec, "width", 100.0)) / 2.0))
  let turn = (num(spec, "rotation", -90.0) * math.PI) / 180.0

  var points = newJArray()
  for i in 0 ..< sides:
    let angle = turn + (float(i) / float(sides)) * TAU
    points.add(newPoint(cx + cos(angle) * rx, cy + sin(angle) * ry))
  fromAbsolute(points, spec, closed = true)

proc star(spec: JsonNode; warn: WarnProc): JsonNode =
  let count = roundedCapped(num(spec, "points", 5.0), 3, MAX_POINTS div 2,
    "star points", warn)
  let cx = num(spec, "cx", num(spec, "x", 0.0) + num(spec, "width", 100.0) / 2.0)
  let cy = num(spec, "cy", num(spec, "y", 0.0) + num(spec, "height", 100.0) / 2.0)
  let outer = num(spec, "r", num(spec, "width", 100.0) / 2.0)
  let inner = num(spec, "innerR", outer * num(spec, "innerRatio", 0.45))
  let turn = (num(spec, "rotation", -90.0) * math.PI) / 180.0

  var points = newJArray()
  for i in 0 ..< count * 2:
    let angle = turn + (float(i) / float(count * 2)) * TAU
    let radius = if i mod 2 == 0: outer else: inner
    points.add(newPoint(cx + cos(angle) * radius, cy + sin(angle) * radius))
  fromAbsolute(points, spec, closed = true)

proc arc(spec: JsonNode; warn: WarnProc): JsonNode =
  let cx = num(spec, "cx", 0.0)
  let cy = num(spec, "cy", 0.0)
  let rx = num(spec, "rx", num(spec, "r", 50.0))
  let ry = num(spec, "ry", num(spec, "r", 50.0))
  let fromAngle = num(spec, "from", 0.0)
  let toAngle = num(spec, "to", 180.0)
  let steps = roundedCapped(
    max(4.0, jsRound(num(spec, "segments", abs(toAngle - fromAngle) / 4.0))),
    4, MAX_POINTS, "arc segments", warn
  )

  var points = newJArray()
  for i in 0 .. steps:
    let angle = (fromAngle + ((toAngle - fromAngle) * float(i)) / float(steps)) * math.PI / 180.0
    points.add(newPoint(cx + cos(angle) * rx, cy + sin(angle) * ry))
  let closed = jsTruthy(spec.field("closed"))
  if closed: points.add(newPoint(cx, cy))
  fromAbsolute(points, spec, closed = closed, curved = true)

proc capsuleCorner(ccx, ccy, radius: float; startDeg: float;
    steps: int): JsonNode =
  result = newJArray()
  for i in 0 .. steps:
    let angle = (startDeg + (90.0 * float(i)) / float(steps)) * math.PI / 180.0
    result.add(newPoint(ccx + cos(angle) * radius, ccy + sin(angle) * radius))

proc capsule(spec: JsonNode; warn: WarnProc): JsonNode =
  let x = num(spec, "x", 0.0)
  let y = num(spec, "y", 0.0)
  let width = num(spec, "width", 100.0)
  let height = num(spec, "height", 60.0)
  let radius = min(num(spec, "radius", min(width, height) / 2.0), min(width, height) / 2.0)
  let steps = roundedCapped(num(spec, "segments", 8.0), 3, MAX_POINTS div 4,
    "capsule segments", warn)

  var points = newJArray()
  for corner in [
    capsuleCorner(x + width - radius, y + radius, radius, -90.0, steps),
    capsuleCorner(x + width - radius, y + height - radius, radius, 0.0, steps),
    capsuleCorner(x + radius, y + height - radius, radius, 90.0, steps),
    capsuleCorner(x + radius, y + radius, radius, 180.0, steps)
  ]:
    for point in corner: points.add(point)
  fromAbsolute(points, spec, closed = true, curved = true)

proc pathPoint(point: JsonNode): Point =
  if point.isArr:
    Point(x: floatOr(arrayValue(point, 0), 0.0),
      y: floatOr(arrayValue(point, 1), 0.0))
  else:
    Point(x: floatOr(point.field("x"), 0.0),
      y: floatOr(point.field("y"), 0.0))

proc pathAt(points: seq[Point]; index: int; closed: bool): Point =
  if closed: return points[((index mod points.len) + points.len) mod points.len]
  points[max(0, min(points.len - 1, index))]

proc path(spec: JsonNode; warn: WarnProc): JsonNode =
  let supplied = spec.field("points")
  let source = if supplied.isNil or supplied.kind == JNull: newJArray() else: supplied
  if not source.isArr:
    raise newException(ValueError, "(spec.points ?? []).map is not a function")

  # Catmull-Rom stays numeric until fromAbsolute so sampling does not allocate JSON nodes.
  var raw: seq[Point]
  for point in source: raw.add(pathPoint(point))
  if raw.len < 2:
    let fallback = if raw.len > 0: raw else: @[Point(x: 0.0, y: 0.0), Point(x: 1.0, y: 1.0)]
    return fromAbsolute(fallback, spec)

  let smoothField = spec.field("smooth")
  if smoothField != nil and smoothField.kind == JBool and not smoothField.getBool:
    return fromAbsolute(raw, spec, closed = jsTruthy(spec.field("closed")))

  let closed = jsTruthy(spec.field("closed"))
  let spans = if closed: raw.len else: raw.len - 1
  let resolution = roundedCapped(num(spec, "resolution", 10.0), 2,
    max(2, MAX_POINTS div spans), "path resolution", warn)

  var output: seq[Point]
  for i in 0 ..< spans:
    let p0 = pathAt(raw, i - 1, closed)
    let p1 = pathAt(raw, i, closed)
    let p2 = pathAt(raw, i + 1, closed)
    let p3 = pathAt(raw, i + 2, closed)
    for sample in 0 ..< resolution:
      let t = float(sample) / float(resolution)
      let t2 = t * t
      let t3 = t2 * t
      let x = 0.5 * (
        2.0 * p1.x +
        (-p0.x + p2.x) * t +
        (2.0 * p0.x - 5.0 * p1.x + 4.0 * p2.x - p3.x) * t2 +
        (-p0.x + 3.0 * p1.x - 3.0 * p2.x + p3.x) * t3
      )
      let y = 0.5 * (
        2.0 * p1.y +
        (-p0.y + p2.y) * t +
        (2.0 * p0.y - 5.0 * p1.y + 4.0 * p2.y - p3.y) * t2 +
        (-p0.y + 3.0 * p1.y - 3.0 * p2.y + p3.y) * t3
      )
      output.add(Point(x: x, y: y))
  output.add(if closed: output[0] else: raw[^1])
  fromAbsolute(output, spec, closed = closed, curved = true)

proc mapPoints(points: JsonNode; map: proc(px, py: float): JsonNode): JsonNode =
  result = newJArray()
  for point in points:
    if point.isArr:
      result.add(map(floatOr(arrayValue(point, 0), 0.0),
        floatOr(arrayValue(point, 1), 0.0)))
    else:
      result.add(map(floatOr(point.field("x"), 0.0), floatOr(point.field("y"), 0.0)))

proc shift(spec: JsonNode; dx, dy: float): JsonNode =
  result = newJObject()
  for key, value in spec: result[key] = copyNode(value)
  if result.field("x").isNumber or dx != 0.0:
    result["x"] = numberNode(num(result, "x", 0.0) + dx)
  if result.field("y").isNumber or dy != 0.0:
    result["y"] = numberNode(num(result, "y", 0.0) + dy)
  if result.field("cx").isNumber:
    result["cx"] = numberNode(num(result, "cx", 0.0) + dx)
  if result.field("cy").isNumber:
    result["cy"] = numberNode(num(result, "cy", 0.0) + dy)
  if exactType(result) == "path" and result.field("points").isArr:
    result["points"] = mapPoints(result["points"],
      proc(px, py: float): JsonNode = outputPoint(px + dx, py + dy))

proc flip(spec: JsonNode; axis: string; at: float): JsonNode =
  result = newJObject()
  for key, value in spec: result[key] = copyNode(value)
  let anchored = exactType(result) in ["line", "arrow", "freedraw"]
  let absolute = exactType(result) == "path"

  if axis == "vertical":
    if result.field("x").isNumber:
      result["x"] = numberNode(2.0 * at - num(result, "x", 0.0) -
        (if anchored: 0.0 else: num(result, "width", 0.0)))
    if result.field("cx").isNumber:
      result["cx"] = numberNode(2.0 * at - num(result, "cx", 0.0))
    if result.field("points").isArr:
      result["points"] = mapPoints(result["points"],
        proc(px, py: float): JsonNode =
          outputPoint(if absolute: 2.0 * at - px else: -px, py))
    if result.field("from").isNumber:
      result["from"] = numberNode(180.0 - num(result, "from", 0.0))
    if result.field("to").isNumber:
      result["to"] = numberNode(180.0 - num(result, "to", 0.0))
    if result.field("rotation").isNumber:
      result["rotation"] = numberNode(180.0 - num(result, "rotation", 0.0))
  else:
    if result.field("y").isNumber:
      result["y"] = numberNode(2.0 * at - num(result, "y", 0.0) -
        (if anchored: 0.0 else: num(result, "height", 0.0)))
    if result.field("cy").isNumber:
      result["cy"] = numberNode(2.0 * at - num(result, "cy", 0.0))
    if result.field("points").isArr:
      result["points"] = mapPoints(result["points"],
        proc(px, py: float): JsonNode =
          outputPoint(px, if absolute: 2.0 * at - py else: -py))
    if result.field("from").isNumber:
      result["from"] = numberNode(-num(result, "from", 0.0))
    if result.field("to").isNumber:
      result["to"] = numberNode(-num(result, "to", 0.0))
    if result.field("rotation").isNumber:
      result["rotation"] = numberNode(-num(result, "rotation", 0.0))

  if result.field("angle").isNumber:
    result["angle"] = numberNode(-num(result, "angle", 0.0))
  deleteKey(result, "id")
  deleteKey(result, "ref")

proc nullishField(value: JsonNode; keys: varargs[string]): JsonNode =
  for key in keys:
    let field = value.field(key)
    if not field.isNil and field.kind != JNull: return field
  nil

proc safePositiveCount(value: float; maximum: int): int =
  let rounded = jsRound(value)
  if rounded > float(maximum): return maximum
  max(1, jsRoundInt(rounded))

proc applyRepeat(spec: JsonNode; warn: WarnProc): seq[JsonNode] =
  let repeat = spec.field("repeat")
  if not jsTruthy(repeat): return @[spec]

  var base = newJObject()
  for key, value in spec:
    if key != "repeat": base[key] = copyNode(value)
  let count = roundedCapped(num(repeat, "count", 1.0), 1, MAX_REPEAT,
    "repeat count", warn)

  if jsTruthy(repeat.field("around")):
    let around = repeat["around"]
    let aroundCx = nullishField(around, "cx", "x")
    let aroundCy = nullishField(around, "cy", "y")
    let centerX = floatOr(aroundCx, 0.0)
    let centerY = floatOr(aroundCy, 0.0)
    let startFrom = num(repeat, "from", 0.0)
    let to = num(repeat, "to", 360.0 - 360.0 / float(count) + startFrom)
    let anchorX = num(base, "cx", num(base, "x", 0.0) + num(base, "width", 0.0) / 2.0)
    let anchorY = num(base, "cy", num(base, "y", 0.0) + num(base, "height", 0.0) / 2.0)
    let radius = num(repeat, "radius", jsHypot2(anchorX - centerX, anchorY - centerY))
    let startAngle = arctan2(anchorY - centerY, anchorX - centerX)

    for i in 0 ..< count:
      let angle = if count == 1: startAngle else:
        startAngle + (startFrom + ((to - startFrom) * float(i)) / float(max(1, count - 1))) * math.PI / 180.0
      var copy = shift(base,
        centerX + cos(angle) * radius - anchorX,
        centerY + sin(angle) * radius - anchorY)
      deleteKey(copy, "id")
      if i > 0: deleteKey(copy, "ref")
      if jsTruthy(repeat.field("rotate")):
        copy["angle"] = numberNode(num(base, "angle", 0.0) + angle - startAngle)
      result.add(copy)
    return

  let dx = num(repeat, "dx", 0.0)
  let dy = num(repeat, "dy", 0.0)
  let cols = safePositiveCount(floatOr(repeat.field("cols"), float(count)), count)
  let rows = safePositiveCount(floatOr(repeat.field("rows"), ceil(float(count) / float(cols))), count)
  var made = 0
  for row in 0 ..< rows:
    if made >= count: break
    for col in 0 ..< cols:
      if made >= count: break
      var copy = shift(base,
        dx * float(col) + num(repeat, "rowDx", 0.0) * float(row),
        dy * float(row) + num(repeat, "colDy", 0.0) * float(col))
      deleteKey(copy, "id")
      if made > 0: deleteKey(copy, "ref")
      result.add(copy)
      made += 1

proc applyMirror(spec: JsonNode): seq[JsonNode] =
  let mirror = spec.field("mirror")
  if not jsTruthy(mirror): return @[spec]

  var base = newJObject()
  for key, value in spec:
    if key != "mirror": base[key] = copyNode(value)
  let axisField = mirror.field("axis")
  let axis = if axisField != nil and axisField.kind == JString and
      axisField.getStr == "horizontal": "horizontal" else: "vertical"
  let at = floatOr(nullishField(mirror, "at", "x", "y"), 0.0)
  let keepField = mirror.field("keep")
  let keep = keepField.isNil or keepField.kind != JBool or keepField.getBool
  if keep: @[base, flip(base, axis, at)] else: @[flip(base, axis, at)]

proc unwrapKeyed(spec: JsonNode): JsonNode =
  if spec.hasField("type"): return spec
  if spec.len != 1: return spec
  var key = ""
  for candidate, value in spec:
    key = candidate
  if key notin KeyedTypes: return spec
  let inner = spec[key]
  if not inner.isObj: return spec
  result = newJObject()
  result["type"] = %key
  for innerKey, value in inner: result[innerKey] = copyNode(value)

proc makePrimitive(kind: string; spec: JsonNode; warn: WarnProc): JsonNode =
  case kind
  of "polygon": polygon(spec, warn)
  of "star": star(spec, warn)
  of "arc": arc(spec, warn)
  of "capsule": capsule(spec, warn)
  of "path": path(spec, warn)
  else: nil

proc expandSpecs*(specs: JsonNode; warnings: var seq[string]): JsonNode =
  var sink = WarningSink(messages: warnings)
  proc warn(message: string) = sink.messages.add(message)

  result = newJArray()
  if specs.isNil or specs.kind == JNull: return
  if not specs.isArr:
    raise newException(ValueError, "specs is not iterable")

  for raw in specs:
    if not raw.isObj:
      result.add(copyNode(raw))
      continue
    let spec = unwrapKeyed(raw)
    for mirrored in applyMirror(spec):
      for copy in applyRepeat(mirrored, warn):
        let typeNode = copy.field("type")
        let kind = if typeNode.isNil: "undefined" else: jsString(typeNode)
        if kind in PrototypeKeys:
          warn("could not build " & kind & ": make is not a function")
          continue
        try:
          let built = makePrimitive(kind, copy, warn)
          if built.isNil:
            result.add(copy)
          else:
            result.add(built)
        except CatchableError as error:
          warn("could not build " & kind & ": " & error.msg)
  warnings = sink.messages
