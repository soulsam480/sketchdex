import std/[base64, json, os, strutils, tempfiles, unittest]

import ../mcp/rpc
import ../mcp/[tools, docs]
import ../server/agent

const
  PackageJson = staticRead("../../package.json")
  repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))

type
  FakeAgent = ref object
    calls: seq[tuple[name: string, args: JsonNode]]
    failure: string

proc record(api: FakeAgent; name: string; args: JsonNode): JsonNode =
  api.calls.add((name, args))
  if api.failure.len > 0:
    raise newException(ValueError, api.failure)
  %*{"op": name, "args": if args.isNil: newJNull() else: args}

proc listScenes(api: FakeAgent): JsonNode =
  api.record("list_scenes", newJObject())

proc describeScene(api: FakeAgent; idOrName: string; limit = 400;
    typeFilter: string = ""): JsonNode =
  api.record("describe_scene", %*{
    "scene": idOrName, "limit": limit, "type": typeFilter,
  })

proc readScene(api: FakeAgent; idOrName: string; options: JsonNode = nil): JsonNode =
  api.record("read_scene", options)

proc readElements(api: FakeAgent; idOrName: string; options: JsonNode): JsonNode =
  api.record("read_elements", options)

proc searchElements(api: FakeAgent; idOrName, query: string; args: JsonNode): JsonNode =
  api.record("search_elements", args)

proc createScene(api: FakeAgent; name = "Untitled"; elements: JsonNode = nil): JsonNode =
  api.record("create_scene", %*{"name": name, "elements": elements})

proc addElements(api: FakeAgent; idOrName: string; elements: JsonNode;
    label: string): JsonNode =
  api.record("add_elements", %*{
    "scene": idOrName, "elements": elements, "label": label,
  })

proc updateElements(api: FakeAgent; idOrName: string; patches: JsonNode;
    label: string; ids: JsonNode = nil; patch: JsonNode = nil): JsonNode =
  api.record("update_elements", %*{
    "scene": idOrName, "elements": patches, "label": label,
    "ids": ids, "patch": patch,
  })

proc deleteElements(api: FakeAgent; idOrName: string; ids: JsonNode;
    label: string): JsonNode =
  api.record("delete_elements", %*{
    "scene": idOrName, "ids": ids, "label": label,
  })

proc moveElements(api: FakeAgent; idOrName: string; args: JsonNode;
    label: string): JsonNode =
  api.record("move_elements", args)

proc replaceElements(api: FakeAgent; idOrName: string; elements: JsonNode;
    label: string): JsonNode =
  api.record("replace_scene", %*{
    "scene": idOrName, "elements": elements, "label": label,
  })

proc setBackground(api: FakeAgent; idOrName, color, label: string): JsonNode =
  api.record("set_background", %*{
    "scene": idOrName, "color": color, "label": label,
  })

proc snapshotScene(api: FakeAgent; idOrName, label: string): JsonNode =
  api.record("snapshot_scene", %*{"scene": idOrName, "label": label})

proc importSvg(api: FakeAgent; idOrName, svg: string; options: JsonNode;
    label: string): JsonNode =
  api.record("import_svg", options)

proc checkScene(api: FakeAgent; idOrName: string): JsonNode =
  api.record("check_scene", %*{"scene": idOrName})

proc listHistory(api: FakeAgent; idOrName: string): JsonNode =
  api.record("list_history", %*{"scene": idOrName})

proc restoreSnapshot(api: FakeAgent; idOrName, snapId: string): JsonNode =
  api.record("restore_snapshot", %*{"scene": idOrName, "snapshot": snapId})

proc addComment(api: FakeAgent; idOrName, elementId, body, label: string;
    authorName = "", authorKind = ""): JsonNode =
  api.record("add_comment", %*{
    "scene": idOrName, "elementId": elementId, "body": body, "label": label,
    "author": authorName, "authorKind": authorKind,
  })

proc listComments(api: FakeAgent; idOrName, elementId, status: string;
    limit = 500): JsonNode =
  api.record("list_comments", %*{
    "scene": idOrName, "elementId": elementId, "status": status, "limit": limit,
  })

proc updateComment(api: FakeAgent; idOrName, elementId, commentId, action,
    label: string): JsonNode =
  api.record("update_comment", %*{
    "scene": idOrName, "elementId": elementId, "commentId": commentId,
    "action": action, "label": label,
  })

proc decode(body: string): JsonNode =
  check body.len > 0
  parseJson(body)

proc rpc(body: string): JsonNode =
  decode(handleMcpRequest(body))

proc request(id: JsonNode; methodName: string; params: JsonNode = nil): string =
  var message = %*{"jsonrpc": "2.0", "id": id, "method": methodName}
  if not params.isNil:
    message["params"] = params
  $message

proc errorCode(response: JsonNode): int =
  response["error"]["code"].getInt

proc isPng(data: string): bool =
  data.len > 24 and data[0 .. 7] == "\x89PNG\r\n\x1a\n"

let echoDispatcher: ToolDispatcher = proc(name: string, args: JsonNode): JsonNode =
  %*{"tool": name, "args": args}

suite "MCP JSON-RPC":
  test "parse errors use the JSON-RPC error envelope":
    let response = rpc("{")
    check response["jsonrpc"].getStr == "2.0"
    check response["id"].kind == JNull
    check errorCode(response) == ParseErrorCode
    check response["error"]["message"].getStr == "Parse error"

  test "invalid requests return a null id":
    let invalid = [
      "null",
      "[]",
      "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}",
      "{\"jsonrpc\":\"2.0\",\"id\":1}",
      "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}",
      "{\"jsonrpc\":\"2.0\",\"id\":true,\"method\":\"ping\"}",
      "{\"jsonrpc\":\"2.0\",\"id\":1.5,\"method\":\"ping\"}",
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"extra\":true}",
    ]
    for body in invalid:
      let response = rpc(body)
      check response["id"].kind == JNull
      check errorCode(response) == InvalidRequestCode
      check response["error"]["message"].getStr == "Invalid Request"

  test "string and integer ids are preserved":
    for id in [newJString("request-1"), newJInt(0), newJInt(-7), newJInt(42)]:
      let response = rpc(request(id, "ping"))
      check response["id"] == id
      check response["result"] == newJObject()
    let response = rpc("{\"jsonrpc\":\"2.0\",\"id\":1.0,\"method\":\"ping\"}")
    check response["id"] == newJInt(1)

  test "notifications produce no response":
    check handleMcpRequest(
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}") == ""
    check handleMcpRequest(
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/unknown\"}") == ""
    check handleMcpRequest("{\"jsonrpc\":\"2.0\",\"method\":\"ping\"}") == ""

  test "batches omit notifications and report each invalid item":
    let response = rpc(
      "[{\"jsonrpc\":\"2.0\",\"id\":\"one\",\"method\":\"ping\"}," &
      "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}," &
      "{\"jsonrpc\":\"2.0\",\"id\":false,\"method\":\"ping\"}," &
      "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"missing\"}]")
    check response.kind == JArray
    check response.len == 3
    check response[0]["id"].getStr == "one"
    check response[1]["id"].kind == JNull
    check errorCode(response[1]) == InvalidRequestCode
    check response[2]["id"].getInt == 2
    check errorCode(response[2]) == MethodNotFoundCode
    check handleMcpRequest(
      "[{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}]") == ""

  test "client responses are ignored":
    check handleMcpRequest(
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}") == ""
    check handleMcpRequest(
      "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":0,\"message\":\"x\"}}") == ""

  test "unknown methods use the Node message and code":
    let response = rpc(request(newJInt(9), "unknown/method"))
    check errorCode(response) == MethodNotFoundCode
    check response["error"]["message"].getStr == "Method not found"

  test "invalid method params use the JSON-RPC invalid params code":
    let invalid = [
      request(newJInt(1), "initialize"),
      request(newJInt(2), "initialize", %*{
        "protocolVersion": 1, "capabilities": {}, "clientInfo": {},
      }),
      request(newJInt(3), "ping", newJArray()),
      request(newJInt(4), "tools/call", %*{}),
      request(newJInt(5), "tools/call", %*{"name": "list_scenes", "arguments": []}),
      request(newJInt(6), "resources/read", %*{}),
    ]
    for body in invalid:
      let response = rpc(body)
      check errorCode(response) == InvalidParamsCode
      check response["id"].kind != JNull

  test "initialize negotiates every version accepted by Node":
    let version = parseJson(PackageJson)["version"].getStr
    for protocolVersion in SupportedProtocolVersions:
      let response = rpc(request(newJString("init"), "initialize", %*{
        "protocolVersion": protocolVersion,
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"},
      }))
      check response["result"]["protocolVersion"].getStr == protocolVersion
      check response["result"]["capabilities"] == %*{
        "tools": {"listChanged": true}, "resources": {},
      }
      check response["result"]["serverInfo"] == %*{
        "name": "sketchdex", "version": version,
      }
      check response["result"]["instructions"].getStr == INSTRUCTIONS

  test "initialize falls back to the latest supported version":
    let response = rpc(request(newJInt(1), "initialize", %*{
      "protocolVersion": "unsupported",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1"},
    }))
    check response["result"]["protocolVersion"].getStr == LatestProtocolVersion

  test "tools list returns the shared definitions":
    let response = rpc(request(newJInt(1), "tools/list"))
    check response["result"]["tools"] == TOOLS

  test "tools call validates required keys before dispatch":
    let body = request(newJInt(1), "tools/call", %*{
      "name": "add_elements",
      "arguments": {"scene": "board", "elements": []},
    })
    let response = rpc(body)
    check response["result"]["isError"].getBool
    check response["result"]["content"][0]["type"].getStr == "text"
    check response["result"]["content"][0]["text"].getStr ==
      validateArgs("add_elements", %*{"scene": "board", "elements": []})

  test "tools call dispatches and shapes JSON content":
    let body = request(newJInt(1), "tools/call", %*{
      "name": "list_scenes", "arguments": {},
    })
    let response = decode(handleMcpRequest(body, echoDispatcher))
    check not response["result"].hasKey("isError")
    check parseJson(response["result"]["content"][0]["text"].getStr) ==
      %*{"tool": "list_scenes", "args": newJObject()}

  test "unknown tools return tool errors":
    let unknown = rpc(request(newJInt(1), "tools/call", %*{
      "name": "missing", "arguments": {},
    }))
    check unknown["result"]["isError"].getBool
    check unknown["result"]["content"][0]["text"].getStr == "unknown tool: missing"

  test "dispatcher exceptions become tool errors":
    let dispatcher: ToolDispatcher = proc(name: string, args: JsonNode): JsonNode =
      raise newException(ValueError, "agent failed")
    let body = request(newJInt(1), "tools/call", %*{
      "name": "list_scenes", "arguments": {},
    })
    let response = decode(handleMcpRequest(body, dispatcher))
    check response["result"]["isError"].getBool
    check response["result"]["content"][0]["text"].getStr == "agent failed"

  test "the docs tool works without an agent":
    let body = request(newJInt(1), "tools/call", %*{
      "name": "sketchdex_docs", "arguments": {"topic": "install"},
    })
    let response = rpc(body)
    check response["result"]["content"][0]["text"].getStr.startsWith("# Install")

  test "sketchdex_info and render_scene work through the RPC layer":
    let assets = getEnv("SKETCHDEX_DIST")
    let assetRoot = if assets.len > 0: assets else: repoRoot / "dist"
    if not fileExists(assetRoot / "render.html"):
      quit("BLOCKED: render asset dependency missing: " & assetRoot)
    putEnv("SKETCHDEX_DIST", assetRoot)

    let vault = createTempDir("sketchdex-mcp-rpc-", "", getTempDir())
    defer: removeDir(vault)
    let api = newAgentApi(vault)
    let created = api.createScene("Render RPC", %*[%*{
      "id": "rect", "type": "rectangle", "x": 0, "y": 0,
      "width": 120, "height": 80,
    }])
    let sceneId = created["sceneId"].getStr
    let dispatcher: ToolDispatcher = proc(name: string, args: JsonNode): JsonNode =
      dispatchAgent(api, name, args, api.vault.root)

    let infoBody = request(newJInt(1), "tools/call", %*{
      "name": "sketchdex_info", "arguments": {},
    })
    let infoResponse = decode(handleMcpRequest(infoBody, dispatcher))
    check not infoResponse["result"].hasKey("isError")
    let info = parseJson(infoResponse["result"]["content"][0]["text"].getStr)
    check info.len == 7
    check info["version"].getStr == parseJson(PackageJson)["version"].getStr
    check info["pid"].getInt == getCurrentProcessId()
    check info["startedAt"].getStr.endsWith("Z")
    check info["uptimeMinutes"].getInt >= 0
    check info["server"].getStr == getAppFilename()
    check info["vault"].getStr == api.vault.root
    check info["runtime"].getStr == "nim"

    let renderBody = request(newJInt(2), "tools/call", %*{
      "name": "render_scene",
      "arguments": {"scene": sceneId, "scale": 1, "maxWidth": 300, "tiles": 1},
    })
    let renderResponse = decode(handleMcpRequest(renderBody, dispatcher))
    check not renderResponse["result"].hasKey("isError")
    let content = renderResponse["result"]["content"]
    var imageCount = 0
    var pngPath = ""
    for contentBlock in content:
      if contentBlock["type"].getStr == "image":
        inc imageCount
        check contentBlock["mimeType"].getStr == "image/png"
        let pngBytes = base64.decode(contentBlock["data"].getStr)
        check isPng(pngBytes)
      elif contentBlock["type"].getStr == "text":
        let summary = parseJson(contentBlock["text"].getStr)
        if summary.hasKey("path"):
          pngPath = summary["path"].getStr
          check summary["inlined"].getBool
          check summary["scene"].getStr == "Render RPC"
    check imageCount >= 1
    check pngPath.len > 0
    defer: removeFile(pngPath)
    check fileExists(pngPath)
    let written = readFile(pngPath)
    check isPng(written)

  test "resources list returns the seven shared resources":
    let response = rpc(request(newJInt(1), "resources/list"))
    check response["result"]["resources"] == RESOURCES
    check response["result"]["resources"].len == 7

  test "resources read returns docs content":
    for topic in ["install", "vault", "app", "rendering", "tools", "drawing",
        "troubleshooting"]:
      let uri = "sketchdex://docs/" & topic
      let response = rpc(request(newJInt(1), "resources/read", %*{"uri": uri}))
      let content = response["result"]["contents"][0]
      check content["uri"].getStr == uri
      check content["mimeType"].getStr == "text/markdown"
      check content["text"].getStr == getTopic(topic)

  test "resource handler failures are internal errors":
    let malformed = rpc(request(newJInt(1), "resources/read", %*{"uri": "x://y"}))
    check errorCode(malformed) == InternalErrorCode
    check malformed["error"]["message"].getStr == "unknown resource: x://y"
    let missing = rpc(request(newJInt(2), "resources/read",
      %*{"uri": "sketchdex://docs/missing"}))
    check errorCode(missing) == InternalErrorCode
    check missing["error"]["message"].getStr.startsWith("no docs topic \"missing\"")

  test "oversized text spills to a file instead of truncating":
    let payload = repeat("x", TextLimit + 1)
    let result = shapeToolResult("read_scene", %*{"payload": payload})
    let summary = parseJson(result["content"][0]["text"].getStr)
    check summary["truncated"].getBool
    check summary["bytes"].getInt > TextLimit
    let path = summary["path"].getStr
    defer: removeFile(path)
    check fileExists(path)
    check readFile(path).len == summary["bytes"].getInt

  test "images over the inline limit use the preview":
    let full = repeat("A", DefaultImageLimit)
    let fitted = shapeToolResult("render_scene", %*{
      "_image": full, "path": "/tmp/full.png", "width": 10, "height": 10,
    })
    check fitted["content"][0]["type"].getStr == "image"
    check fitted["content"][0]["data"].getStr.len == DefaultImageLimit
    check fitted["content"][0]["mimeType"].getStr == "image/png"

    let large = shapeToolResult("render_scene", %*{
      "_image": repeat("B", DefaultImageLimit + 1),
      "_preview": {"base64": "preview", "mime": "image/jpeg", "width": 5, "height": 5},
      "path": "/tmp/large.png", "width": 10, "height": 10,
    })
    check large["content"][0]["data"].getStr == "preview"
    check large["content"][0]["mimeType"].getStr == "image/jpeg"
    let summary = parseJson(large["content"][1]["text"].getStr)
    check not summary["inlined"].getBool
    check summary["note"].getStr.startsWith("Shown at 5x5")

    let tiled = shapeToolResult("render_scene", %*{"_images": [
      {"base64": repeat("C", DefaultImageLimit div 2 + 1),
       "preview": {"base64": "first", "mime": "image/jpeg", "width": 5, "height": 5},
       "region": {"x": 0, "y": 0, "width": 10, "height": 10}, "path": "/tmp/1.png"},
      {"base64": repeat("D", DefaultImageLimit div 2 + 1),
       "preview": {"base64": "second", "mime": "image/jpeg", "width": 5, "height": 5},
       "region": {"x": 10, "y": 0, "width": 10, "height": 10}, "path": "/tmp/2.png"},
    ]})
    check tiled["content"][1]["data"].getStr == "first"
    check tiled["content"][3]["data"].getStr == "second"
    let tileSummary = parseJson(tiled["content"][4]["text"].getStr)
    check not tileSummary["tiles"][0]["inlined"].getBool
    check not tileSummary["tiles"][1]["inlined"].getBool

  test "the generic adapter maps the declared agent interface":
    let api = FakeAgent()
    let args = %*{
      "scene": "board",
      "elements": [{"id": "a", "x": 10}],
      "ids": ["a"],
      "patch": {"x": 20},
      "label": "move box",
    }
    let result = dispatchAgent(api, "update_elements", args)
    check result["op"].getStr == "update_elements"
    check api.calls.len == 1
    check api.calls[0].name == "update_elements"
    check api.calls[0].args["scene"].getStr == "board"
    check api.calls[0].args["label"].getStr == "move box"
    check api.calls[0].args["ids"][0].getStr == "a"
    check api.calls[0].args["patch"]["x"].getInt == 20

    check dispatchAgent(api, "list_scenes", %*{"scene": 1})["op"].getStr ==
      "list_scenes"
    check dispatchAgent(api, "create_scene", %*{"name": "new", "label": false})["op"].getStr ==
      "create_scene"
    check api.calls.len == 3
    check api.calls[2].args["name"].getStr == "new"

    discard dispatchAgent(api, "read_scene", %*{
      "scene": "board", "includeFiles": true,
    })
    check api.calls[3].args["includeFiles"].getBool

    discard dispatchAgent(api, "add_comment", %*{
      "scene": "board", "elementId": "a", "body": "look here", "label": "note",
    })
    check api.calls[^1].name == "add_comment"
    check api.calls[^1].args["body"].getStr == "look here"

    discard dispatchAgent(api, "search_elements", %*{
      "scene": "board", "query": "auth service",
    })
    check api.calls[^1].name == "search_elements"
    check api.calls[^1].args["query"].getStr == "auth service"

    discard dispatchAgent(api, "list_comments", %*{"scene": "board"})
    check api.calls[^1].name == "list_comments"
    check api.calls[^1].args["limit"].getInt == 500

    discard dispatchAgent(api, "update_comment", %*{
      "scene": "board", "elementId": "a", "commentId": "cmt_1",
      "action": "resolve", "label": "resolved",
    })
    check api.calls[^1].name == "update_comment"
    check api.calls[^1].args["action"].getStr == "resolve"
