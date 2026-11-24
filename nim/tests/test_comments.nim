import std/[json, strutils, unittest]

import ../core/jsvalue
import ../server/comments

const Now = 1_800_000_000_000

proc element(extra = "{}"): JsonNode =
  parseJson("""{"id":"box","type":"rectangle","version":3,"customData":""" & extra & "}")

suite "comments on an element":
  test "the first comment creates a versioned collection and bumps the element":
    let element = element()
    let next = appendComment(element, "Check this connector.", "You", "human", Now)
    check next["version"].getInt == 4
    check next["customData"]["sketchdex"]["comments"]["schemaVersion"].getInt == 1
    let items = next["customData"]["sketchdex"]["comments"]["items"]
    check items.len == 1
    check items[0]["body"].getStr == "Check this connector."
    check items[0]["status"].getStr == "open"
    check items[0]["author"]["kind"].getStr == "human"
    check items[0]["author"]["name"].getStr == "You"
    check items[0]["id"].getStr.startsWith("cmt_")
    check countsOf(next) == (open: 1, resolved: 0)

  test "a second comment keeps the first and the original element is untouched":
    let first = appendComment(element(), "One", "You", "human", Now)
    let second = appendComment(first, "Two", "", "", Now)
    check itemsOf(second).len == 2
    check itemsOf(first).len == 1
    check itemsOf(second)[1]["author"]["name"].getStr == "Sketchdex agent"
    check itemsOf(second)[1]["author"]["kind"].getStr == "agent"

  test "resolve and reopen are idempotent":
    let withOne = appendComment(element(), "One", "You", "human", Now)
    let commentId = itemsOf(withOne)[0]["id"].getStr

    let resolved = applyAction(withOne, commentId, caResolve, Now)
    check resolved.changed
    check resolved.status == "resolved"
    check commentOf(resolved.element, commentId)["resolvedAt"].getInt == Now
    check countsOf(resolved.element) == (open: 0, resolved: 1)

    let again = applyAction(resolved.element, commentId, caResolve, Now)
    check not again.changed
    check again.element == resolved.element

    let reopened = applyAction(resolved.element, commentId, caReopen, Now)
    check reopened.changed
    check reopened.status == "open"
    check not commentOf(reopened.element, commentId).hasKey("resolvedAt")

  test "deleting the last comment removes the key but keeps other customData":
    let withOne = appendComment(element("""{"other":{"kept":true}}"""),
      "One", "You", "human", Now)
    let commentId = itemsOf(withOne)[0]["id"].getStr
    let gone = applyAction(withOne, commentId, caDelete, Now)
    check gone.changed
    check gone.status == "deleted"
    check gone.element["customData"]["other"]["kept"].getBool
    check not gone.element["customData"].hasKey("sketchdex")

  test "customData from another host survives every write":
    let withOne = appendComment(element("""{"sketchdex":{"other":1},"third":{"x":2}}"""),
      "One", "You", "human", Now)
    check withOne["customData"]["sketchdex"]["other"].getInt == 1
    check withOne["customData"]["third"]["x"].getInt == 2
    let commentId = itemsOf(withOne)[0]["id"].getStr
    let gone = applyAction(withOne, commentId, caDelete, Now)
    check gone.element["customData"]["sketchdex"]["other"].getInt == 1
    check gone.element["customData"]["third"]["x"].getInt == 2

  test "an empty body and an overlong body are refused":
    expect CommentError:
      discard appendComment(element(), "   ", "You", "human", Now)
    expect CommentError:
      discard appendComment(element(), repeat("x", BodyLimit + 1), "You", "human", Now)

  test "an unknown action and an unknown comment are refused":
    expect CommentError:
      discard parseAction("archive")
    expect CommentError:
      discard applyAction(element(), "cmt_nope", caResolve, Now)

suite "a canvas save never owns comments":
  test "comments on disk are restored into a save that dropped them":
    let disk = parseJson("""[{"id":"box","x":10,"version":5,
      "customData":{"sketchdex":{"comments":{"schemaVersion":1,
        "items":[{"id":"cmt_1","body":"Keep me","status":"open"}]}}}}]""")
    let incoming = parseJson("""[{"id":"box","x":40,"version":6}]""")
    let adopted = adoptComments(incoming, disk)
    check adopted.len == 1
    check adopted[0]["x"].getInt == 40
    check adopted[0]["version"].getInt == 6
    check itemsOf(adopted[0]).len == 1
    check itemsOf(adopted[0])[0]["body"].getStr == "Keep me"

  test "a save cannot invent a comment the file does not have":
    let disk = parseJson("""[{"id":"box","x":10,"version":5}]""")
    let incoming = parseJson("""[{"id":"box","x":40,"version":6,
      "customData":{"sketchdex":{"comments":{"schemaVersion":1,
        "items":[{"id":"cmt_1","body":"Stale","status":"open"}]}}}}]""")
    let adopted = adoptComments(incoming, disk)
    check not adopted[0].hasKey("customData")

  test "new elements and other customData pass through untouched":
    let disk = parseJson("""[{"id":"box","x":10,"version":5}]""")
    let incoming = parseJson("""[
      {"id":"box","x":40,"version":6,"customData":{"third":{"x":2}}},
      {"id":"fresh","x":0,"version":1}
    ]""")
    let adopted = adoptComments(incoming, disk)
    check adopted.len == 2
    check adopted[0]["customData"]["third"]["x"].getInt == 2
    check adopted[1]["id"].getStr == "fresh"
