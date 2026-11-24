import std/[json, os, unittest]
import ../core/[geometry, jsvalue]

let fixturePath = currentSourcePath().parentDir / "fixtures" / "geometry.json"

proc nodeText(node: JsonNode): string =
  if node.isNil: "<missing>" else: $node

proc mismatch(actual, expected: JsonNode; path: string): string =
  path & ": actual " & nodeText(actual) & " != expected " & nodeText(expected)

proc jsonDivergence(actual, expected: JsonNode; path = "$"): string =
  if actual.isNil or expected.isNil:
    if actual.isNil and expected.isNil: return ""
    return mismatch(actual, expected, path)

  if expected.isObj and expected.len == 1 and expected.hasKey("$samples"):
    let samples = expected["$samples"]
    if not actual.isArr: return mismatch(actual, expected, path)
    if actual.len != samples["count"].getInt:
      return mismatch(%actual.len, samples["count"], path & ".length")
    if samples{"closed"}.boolOr(false):
      if actual[0] != actual[^1]:
        return mismatch(actual[^1], actual[0], path & "[last]")
    for sampleIndex in 0 ..< samples["indices"].len:
      let index = samples["indices"][sampleIndex].getInt
      let divergence = jsonDivergence(actual[index], samples["values"][sampleIndex],
        path & "[" & $index & "]")
      if divergence.len > 0: return divergence
    return ""

  if actual.kind != expected.kind:
    if not (actual.isNumber and expected.isNumber):
      return mismatch(actual, expected, path)

  if actual.isNumber and expected.isNumber:
    if actual.kind == JInt and expected.kind == JInt:
      if actual.getInt != expected.getInt: return mismatch(actual, expected, path)
      return ""
    let actualNumber = actual.getFloat
    let expectedNumber = expected.getFloat
    let tolerance = 1e-9 * max(1.0, max(abs(actualNumber), abs(expectedNumber)))
    if abs(actualNumber - expectedNumber) > tolerance:
      return mismatch(actual, expected, path)
    return ""

  case actual.kind
  of JObject:
    for key, value in actual:
      if not expected.hasKey(key):
        return mismatch(value, nil, path & "." & key)
    for key, value in expected:
      if not actual.hasKey(key):
        return mismatch(nil, value, path & "." & key)
    for key, value in actual:
      let divergence = jsonDivergence(value, expected[key], path & "." & key)
      if divergence.len > 0: return divergence
  of JArray:
    if actual.len != expected.len: return mismatch(actual, expected, path)
    for i in 0 ..< actual.len:
      let divergence = jsonDivergence(actual[i], expected[i], path & "[" & $i & "]")
      if divergence.len > 0: return divergence
  else:
    if actual != expected: return mismatch(actual, expected, path)
  ""

suite "geometry":
  test "pointBounds loops and returns zeros for an empty run":
    check pointBounds(newJArray()) == (minX: 0.0, minY: 0.0, maxX: 0.0, maxY: 0.0)
    check pointBounds(parseJson("[[3, -2], [-5, 7], [4, 1]]")) ==
      (minX: -5.0, minY: -2.0, maxX: 4.0, maxY: 7.0)

  test "expandSpecs accepts null and empty arrays":
    var warnings: seq[string]
    check expandSpecs(nil, warnings) == newJArray()
    check expandSpecs(newJNull(), warnings) == newJArray()
    check expandSpecs(newJArray(), warnings) == newJArray()
    check warnings.len == 0

  test "expandSpecs rejects non-array specs":
    for specs in [
      parseJson("{}"),
      parseJson("""{"specs":[]}"""),
      parseJson("\"scene\""),
      parseJson("0"),
      parseJson("false")
    ]:
      var warnings: seq[string]
      var message = ""
      try:
        discard expandSpecs(specs, warnings)
      except ValueError as error:
        message = error.msg
      check message == "specs is not iterable"
      check warnings.len == 0

  test "expandSpecs appends warnings to the caller sequence":
    var warnings: seq[string] = @["existing warning"]
    let specs = parseJson("""[{"type":"polygon","sides":20000,"r":1}]""")
    let expanded = expandSpecs(specs, warnings)
    check warnings == @["existing warning", "polygon sides 20000 capped at 10000"]
    check expanded.len == 1

  test "primitive caps report their exact warnings":
    let specs = parseJson("""[
      {"type":"star","points":6000},
      {"type":"arc","segments":10001},
      {"type":"capsule","segments":2501},
      {"type":"path","points":[[0,0],[10,0],[10,10],[0,10],[0,0],[5,5]],"resolution":2001}
    ]""")
    var warnings: seq[string]
    discard expandSpecs(specs, warnings)
    check warnings == @[
      "star points 6000 capped at 5000",
      "arc segments 10001 capped at 10000",
      "capsule segments 2501 capped at 2500",
      "path resolution 2001 capped at 2000"
    ]

  test "structural comparison reports the first divergence":
    let actual = parseJson("""{"specs":[{"points":[[0,0],[1.0,2.0]]}]}""")
    let expected = parseJson("""{"specs":[{"points":[[0,0],[1.00000001,2.0]]}]}""")
    check jsonDivergence(actual, expected) ==
      "$.specs[0].points[1][0]: actual 1.0 != expected 1.00000001"
    check jsonDivergence(parseJson("""{"a":1}"""), parseJson("""{"b":1}""")) ==
      "$.a: actual 1 != expected <missing>"

  test "matches JavaScript expandSpecs":
    for entry in parseFile(fixturePath):
      var warnings: seq[string]
      let actual = %*{
        "specs": expandSpecs(entry["input"], warnings),
        "warnings": warnings
      }
      let actualJson = parseJson($actual)
      let expectedJson = parseJson($entry["expected"])
      let divergence = jsonDivergence(actualJson, expectedJson)
      if divergence.len > 0:
        echo "geometry mismatch: ", entry["name"].getStr, " at ", divergence
      check divergence.len == 0
