import std/[json, os, unittest]
import ../core/[jsvalue, textmetrics]
import ../server/svg

let fixturePath = currentSourcePath().parentDir / "fixtures" / "svg.json"
const metricsPath = parentDir(parentDir(parentDir(currentSourcePath()))) /
  "server" / "font-metrics.json"
let cases = parseFile(fixturePath)

proc nodeText(node: JsonNode): string =
  if node.isNil: "<missing>" else: $node

proc mismatch(actual, expected: JsonNode; path: string): string =
  path & ": actual " & nodeText(actual) & " != expected " & nodeText(expected)

proc divergence(actual, expected: JsonNode; path = "$"): string =
  if actual.isNil or expected.isNil:
    if actual.isNil and expected.isNil: return ""
    return mismatch(actual, expected, path)
  if actual.isNumber and expected.isNumber:
    if actual.kind == JInt and expected.kind == JInt:
      if actual.getInt != expected.getInt: return mismatch(actual, expected, path)
      return ""
    let a = actual.getFloat
    let b = expected.getFloat
    let tolerance = 1e-8 * max(1.0, max(abs(a), abs(b)))
    if abs(a - b) > tolerance: return mismatch(actual, expected, path)
    return ""
  if actual.kind != expected.kind: return mismatch(actual, expected, path)
  case actual.kind
  of JObject:
    for key, value in actual:
      if not expected.hasKey(key): return mismatch(value, nil, path & "." & key)
    for key, value in expected:
      if not actual.hasKey(key): return mismatch(nil, value, path & "." & key)
    for key, value in actual:
      let problem = divergence(value, expected[key], path & "." & key)
      if problem.len > 0: return problem
  of JArray:
    if actual.len != expected.len: return mismatch(actual, expected, path)
    for index in 0 ..< actual.len:
      let problem = divergence(actual[index], expected[index], path & "[" & $index & "]")
      if problem.len > 0: return problem
  else:
    if actual != expected: return mismatch(actual, expected, path)
  ""

proc capture(svg, options: JsonNode): JsonNode =
  try:
    %*{"ok": true, "value": svgToSpecs(svg, options)}
  except CatchableError as error:
    %*{"ok": false, "error": error.msg}

suite "svg":
  setup:
    check loadMetrics(metricsPath) > 0

  test "svgToSpecs matches the JavaScript oracle":
    echo "SVG cases: ", cases.len
    for entry in cases:
      let actual = capture(entry["input"], entry["options"])
      let problem = divergence(parseJson($actual), entry["expected"])
      if problem.len > 0:
        echo "SVG mismatch: ", entry["name"].getStr, " at ", problem
      check problem.len == 0

  test "nil and JSON null options import the cubic path":
    var expected: JsonNode
    let document = "<svg><path d='M10 40 C 30 5, 60 5, 110 40'/></svg>"
    for entry in cases:
      if entry["name"].getStr == "null options":
        expected = entry["expected"]
        break
    check not expected.isNil
    for options in [nil, newJNull()]:
      let actual = capture(%document, options)
      check actual["ok"].getBool
      check actual["value"]["specs"].len == 1
      check actual["value"]["warnings"].len == 0
      check divergence(parseJson($actual), expected).len == 0
