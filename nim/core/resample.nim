import std/[json, math]
import ./jsvalue

const SKETCH_STEP* = 18.0

proc finitePoint(p: JsonNode): bool =
  p.isArr and p.len >= 2 and p[0].isFiniteNumber and p[1].isFiniteNumber

proc pointX(p: JsonNode): float =
  floatOr(p[0], 0.0)

proc pointY(p: JsonNode): float =
  floatOr(p[1], 0.0)

proc isClosedRun(pts: JsonNode): bool =
  pts.len > 2 and pointX(pts[0]) == pointX(pts[^1]) and pointY(pts[0]) == pointY(pts[^1])

proc resample*(input: JsonNode; step = SKETCH_STEP): JsonNode =
  if not input.isArr: return input

  var pts = newJArray()
  block:
    var allFinite = true
    for p in input:
      if not finitePoint(p):
        allFinite = false
        break
    if allFinite:
      for p in input: pts.add(p)
    else:
      for p in input:
        if finitePoint(p): pts.add(p)

  if pts.len < 3: return copyNode(pts)
  let closed = isClosedRun(pts)

  var total = 0.0
  for i in 1 ..< pts.len:
    total += hypot(pointX(pts[i]) - pointX(pts[i - 1]), pointY(pts[i]) - pointY(pts[i - 1]))
  if total == 0.0: return copyNode(pts)

  let n = max(if closed: 6 else: 2, jsRoundInt(total / step))
  if n >= pts.len - 1: return copyNode(pts)

  let target = total / float(n)
  var outputPoints = newJArray()
  outputPoints.add(pts[0])
  var prev = pts[0]
  var acc = 0.0
  var i = 1
  while i < pts.len and outputPoints.len < n:
    let seg = hypot(pointX(pts[i]) - pointX(prev), pointY(pts[i]) - pointY(prev))
    if acc + seg >= target:
      let t = if seg == 0.0: 0.0 else: (target - acc) / seg
      let p = newPoint(
        pointX(prev) + (pointX(pts[i]) - pointX(prev)) * t,
        pointY(prev) + (pointY(pts[i]) - pointY(prev)) * t
      )
      outputPoints.add(p)
      prev = p
      acc = 0.0
    else:
      acc += seg
      prev = pts[i]
      i += 1

  let last = pts[^1]
  let tail = outputPoints[^1]
  if pointX(tail) != pointX(last) or pointY(tail) != pointY(last):
    outputPoints.add(last)
  outputPoints
