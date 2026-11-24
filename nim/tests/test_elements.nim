import std/[json, math, os, osproc, sets, strutils, tables]
import unittest

import ../core/[elements, jsvalue, random_ids, textmetrics]

const Now = 1_700_000_000_123'i64

const oracleScript = r"""
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const { buildElements, patchElement, growContainerFor } = await import(
  pathToFileURL(resolve(repo, "server/elements.js")).href
);
const Now = 1700000000123;
let state = 0x6d2b79f5;
Math.random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const labelGeometry = (index) => [
  `$.elements[${index}].x`,
  `$.elements[${index}].y`,
  `$.elements[${index}].width`,
  `$.elements[${index}].height`,
  `$.elements[${index}].measured`
];
const linearGeometry = (index) => [
  `$.elements[${index}].x`,
  `$.elements[${index}].y`,
  `$.elements[${index}].width`,
  `$.elements[${index}].height`,
  `$.elements[${index}].points`,
  `$.elements[${index}].lastCommittedPoint`
];

const existing = [
  {
    id: "existing-box",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    index: "a0",
    version: 3,
    seed: 7,
    versionNonce: 11,
    boundElements: [{ id: "old-arrow", type: "arrow" }]
  },
  {
    id: "deleted-box",
    type: "rectangle",
    x: 400,
    y: 0,
    width: 100,
    height: 80,
    index: "a1",
    isDeleted: true,
    version: 2,
    boundElements: []
  }
];

const fixedText = {
  id: "fixed-text",
  type: "text",
  x: 0,
  y: 40,
  width: 100,
  height: 25,
  index: "a1",
  version: 2,
  seed: 17,
  versionNonce: 19,
  updated: 23,
  fontSize: 20,
  fontFamily: 5,
  text: "fixed words",
  originalText: "fixed words",
  textAlign: "left",
  verticalAlign: "top",
  containerId: null,
  autoResize: false,
  lineHeight: 1.25,
  boundElements: []
};

const box = {
  id: "box",
  type: "rectangle",
  x: 10,
  y: 20,
  width: 120,
  height: 60,
  index: "a0",
  version: 3,
  seed: 7,
  versionNonce: 11,
  updated: 13,
  boundElements: [{ id: "label", type: "text" }]
};

const cases = [
  {
    name: "bare-rectangle",
    op: "build",
    args: { specs: [{ type: "rectangle" }] },
  },
  {
    name: "full-element-copied",
    op: "build",
    args: {
      specs: [{
        type: "rectangle",
        id: "chosen-id",
        index: "a9z",
        x: -2.5,
        y: 1e-9,
        width: 1e9,
        height: 0.5,
        angle: 359.9,
        strokeColor: "#123456",
        backgroundColor: "#abcdef",
        fillStyle: "hachure",
        strokeWidth: 5,
        strokeStyle: "dotted",
        roughness: 0,
        opacity: 42,
        groupIds: ["g1", "g2"],
        frameId: "frame-1",
        roundness: null,
        seed: 7,
        version: 9,
        versionNonce: 11,
        isDeleted: false,
        boundElements: [{ id: "kept", type: "text" }],
        updated: 13,
        link: "https://example.com",
        locked: true,
        customField: { nested: [1, null, false] }
      }]
    }
  },
  {
    name: "explicit-index-then-implicit-with-deleted-existing",
    op: "build",
    args: {
      specs: [{ type: "rectangle", index: "a9z" }, { type: "ellipse" }],
      existing: [{ id: "deleted", type: "rectangle", index: "a2", isDeleted: true }]
    },
  },
  {
    name: "label-font-override",
    op: "build",
    args: {
      specs: [{
        type: "rectangle",
        width: 160,
        height: 80,
        fontSize: 20,
        fontFamily: 5,
        opacity: 37,
        label: { text: "Hello", fontSize: 40, fontFamily: 1, opacity: 99 }
      }]
    },
    computed: labelGeometry(1)
  },
  {
    name: "label-font-inherited",
    op: "build",
    args: {
      specs: [{
        type: "rectangle",
        width: 160,
        height: 80,
        fontSize: 20,
        fontFamily: 5,
        label: "Inherited"
      }]
    },
    computed: labelGeometry(1)
  },
  {
    name: "label-opacity-parent-absent",
    op: "build",
    args: {
      specs: [{ type: "rectangle", width: 160, height: 80, label: { text: "Opacity", opacity: 99 } }]
    },
    computed: labelGeometry(1)
  },
  {
    name: "label-opacity-parent-42",
    op: "build",
    args: {
      specs: [{ type: "rectangle", width: 160, height: 80, opacity: 42, label: { text: "Opacity", opacity: 99 } }]
    },
    computed: labelGeometry(1)
  },
  {
    name: "label-opacity-parent-null",
    op: "build",
    args: {
      specs: [{ type: "rectangle", width: 160, height: 80, opacity: null, label: { text: "Opacity", opacity: 99 } }]
    },
    computed: labelGeometry(1)
  },
  {
    name: "diamond-label-width",
    op: "build",
    args: { specs: [{ type: "diamond", width: 100, height: 10, label: "one\ntwo" }] },
    computed: ["$.elements[0].height", ...labelGeometry(1)]
  },
  {
    name: "ellipse-label-width",
    op: "build",
    args: { specs: [{ type: "ellipse", width: 100, height: 10, label: "one\ntwo" }] },
    computed: ["$.elements[0].height", ...labelGeometry(1)]
  },
  {
    name: "two-labelled-shapes-preserve-order-and-indexes",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", id: "first-shape", width: 140, label: "First" },
        { type: "ellipse", id: "second-shape", width: 140, label: "Second" }
      ],
      existing: [{ id: "old", type: "rectangle", index: "a0" }]
    },
    computed: [...labelGeometry(1), ...labelGeometry(3)]
  },
  {
    name: "arrow-start-ref-end-existing",
    op: "build",
    args: {
      specs: [
        { type: "arrow", ref: "shaft", start: "left", end: "existing-box" },
        { type: "rectangle", ref: "left", id: "left-box" }
      ],
      existing
    },
    computed: linearGeometry(0)
  },
  {
    name: "reverse-binding-accumulates-in-spec-order",
    op: "build",
    args: {
      specs: [
        { type: "arrow", start: "existing-box", end: "existing-box" },
        { type: "arrow", start: "existing-box" }
      ],
      existing
    },
    computed: [linearGeometry(0), linearGeometry(1)]
  },
  {
    name: "binding-to-deleted-existing-warns",
    op: "build",
    args: { specs: [{ type: "arrow", start: "deleted-box" }], existing },
    computed: linearGeometry(0)
  },
  {
    name: "ref-precedes-built-id",
    op: "build",
    args: {
      specs: [
        { type: "rectangle", ref: "named", id: "first-id" },
        { type: "ellipse", id: "named" },
        { type: "arrow", start: "named" }
      ]
    },
    computed: linearGeometry(2)
  },
  {
    name: "text-wrap-and-original-text",
    op: "build",
    args: {
      specs: [{
        type: "text",
        text: "one two three four five",
        width: 55,
        fontSize: 20,
        fontFamily: 5
      }]
    },
    computed: ["$.elements[0].height", "$.elements[0].measured"]
  },
  {
    name: "line-point-normalisation",
    op: "build",
    args: {
      specs: [{ type: "line", x: 7, y: 8, points: [[10, 20], [30, 40], [10, 50]] }]
    },
    computed: linearGeometry(0)
  },
  {
    name: "freedraw-point-normalisation",
    op: "build",
    args: {
      specs: [{
        type: "freedraw",
        x: 3,
        y: 4,
        points: [[10, 20], [15, 25], [20, 20]],
        pressures: [0.1, 0.5, 0.9],
        simulatePressure: false
      }]
    },
    computed: linearGeometry(0)
  },
  {
    name: "polygon-and-star-through-expand-specs",
    op: "build",
    args: {
      specs: [
        { type: "polygon", sides: 7, cx: 20, cy: 30, rx: 40, ry: 25, rotation: 15, id: "poly" },
        { type: "star", points: 5, r: 50, innerR: 20, id: "star" }
      ]
    },
    computed: [
      "$.elements[0].x", "$.elements[0].y", "$.elements[0].width", "$.elements[0].height", "$.elements[0].points",
      "$.elements[1].x", "$.elements[1].y", "$.elements[1].width", "$.elements[1].height", "$.elements[1].points"
    ]
  },
  {
    name: "unknown-type-passthrough-warning",
    op: "build",
    args: { specs: [{ type: "image", x: 3, fileId: "asset" }, { type: "future-widget", width: 12 }] },
  },
  {
    name: "null-and-non-object-specs",
    op: "build",
    args: { specs: [null, false, 0, "rectangle", [], { type: "rectangle" }] },
  },
  {
    name: "null-spec-list",
    op: "build",
    args: { specs: null }
  },
  {
    name: "empty-existing-succeeds",
    op: "build",
    args: { specs: [{ type: "rectangle" }], existing: [] }
  },
  {
    name: "fractional-font-family-stays-numeric",
    op: "build",
    args: { specs: [{ type: "text", text: "Agil 0123", fontFamily: 5.5, width: 90 }] },
    computed: ["$.elements[0].height", "$.elements[0].measured"]
  },
  {
    name: "native-defaults",
    op: "build",
    args: {
      specs: [
        { type: "rectangle" },
        { type: "ellipse" },
        { type: "diamond" },
        { type: "arrow" },
        { type: "line" },
        { type: "text", text: "hello" },
        { type: "freedraw" },
        { type: "frame" }
      ]
    },
    computed: [
      linearGeometry(3), linearGeometry(4), linearGeometry(6),
      "$.elements[5].width", "$.elements[5].height", "$.elements[5].measured"
    ]
  },
  {
    name: "false-and-zero-labels-are-present",
    op: "build",
    args: { specs: [{ type: "rectangle", label: false }, { type: "ellipse", label: 0 }] },
    computed: [...labelGeometry(1), ...labelGeometry(3)]
  },
  {
    name: "frame-label-becomes-name",
    op: "build",
    args: { specs: [{ type: "frame", label: "Frame title" }] },
  },
  {
    name: "patch-bumps-version-nonce-updated",
    op: "patch",
    args: {
      element: { id: "box", type: "rectangle", index: "a0", version: 3, versionNonce: 11, seed: 7, updated: 13, x: 1 },
      patch: { x: 2 }
    },
  },
  {
    name: "patch-skips-id-invalid-index-and-wrap",
    op: "patch",
    args: {
      element: { id: "box", type: "rectangle", index: "a0", version: 3, versionNonce: 11, seed: 7, updated: 13 },
      patch: { id: "replacement", index: "not valid", wrap: 25, custom: true }
    },
  },
  {
    name: "patch-rewraps-text",
    op: "patch",
    args: { element: fixedText, patch: { text: "one two three four five", width: 55 } },
    computed: ["$.height"]
  },
  {
    name: "patch-rewraps-from-original-text",
    op: "patch",
    args: {
      element: { ...fixedText, text: "wrapped\ntext", originalText: "original words" },
      patch: { fontSize: 28 }
    },
    computed: ["$.height"]
  },
  {
    name: "patch-version-string-concatenates",
    op: "patch",
    args: {
      element: { id: "box", type: "rectangle", index: "a0", version: "3", versionNonce: 11, seed: 7, updated: 13 },
      patch: { x: 2 }
    },
  },
  {
    name: "grow-rectangle",
    op: "grow",
    args: {
      text: { id: "label", type: "text", containerId: "box", height: 75 },
      container: box
    },
    computed: ["$.height"]
  },
  {
    name: "grow-no-op-when-it-fits",
    op: "grow",
    args: {
      text: { id: "label", type: "text", containerId: "box", height: 25 },
      container: box
    },
    sameContainer: true
  },
  {
    name: "grow-no-op-on-mismatched-container",
    op: "grow",
    args: {
      text: { id: "label", type: "text", containerId: "other", height: 75 },
      container: box
    },
    sameContainer: true
  },
  {
    name: "grow-no-op-on-null-text",
    op: "grow",
    args: { text: null, container: box },
    sameContainer: true
  },
  {
    name: "grow-diamond",
    op: "grow",
    args: {
      text: { id: "label", type: "text", containerId: "diamond", height: 75 },
      container: { ...box, id: "diamond", type: "diamond" }
    },
    computed: ["$.height"]
  },
  {
    name: "grow-ellipse",
    op: "grow",
    args: {
      text: { id: "label", type: "text", containerId: "ellipse", height: 75 },
      container: { ...box, id: "ellipse", type: "ellipse" }
    },
    computed: ["$.height"]
  }
];

const output = [];
for (const entry of cases) {
  Date.now = () => entry.now ?? Now;
  let expected;
  if (entry.op === "build") {
    const options = {};
    if (entry.args.existing !== undefined) options.existing = entry.args.existing;
    if (entry.args.ink !== undefined) options.ink = entry.args.ink;
    expected = buildElements(entry.args.specs, options);
  } else if (entry.op === "patch") {
    expected = patchElement(entry.args.element, entry.args.patch);
  } else {
    expected = growContainerFor(entry.args.text, entry.args.container);
  }
  output.push({ ...entry, expected });
}
const patchNullResults = [];
for (const element of [
  { id: "box", type: "rectangle", version: 3 },
  { id: "txt", type: "text", version: 2, text: "x", originalText: "x" }
]) {
  for (const [name, patch] of [["null", null], ["missing", undefined]]) {
    try {
      patchElement(element, patch);
      patchNullResults.push({ name, throws: false });
    } catch (error) {
      patchNullResults.push({ name, throws: true, error: error.name });
    }
  }
}
const existingResults = [];
for (const [name, existing] of [["null", null], ["object", {}], ["string", "scene"], ["number", 7]]) {
  try {
    buildElements([{ type: "rectangle" }], { existing });
    existingResults.push({ name, existing, throws: false });
  } catch (error) {
    existingResults.push({ name, existing, throws: true, error: error.name });
  }
}
console.log(JSON.stringify({ cases: output, patchNullResults, existingResults }));
"""

proc parsePath(path: string): seq[string] =
  result = @["$"]
  var i = 1
  while i < path.len:
    if path[i] == '.':
      i += 1
      let start = i
      while i < path.len and path[i] notin {'.', '['}: i += 1
      result.add(path[start ..< i])
    elif path[i] == '[':
      i += 1
      let start = i
      while i < path.len and path[i] != ']': i += 1
      result.add(path[start ..< i])
      if i < path.len: i += 1
    else:
      raise newException(ValueError, "invalid comparison path: " & path)

proc matchesPath(patterns: seq[string]; path: seq[string]): bool =
  for pattern in patterns:
    let wanted = parsePath(pattern)
    if wanted.len > path.len: continue
    var matched = true
    for i in 0 ..< wanted.len:
      if wanted[i] != "*" and wanted[i] != path[i]:
        matched = false
        break
    if matched: return true
  false

proc collectInputIds(node: JsonNode; ids: var HashSet[string]) =
  if node.isNil: return
  if node.kind == JObject:
    for key, value in node:
      if key == "id" and value.kind == JString: ids.incl(value.getStr)
      collectInputIds(value, ids)
  elif node.kind == JArray:
    for value in node: collectInputIds(value, ids)

proc validGeneratedId(id: string): bool =
  if id.len != 21: return false
  for ch in id:
    if ch notin {'0' .. '9', 'A' .. 'Z', 'a' .. 'z', '_', '-'}: return false
  true

proc replaceIds(node: JsonNode; replacements: Table[string, string]) =
  if node.isNil: return
  case node.kind
  of JString:
    let id = node.getStr
    if replacements.hasKey(id): node.str = replacements[id]
  of JArray:
    for value in node: replaceIds(value, replacements)
  of JObject:
    for key, value in node: replaceIds(value, replacements)
  else: discard

proc canonicaliseIds(actual, expected, args: JsonNode) =
  var inputIds: HashSet[string]
  collectInputIds(args, inputIds)
  if not expected.hasField("elements"): return
  let actualElements = actual["elements"]
  let expectedElements = expected["elements"]
  if actualElements.len != expectedElements.len:
    raise newException(ValueError, "element count differs before id validation")
  var actualReplacements: Table[string, string]
  var expectedReplacements: Table[string, string]
  var seen: HashSet[string]
  for i in 0 ..< expectedElements.len:
    let wantedId = expectedElements[i].field("id")
    let gotId = actualElements[i].field("id")
    if wantedId.kind == JString and wantedId.getStr notin inputIds:
      if gotId.kind != JString or not validGeneratedId(gotId.getStr):
        raise newException(ValueError, "invalid generated id at element " & $i)
      let id = gotId.getStr
      if id in inputIds or id in seen:
        raise newException(ValueError, "generated id collided at element " & $i)
      seen.incl(id)
      let canonical = "generated-" & $i
      actualReplacements[id] = canonical
      expectedReplacements[wantedId.getStr] = canonical
  replaceIds(actual, actualReplacements)
  replaceIds(expected, expectedReplacements)

proc normaliseRandom(actual, expected: JsonNode) =
  if actual.kind == JObject and expected.kind == JObject:
    for key in ["seed", "versionNonce"]:
      if not expected.hasKey(key): continue
      if not actual.hasKey(key):
        raise newException(ValueError, "missing random field: " & key)
      let value = actual[key]
      if value.kind != JInt or value.getInt < 0 or value.getInt >= 2_147_483_648:
        raise newException(ValueError, "random field is outside the nonce range: " & key)
      actual.delete(key)
      expected.delete(key)
    for key, value in expected:
      normaliseRandom(actual[key], value)
  elif actual.kind == JArray and expected.kind == JArray:
    for i in 0 ..< expected.len:
      if i < actual.len: normaliseRandom(actual[i], expected[i])

proc nodeText(node: JsonNode): string =
  if node.isNil: "<missing>" else: $node

proc mismatch(actual, expected: JsonNode; path: string): string =
  path & ": actual " & nodeText(actual) & " != expected " & nodeText(expected)

proc exactNumbers(actual, expected: JsonNode): bool =
  if actual.kind == JInt and expected.kind == JInt:
    return actual.getInt == expected.getInt
  let a = actual.getFloat
  let b = expected.getFloat
  if a.classify in {fcNan, fcInf, fcNegInf} or
      b.classify in {fcNan, fcInf, fcNegInf}:
    return false
  a == b

proc jsonDivergence(actual, expected: JsonNode; path: seq[string] = @["$"];
    computed: seq[string] = @[]): string =
  let location = path.join(".")
  if actual.isNil or expected.isNil:
    if actual.isNil and expected.isNil: return ""
    return mismatch(actual, expected, location)
  if actual.kind != expected.kind:
    if not (actual.isNumber and expected.isNumber):
      return mismatch(actual, expected, location)
  if actual.isNumber and expected.isNumber:
    if matchesPath(computed, path):
      let a = actual.getFloat
      let b = expected.getFloat
      let scale = max(abs(a), abs(b))
      if abs(a - b) <= 1e-9 * scale: return ""
      return mismatch(actual, expected, location)
    if exactNumbers(actual, expected): return ""
    return mismatch(actual, expected, location)
  case actual.kind
  of JObject:
    for key, value in actual:
      if not expected.hasKey(key): return mismatch(value, nil, location & "." & key)
    for key, value in expected:
      if not actual.hasKey(key): return mismatch(nil, value, location & "." & key)
    for key, value in actual:
      let divergence = jsonDivergence(value, expected[key], path & @[key], computed)
      if divergence.len > 0: return divergence
  of JArray:
    if actual.len != expected.len: return mismatch(actual, expected, location)
    for i in 0 ..< actual.len:
      let divergence = jsonDivergence(actual[i], expected[i], path & @[$i], computed)
      if divergence.len > 0: return divergence
  else:
    if actual != expected: return mismatch(actual, expected, location)
  ""

proc stringArray(node: JsonNode): seq[string] =
  if node.isNil: return @[]
  for value in node: result.add(value.getStr)

proc runOperation(entry: JsonNode): JsonNode =
  let args = entry["args"]
  let now = if entry.hasField("now"): int64(entry["now"].getInt) else: Now
  case entry["op"].getStr
  of "build":
    let existing = if args.hasField("existing"): args["existing"] else: newJArray()
    let ink = if args.hasField("ink"): args["ink"].getStr else: "#1e1e1e"
    buildElements(args["specs"], existing, ink, now)
  of "patch":
    patchElement(args["element"], args["patch"], now)
  of "grow":
    growContainerFor(args["text"], args["container"], now)
  else:
    raise newException(ValueError, "unknown operation")

proc loadOracle(): JsonNode =
  let repo = getCurrentDir()
  let scriptPath = joinPath(getTempDir(), "sketchdex-elements-oracle-" & $getCurrentProcessId() & ".mjs")
  writeFile(scriptPath, oracleScript)
  try:
    let output = execProcess("node", args = [scriptPath, repo], options = {poUsePath})
    parseJson(output)
  finally:
    removeFile(scriptPath)

proc checkSpecialCases(entry, actual, expected: JsonNode) =
  let name = entry["name"].getStr
  case name
  of "label-font-override":
    let label = actual["elements"][1]
    let wanted = entry["args"]["specs"][0]["label"]
    check exactNumbers(label["fontSize"], wanted["fontSize"])
    check exactNumbers(label["fontFamily"], wanted["fontFamily"])
    check exactNumbers(label["opacity"], entry["args"]["specs"][0]["opacity"])
  of "label-font-inherited":
    let label = actual["elements"][1]
    let parent = entry["args"]["specs"][0]
    check exactNumbers(label["fontSize"], parent["fontSize"])
    check exactNumbers(label["fontFamily"], parent["fontFamily"])
  of "label-opacity-parent-absent":
    check actual["elements"][1]["opacity"] == expected["elements"][1]["opacity"]
    check actual["elements"][1]["opacity"] == newJInt(100)
  of "label-opacity-parent-42":
    check actual["elements"][1]["opacity"] == expected["elements"][1]["opacity"]
    check actual["elements"][1]["opacity"] == newJInt(42)
  of "label-opacity-parent-null":
    check actual["elements"][1]["opacity"] == expected["elements"][1]["opacity"]
    check actual["elements"][1]["opacity"].kind == JNull
  of "two-labelled-shapes-preserve-order-and-indexes":
    check actual["elements"].len == 4
    for i, kind in ["rectangle", "text", "ellipse", "text"]:
      check actual["elements"][i]["type"] == %kind
    check actual["elements"][0]["boundElements"][0]["id"] == actual["elements"][1]["id"]
    check actual["elements"][2]["boundElements"][0]["id"] == actual["elements"][3]["id"]
  of "reverse-binding-accumulates-in-spec-order":
    check actual["updated"].len == 1
    check actual["updated"][0]["version"] == expected["updated"][0]["version"]
    check actual["updated"][0]["boundElements"].len ==
      expected["updated"][0]["boundElements"].len
  of "binding-to-deleted-existing-warns":
    check actual["updated"].len == 0
    check actual["warnings"] == expected["warnings"]
  of "ref-precedes-built-id":
    check actual["elements"][2]["startBinding"]["elementId"] == %"first-id"
  of "text-wrap-and-original-text":
    check actual["elements"][0]["originalText"] == entry["args"]["specs"][0]["text"]
    check actual["elements"][0]["text"] == expected["elements"][0]["text"]
  of "fractional-font-family-stays-numeric":
    check actual["elements"][0]["fontFamily"].kind == JFloat
    check actual["elements"][0]["fontFamily"].getFloat == 5.5
  of "patch-skips-id-invalid-index-and-wrap":
    check actual["id"] == %"box"
    check actual["index"] == %"a0"
    check not actual.hasField("wrap")
  of "grow-no-op-when-it-fits", "grow-no-op-on-mismatched-container",
      "grow-no-op-on-null-text":
    let container = entry["args"]["container"]
    check cast[pointer](actual) == cast[pointer](container)
  else: discard

discard loadMetrics("server/font-metrics.json")
random_ids.seedRng(0x5eed_c0de)

let oracle = loadOracle()

suite "elements JavaScript parity":
  abortOnError = true
  for entry in oracle["cases"]:
    test entry["name"].getStr:
      let expected = copyNode(entry["expected"])
      let actual = runOperation(entry)
      canonicaliseIds(actual, expected, entry["args"])
      normaliseRandom(actual, expected)
      let divergence = jsonDivergence(actual, expected,
        computed = stringArray(entry.field("computed")))
      if divergence.len > 0:
        echo entry["name"].getStr, " mismatch: ", divergence
      check divergence.len == 0
      checkSpecialCases(entry, actual, expected)

  test "null and missing patches throw as in JavaScript":
    for index in 0 ..< oracle["patchNullResults"].len:
      let result = oracle["patchNullResults"][index]
      check result["throws"].getBool
      check result["error"] == %"TypeError"
      let element = if index < 2:
        %*{"id": "box", "type": "rectangle", "version": 3}
      else:
        %*{"id": "txt", "type": "text", "version": 2, "text": "x", "originalText": "x"}
      let patch = if index mod 2 == 0: newJNull() else: nil
      expect ValueError:
        discard patchElement(element, patch, Now)

  test "missing existing succeeds like an empty array":
    var expected: JsonNode
    for entry in oracle["cases"]:
      if entry["name"].getStr == "empty-existing-succeeds":
        expected = copyNode(entry["expected"])
    check not expected.isNil
    let specs = parseJson("""[{"type":"rectangle"}]""")
    let actual = buildElements(specs, nil, "#1e1e1e", Now)
    canonicaliseIds(actual, expected, %*{"specs": specs})
    normaliseRandom(actual, expected)
    check jsonDivergence(actual, expected).len == 0

  test "non-iterable existing values throw":
    for result in oracle["existingResults"]:
      check result["throws"].getBool
      check result["error"] == %"TypeError"
      expect ValueError:
        discard buildElements(parseJson("""[{"type":"rectangle"}]"""),
          result["existing"], "#1e1e1e", Now)

echo "PASS"
