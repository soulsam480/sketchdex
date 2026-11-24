import std/[json, os, tempfiles, unittest]

import ../server/agent

suite "searching a scene":
  var api: AgentApi
  var sceneId, boxId, ellipseId, noteId: string

  setup:
    let vault = createTempDir("sketchdex-search-", "", getTempDir())
    api = newAgentApi(vault)
    let created = api.createScene("Search", %*[
      %*{"type": "rectangle", "x": 0, "y": 0, "width": 240, "height": 100,
         "label": "Auth service"},
      %*{"type": "ellipse", "x": 300, "y": 0, "width": 220, "height": 100,
         "label": "Token store"},
      %*{"type": "text", "x": 0, "y": 200,
         "text": "Release notes for the connector"}
    ])
    sceneId = created["sceneId"].getStr
    for element in created["elements"]:
      case element["type"].getStr
      of "rectangle": boxId = element["id"].getStr
      of "ellipse": ellipseId = element["id"].getStr
      of "text": noteId = element["id"].getStr
      else: discard

  teardown:
    removeDir(api.vault.root)

  test "a label finds the shape it belongs to, not the label element":
    let found = api.searchElements(sceneId, "auth", %*{})
    check found["matched"].getInt == 1
    check found["results"][0]["id"].getStr == boxId
    check found["results"][0]["type"].getStr == "rectangle"
    check found["results"][0]["text"].getStr == "Auth service"
    check found["results"][0]["match"].getStr == "text"

  test "the query is case insensitive and every word must appear":
    check api.searchElements(sceneId, "AUTH SERVICE", %*{})["matched"].getInt == 1
    check api.searchElements(sceneId, "auth nothing", %*{})["matched"].getInt == 0

  test "tokens may be spread across the label and a comment":
    discard api.addComment(sceneId, boxId, "Check the connector wiring.",
      "note about the wiring")
    let found = api.searchElements(sceneId, "auth connector", %*{})
    check found["matched"].getInt == 1
    check found["results"][0]["id"].getStr == boxId
    check found["results"][0]["match"].getStr == "element"

  test "a comment body finds the element carrying it":
    discard api.addComment(sceneId, ellipseId, "This token lives too long.",
      "note on the token")
    let found = api.searchElements(sceneId, "lives too long", %*{})
    check found["matched"].getInt == 1
    check found["results"][0]["id"].getStr == ellipseId
    check found["results"][0]["match"].getStr == "comment"
    check found["results"][0]["snippet"].getStr == "This token lives too long."

  test "an id matches by its own value":
    let found = api.searchElements(sceneId, noteId, %*{})
    check found["matched"].getInt == 1
    check found["results"][0]["id"].getStr == noteId
    check found["results"][0]["match"].getStr == "id"

  test "an exact label outranks a longer sentence":
    let found = api.searchElements(sceneId, "token", %*{})
    check found["results"][0]["id"].getStr == ellipseId
    check found["results"][0]["match"].getStr == "text"

  test "type narrows the results":
    check api.searchElements(sceneId, "the", %*{"type": "text"})["matched"].getInt == 1
    let ellipses = api.searchElements(sceneId, "token", %*{"type": "ellipse"})
    check ellipses["matched"].getInt == 1

  test "limit and truncated agree":
    let found = api.searchElements(sceneId, "e", %*{"limit": 1})
    check found["results"].len == 1
    check found["matched"].getInt > 1
    check found["truncated"].getBool

  test "full hands back the raw elements":
    let found = api.searchElements(sceneId, "auth", %*{"full": true})
    let element = found["results"][0]
    check element["id"].getStr == boxId
    check element.hasKey("version")
    check element.hasKey("seed")

  test "an empty query is refused":
    expect AgentError:
      discard api.searchElements(sceneId, "   ", %*{})
