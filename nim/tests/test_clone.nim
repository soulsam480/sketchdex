import std/[json, strutils, unittest]

import ../core/clone
import test_helpers

proc itemFixture(): JsonNode =
  %*[
    %*{
      "id": "rect1", "type": "rectangle", "x": 10, "y": 20, "width": 100,
      "height": 50, "index": "a0", "version": 3, "seed": 7,
      "versionNonce": 8, "updated": 1, "groupIds": ["g1"],
      "boundElements": [{"id": "text1", "type": "text"}],
      "strokeColor": "#ff0000", "backgroundColor": "#00ff00",
      "roundness": {"type": 3}, "customData": {"note": "keep"}
    },
    %*{
      "id": "text1", "type": "text", "x": 15, "y": 25, "width": 90,
      "height": 20, "index": "a1", "containerId": "rect1",
      "groupIds": ["g1"], "text": "Hello", "originalText": "Hello"
    },
    %*{
      "id": "arrow1", "type": "arrow", "x": 120, "y": 40, "width": 30,
      "height": 10, "index": "a2", "groupIds": ["g2"],
      "points": [[0, 0], [30, 10]], "roundness": {"type": 2},
      "startBinding": {"elementId": "rect1", "focus": 0.2, "gap": 4},
      "endBinding": {"elementId": "text1", "focus": -0.5, "gap": 6,
        "fixedPoint": [1, 2]},
      "boundElements": [
        {"id": "text1", "type": "text"},
        {"id": "outside", "type": "text"}
      ]
    },
    %*{
      "id": "frame1", "type": "frame", "x": 5, "y": 7, "width": 300,
      "height": 200, "index": "a3"
    },
    %*{
      "id": "child1", "type": "rectangle", "x": 30, "y": 30, "width": 20,
      "height": 20, "index": "a4", "frameId": "frame1"
    },
    %*{
      "id": "child2", "type": "rectangle", "x": 200, "y": 30, "width": 20,
      "height": 20, "index": "a5", "frameId": "outside-frame",
      "containerId": "outside-container",
      "startBinding": {"elementId": "outside-arrow", "focus": 0.5, "gap": 2}
    }
  ]

proc sceneFixture(): JsonNode =
  %*[%*{"id": "scene-rect", "index": "a9", "groupIds": ["g-scene"]}]

suite "clone library elements":
  test "identity fields are fresh and indices follow the scene maximum":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 100, 50, 1234567890)
    check cloned.elements.len == 6
    check cloned.idMap.len == 6
    let rect = cloned.elements[0]
    let text = cloned.elements[1]
    check rect["id"].getStr == cloned.idMap["rect1"].getStr
    check rect["id"].getStr != "rect1"
    check rect["seed"].getInt != 7
    check rect["version"].getInt == 4
    check rect["versionNonce"].getInt != 8
    check rect["updated"].getInt == 1234567890
    check text["version"].getInt == 1
    check rect["seed"].getInt != text["seed"].getInt
    check rect["versionNonce"].getInt != text["versionNonce"].getInt
    var previous = "a9"
    for element in cloned.elements:
      let index = element["index"].getStr
      check index > previous
      check index != "a0"
      previous = index

  test "groups survive as one map and never collide with scene groups":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 0, 0, 1)
    let rectGroup = cloned.elements[0]["groupIds"][0].getStr
    let textGroup = cloned.elements[1]["groupIds"][0].getStr
    let arrowGroup = cloned.elements[2]["groupIds"][0].getStr
    check rectGroup == textGroup
    check rectGroup != arrowGroup
    check rectGroup notin ["g1", "g-scene"]
    check arrowGroup notin ["g2", "g-scene"]

  test "bound text and its container keep a consistent new id":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 0, 0, 1)
    check cloned.elements[1]["containerId"].getStr ==
      cloned.idMap["rect1"].getStr
    check cloned.elements[2]["boundElements"][0]["id"].getStr ==
      cloned.idMap["text1"].getStr
    check cloned.elements[2]["boundElements"].len == 1

  test "arrow bindings keep focus gap and sibling fields":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 0, 0, 1)
    let arrow = cloned.elements[2]
    check arrow["startBinding"]["elementId"].getStr ==
      cloned.idMap["rect1"].getStr
    check almostEqual(arrow["startBinding"]["focus"].getFloat, 0.2)
    check arrow["startBinding"]["gap"].getInt == 4
    check arrow["endBinding"]["elementId"].getStr ==
      cloned.idMap["text1"].getStr
    check almostEqual(arrow["endBinding"]["focus"].getFloat, -0.5)
    check arrow["endBinding"]["gap"].getInt == 6
    check arrow["endBinding"]["fixedPoint"] == %*[1, 2]

  test "external references are nulled or dropped with short warnings":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 0, 0, 1)
    let outside = cloned.elements[5]
    check outside["frameId"].kind == JNull
    check outside["containerId"].kind == JNull
    check outside["startBinding"]["elementId"].kind == JNull
    check almostEqual(outside["startBinding"]["focus"].getFloat, 0.5)
    check outside["startBinding"]["gap"].getInt == 2
    check cloned.warnings.len == 4
    check cloned.warnings[0].contains("dropped boundElements entry")
    check cloned.warnings[1].contains("containerId")
    check cloned.warnings[2].contains("frameId")
    check cloned.warnings[3].contains("startBinding elementId")

  test "an internal frame id is remapped to the cloned frame":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 0, 0, 1)
    check cloned.elements[4]["frameId"].getStr ==
      cloned.idMap["frame1"].getStr

  test "only x and y are translated":
    let cloned = cloneElementsForInsert(itemFixture(), sceneFixture(), 100, 50, 1)
    let rect = cloned.elements[0]
    let frame = cloned.elements[3]
    let child = cloned.elements[4]
    check frame["x"].getInt == 100
    check frame["y"].getInt == 50
    check rect["x"].getInt == 105
    check rect["y"].getInt == 63
    check child["x"].getInt == 125
    check child["y"].getInt == 73
    check rect["width"].getInt == 100
    check rect["height"].getInt == 50
    check rect["strokeColor"].getStr == "#ff0000"
    check rect["backgroundColor"].getStr == "#00ff00"
    check rect["roundness"] == %*{"type": 3}
    check rect["customData"] == %*{"note": "keep"}
    check cloned.elements[2]["points"] == %*[[0, 0], [30, 10]]
    check cloned.elements[2]["roundness"] == %*{"type": 2}
    check cloned.elements[1]["text"].getStr == "Hello"

  test "a non-object entry is dropped and a non-finite coordinate becomes zero":
    var elements = %*[%*{"id": "one", "type": "rectangle", "x": 8, "y": 9}]
    elements.add(%42)
    var endless = newJObject()
    endless["id"] = %"two"
    endless["type"] = %"rectangle"
    endless["x"] = newJFloat(Inf)
    endless["y"] = newJFloat(NaN)
    elements.add(endless)
    let cloned = cloneElementsForInsert(elements, newJArray(), 0, 0, 1)
    check cloned.elements.len == 2
    check cloned.warnings.len == 1
    check cloned.warnings[0].contains("dropped element 1")
    check cloned.elements[0]["x"].getInt == 8
    check cloned.elements[1]["x"].getInt == 0
    check cloned.elements[1]["y"].getInt == 0

  test "duplicate source ids are refused":
    let bad = %*[
      %*{"id": "same", "type": "rectangle", "x": 0, "y": 0},
      %*{"id": "same", "type": "ellipse", "x": 0, "y": 0}
    ]
    var raised = false
    try:
      discard cloneElementsForInsert(bad, newJArray(), 0, 0, 1)
    except ValueError as error:
      raised = true
      check error.msg.contains("duplicate element id")
    check raised

  test "an empty item is refused":
    var raised = false
    try:
      discard cloneElementsForInsert(newJArray(), newJArray(), 0, 0, 1)
    except ValueError:
      raised = true
    check raised
