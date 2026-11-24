import std/[json, os, unittest]
import ../server/inspect
import ../core/jsvalue

let fixturePath = currentSourcePath().parentDir / "fixtures" / "inspect.json"

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

proc capture(elements, options: JsonNode): JsonNode =
  try:
    %*{"ok": true, "value": inspectScene(elements, options)}
  except CatchableError as error:
    %*{"ok": false, "error": error.msg}

suite "inspect":
  test "inspectScene matches the JavaScript oracle":
    let cases = parseFile(fixturePath)
    echo "inspection cases: ", cases.len
    for entry in cases:
      let actual = capture(entry["input"], entry["options"])
      let problem = divergence(parseJson($actual), entry["expected"])
      if problem.len > 0:
        echo "inspection mismatch: ", entry["name"].getStr, " at ", problem
      check problem.len == 0
