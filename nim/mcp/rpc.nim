import std/[json, math, monotimes, os, random, strutils, tables, times]

import ../server/render
import docs
import tools

const
  PackageJson = staticRead("../../package.json")
  ParseErrorCode* = -32700
  InvalidRequestCode* = -32600
  MethodNotFoundCode* = -32601
  InvalidParamsCode* = -32602
  InternalErrorCode* = -32603
  TextLimit* = 120_000
  DefaultImageLimit* = 150_000
  LatestProtocolVersion* = "2025-11-25"
  SupportedProtocolVersions* = [
    "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07",
  ]
  ResourcePrefix = "sketchdex://docs/"

let
  ServerVersion = parseJson(PackageJson)["version"].getStr
  ProcessStartedAt = getTime()
  ProcessStartedMono = getMonoTime()
  InlineImageLimit = block:
    let configured =
      try: parseFloat(getEnv("SKETCHDEX_INLINE_LIMIT"))
      except ValueError: 0.0
    if configured == 0.0 or classify(configured) in {fcNan, fcInf, fcNegInf}:
      DefaultImageLimit
    elif configured > high(int).float:
      high(int)
    elif configured < low(int).float:
      low(int)
    else:
      int(configured)

type
  ToolDispatcher* = proc(name: string; args: JsonNode): JsonNode {.closure.}
  RpcFault = object of CatchableError
    code*: int
  RpcRequest = object
    id: JsonNode
    hasId: bool
    methodName: string
    params: JsonNode
  RpcContext = object
    dispatcher: ToolDispatcher
  MethodHandler = proc(params: JsonNode; context: RpcContext): JsonNode

proc fail(code: int; message: string) {.noreturn.} =
  let error = newException(RpcFault, message)
  error.code = code
  raise error

proc invalidParams(message: string) {.noreturn.} =
  fail(InvalidParamsCode, message)

proc finite(value: float): bool =
  classify(value) notin {fcNan, fcInf, fcNegInf}

proc jsonField(node: JsonNode; key: string): JsonNode =
  if node.isNil or node.kind != JObject or not node.hasKey(key): nil
  else: node[key]

proc isIntegerNumber(node: JsonNode): bool =
  if node.kind == JInt: return true
  if node.kind != JFloat: return false
  let value = node.getFloat
  finite(value) and value == floor(value)

proc normalizeId(node: JsonNode): JsonNode =
  if node.kind == JFloat:
    let value = node.getFloat
    const maxSafe = 9_007_199_254_740_991.0
    if value >= -maxSafe and value <= maxSafe:
      return newJInt(int64(value))
  node

proc parseRequest(root: JsonNode): RpcRequest =
  if root.kind != JObject:
    fail(InvalidRequestCode, "Invalid Request")
  if root.jsonField("jsonrpc") != newJString("2.0"):
    fail(InvalidRequestCode, "Invalid Request")

  let methodNode = root.jsonField("method")
  if methodNode.isNil or methodNode.kind != JString:
    fail(InvalidRequestCode, "Invalid Request")

  let hasId = root.hasKey("id")
  for key in root.keys:
    let allowed =
      key == "jsonrpc" or key == "method" or key == "params" or
      (hasId and key == "id")
    if not allowed:
      fail(InvalidRequestCode, "Invalid Request")

  var id = newJNull()
  if hasId:
    let rawId = root["id"]
    if rawId.kind != JString and not isIntegerNumber(rawId):
      fail(InvalidRequestCode, "Invalid Request")
    id = normalizeId(rawId)

  RpcRequest(
    id: id,
    hasId: hasId,
    methodName: methodNode.getStr,
    params: root.jsonField("params"),
  )

proc isClientResponse(root: JsonNode): bool =
  if root.kind != JObject or root.hasKey("method"): return false
  if root.jsonField("jsonrpc") != newJString("2.0"): return false
  let id = root.jsonField("id")
  if id.isNil or (id.kind != JString and not isIntegerNumber(id)): return false
  root.hasKey("result") != root.hasKey("error")

proc errorResponse(id: JsonNode; code: int; message: string): JsonNode =
  %*{
    "jsonrpc": "2.0",
    "id": if id.isNil: newJNull() else: id,
    "error": {"code": code, "message": message},
  }

proc successResponse(id: JsonNode; value: JsonNode): JsonNode =
  %*{"jsonrpc": "2.0", "id": id, "result": value}

proc paramsObject(params: JsonNode; required: bool): JsonNode =
  if params.isNil:
    if required: invalidParams("params must be an object")
    return newJObject()
  if params.kind != JObject:
    invalidParams("params must be an object")
  params

proc stringField(params: JsonNode; key: string): string =
  let value = params.jsonField(key)
  if value.isNil or value.kind != JString:
    invalidParams(key & " must be a string")
  value.getStr

proc initialize(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, true)
  let version = stringField(params, "protocolVersion")
  let capabilities = params.jsonField("capabilities")
  if capabilities.isNil or capabilities.kind != JObject:
    invalidParams("capabilities must be an object")
  let clientInfo = params.jsonField("clientInfo")
  if clientInfo.isNil or clientInfo.kind != JObject:
    invalidParams("clientInfo must be an object")
  discard stringField(clientInfo, "name")
  discard stringField(clientInfo, "version")

  let negotiated =
    if version in SupportedProtocolVersions: version
    else: LatestProtocolVersion
  %*{
    "protocolVersion": negotiated,
    "capabilities": {"tools": {"listChanged": true}, "resources": {}},
    "serverInfo": {"name": "sketchdex", "version": ServerVersion},
    "instructions": INSTRUCTIONS,
  }

proc emptyResult(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, false)
  newJObject()

proc listTools(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, false)
  %*{"tools": TOOLS}

proc listResources(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, false)
  %*{"resources": RESOURCES}

proc readResource(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, true)
  let uri = stringField(params, "uri")
  if not uri.startsWith(ResourcePrefix):
    fail(InternalErrorCode, "unknown resource: " & uri)
  let topic = uri[ResourcePrefix.len .. ^1]
  if topic.len == 0:
    fail(InternalErrorCode, "unknown resource: " & uri)
  for ch in topic:
    if ch notin {'a' .. 'z'}:
      fail(InternalErrorCode, "unknown resource: " & uri)
  try:
    %*{
      "contents": [{
        "uri": uri,
        "mimeType": "text/markdown",
        "text": getTopic(topic),
      }],
    }
  except ValueError as error:
    fail(InternalErrorCode, error.msg)

proc toolError(text: string): JsonNode =
  %*{
    "isError": true,
    "content": [{"type": "text", "text": text}],
  }

proc objectWithout(node: JsonNode; keys: openArray[string]): JsonNode =
  result = newJObject()
  if node.isNil or node.kind != JObject: return
  for key, value in node:
    if key notin keys and not value.isNil:
      result[key] = value

proc jsRound(value: float): int64 =
  int64(floor(value + 0.5))

proc numberField(node: JsonNode; key: string): float =
  let value = node.jsonField(key)
  if value.isNil: return 0.0
  if value.kind == JInt: return value.getInt.float
  if value.kind == JFloat and finite(value.getFloat): return value.getFloat
  0.0

proc textBlock(text: string): JsonNode =
  %*{"type": "text", "text": text}

proc imageBlock(data, mime: string): JsonNode =
  %*{"type": "image", "data": data, "mimeType": mime}

proc spill(toolName, text: string): string =
  let dir = getTempDir() / "sketchdex-renders"
  createDir(dir)
  let suffix = rand(999_999)
  let file = dir / (toolName & "-" & $text.len & "-" & $getCurrentProcessId() &
    "-" & $suffix & ".json")
  writeFile(file, text)
  file

proc shapeToolResult*(toolName: string; toolResult: JsonNode): JsonNode =
  let images = toolResult.jsonField("_images")
  if not images.isNil and images.kind == JArray:
    let count = max(1, images.len)
    let perImage = InlineImageLimit div count
    var content = newJArray()
    var tiles = newJArray()
    for index in 0 ..< images.len:
      let tile = images[index]
      let base64 = tile.jsonField("base64")
      let preview = tile.jsonField("preview")
      let fits = not base64.isNil and base64.kind == JString and
        base64.getStr.len <= perImage
      let shown =
        if fits: base64.getStr
        elif preview.isNil or preview.kind != JObject: ""
        else: preview.jsonField("base64").getStr
      let mime =
        if fits: "image/png"
        elif preview.isNil or preview.kind != JObject: "image/jpeg"
        else: preview.jsonField("mime").getStr
      let region = tile.jsonField("region")
      let box = %*{
        "x": jsRound(numberField(region, "x")),
        "y": jsRound(numberField(region, "y")),
        "width": jsRound(numberField(region, "width")),
        "height": jsRound(numberField(region, "height")),
      }
      content.add(textBlock(
        "tile " & $(index + 1) & " of " & $count & ": scene box x=" &
        $box["x"].getInt & " y=" & $box["y"].getInt & " width=" &
        $box["width"].getInt & " height=" & $box["height"].getInt))
      if shown.len > 0:
        content.add(imageBlock(shown, mime))
      var metadata = %*{"region": box, "inlined": fits}
      for key in ["path", "width", "height"]:
        let value = tile.jsonField(key)
        if not value.isNil:
          metadata[key] = value
      if not fits:
        metadata["shownAt"] =
          if preview.isNil or preview.kind != JObject: newJString("not shown")
          else: newJString($preview.jsonField("width").getInt & "x" &
            $preview.jsonField("height").getInt)
      tiles.add(metadata)
    var summary = objectWithout(toolResult, ["_images"])
    summary["tiles"] = tiles
    summary["note"] = %"The page was cut into tiles along its long axis (pass tiles: 1 for a single image). To look closely at one part, render that `region`."
    content.add(textBlock(pretty(summary, 1)))
    return %*{"content": content}

  let image = toolResult.jsonField("_image")
  if not image.isNil and image.kind == JString:
    let fits = image.getStr.len <= InlineImageLimit
    let preview = toolResult.jsonField("_preview")
    let shown =
      if fits: image.getStr
      elif preview.isNil or preview.kind != JObject: ""
      else: preview.jsonField("base64").getStr
    let mime =
      if fits: "image/png"
      elif preview.isNil or preview.kind != JObject: "image/jpeg"
      else: preview.jsonField("mime").getStr
    var content = newJArray()
    if shown.len > 0:
      content.add(imageBlock(shown, mime))
    var summary = objectWithout(toolResult, ["_image", "_preview"])
    summary["inlined"] = %fits
    if not fits:
      if preview.isNil or preview.kind != JObject:
        summary["note"] = %"Too large to show inline and too detailed to downscale. Read the file at `path`, or render a smaller `region`."
      else:
        summary["note"] = %("Shown at " & $preview.jsonField("width").getInt &
          "x" & $preview.jsonField("height").getInt &
          "; the full " & $summary.jsonField("width").getInt & "x" &
          $summary.jsonField("height").getInt &
          " render is the file at `path`. Render a smaller `region` for detail.")
    content.add(textBlock(pretty(summary, 1)))
    return %*{"content": content}

  let prose = toolResult.jsonField("_text")
  if not prose.isNil and prose.kind == JString:
    return %*{"content": [textBlock(prose.getStr)]}

  let text = pretty(if toolResult.isNil: newJNull() else: toolResult, 1)
  if text.len > TextLimit:
    let file = spill(toolName, text)
    return %*{"content": [textBlock(pretty(%*{
      "truncated": true,
      "bytes": text.len,
      "path": file,
      "note": "Too large to return in one result, so it was written to this file. Read it there, or narrow the request: describe_scene for a summary, read_elements with ids/type/region for specific elements.",
    }, 1))]}
  %*{"content": [textBlock(text)]}

proc defaultToolDispatcher*(name: string; args: JsonNode): JsonNode =
  if name == "sketchdex_docs":
    let topic = args.jsonField("topic")
    let name =
      if topic.isNil or topic.kind == JNull: ""
      elif topic.kind == JString: topic.getStr
      else: $topic
    return %*{"_text": getTopic(name)}
  raise newException(ValueError, name & " is not wired in the Nim server yet.")

proc callTool(params: JsonNode; context: RpcContext): JsonNode =
  discard paramsObject(params, true)
  let name = stringField(params, "name")
  if not OPERATIONS.hasKey(name):
    return toolError("unknown tool: " & name)
  let rawArgs = params.jsonField("arguments")
  if not rawArgs.isNil and rawArgs.kind != JObject:
    invalidParams("arguments must be an object")
  let args = if rawArgs.isNil: newJObject() else: rawArgs
  let missing = validateArgs(name, args)
  if missing.len > 0:
    return toolError(missing)
  try:
    if name == "sketchdex_docs":
      return shapeToolResult(name, defaultToolDispatcher(name, args))
    var dispatcher = context.dispatcher
    if dispatcher.isNil:
      dispatcher = proc(name: string, args: JsonNode): JsonNode =
        defaultToolDispatcher(name, args)
    shapeToolResult(name, dispatcher(name, args))
  except Exception as error:
    toolError(error.msg)

let methodHandlers = block:
  var handlers = initTable[string, MethodHandler]()
  handlers["initialize"] = initialize
  handlers["ping"] = emptyResult
  handlers["tools/list"] = listTools
  handlers["tools/call"] = callTool
  handlers["resources/list"] = listResources
  handlers["resources/read"] = readResource
  handlers

proc handleRpcMessage(root: JsonNode; context: RpcContext): JsonNode =
  try:
    if isClientResponse(root): return nil
    let request = parseRequest(root)
    if not request.hasId: return nil
    let handler = methodHandlers.getOrDefault(request.methodName)
    if handler.isNil:
      fail(MethodNotFoundCode, "Method not found")
    successResponse(request.id, handler(request.params, context))
  except RpcFault as error:
    let id = if error.code == InvalidRequestCode: nil else: root.jsonField("id")
    errorResponse(id, error.code, error.msg)
  except Exception as error:
    errorResponse(root.jsonField("id"), InternalErrorCode, error.msg)

proc handleRpcValue(root: JsonNode; dispatcher: ToolDispatcher = defaultToolDispatcher): JsonNode =
  let context = RpcContext(dispatcher: dispatcher)
  if root.kind != JArray:
    return handleRpcMessage(root, context)
  if root.len == 0:
    return errorResponse(nil, InvalidRequestCode, "Invalid Request")
  var responses: seq[JsonNode]
  for item in root:
    let response = handleRpcMessage(item, context)
    if not response.isNil:
      responses.add(response)
  if responses.len == 0: return nil
  else:
    result = newJArray()
    for response in responses:
      result.add(response)

## Notifications return an empty body. The HTTP caller must send status 202.
## Other bodies are JSON-RPC responses. Use status 400 for parse errors and 200 otherwise.
proc handleMcpRequest*(body: string; dispatcher: ToolDispatcher = defaultToolDispatcher): string =
  let root = try:
      parseJson(body)
    except JsonParsingError:
      return $errorResponse(nil, ParseErrorCode, "Parse error")
  let response = handleRpcValue(root, dispatcher)
  if response.isNil: "" else: $response

proc argument(args: JsonNode; key: string): JsonNode =
  args.jsonField(key)

proc stringArgument(args: JsonNode; key, fallback: string): string =
  let value = argument(args, key)
  if value.isNil or value.kind == JNull: fallback
  elif value.kind == JString: value.getStr
  else: raise newException(ValueError, key & " must be a string")

proc intArgument(args: JsonNode; key: string; fallback: int): int =
  let value = argument(args, key)
  if value.isNil or value.kind == JNull: return fallback
  if value.kind == JInt: return int(value.getInt)
  if value.kind == JFloat and finite(value.getFloat):
    return int(value.getFloat)
  raise newException(ValueError, key & " must be a number")

proc runtimeInfo(vaultPath: string): JsonNode =
  let uptime = (getMonoTime() - ProcessStartedMono).inSeconds.float
  %*{
    "version": ServerVersion,
    "pid": getCurrentProcessId(),
    "startedAt": utc(ProcessStartedAt).format("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"),
    "uptimeMinutes": int(round(uptime / 60.0)),
    "server": getAppFilename(),
    "vault": vaultPath,
    "runtime": "nim",
  }

proc shapeRenderResult(scene, png: JsonNode): JsonNode =
  let sceneName = scene.jsonField("name")
  let name = if sceneName.isNil or sceneName.kind != JString: "" else: sceneName.getStr
  if png.hasKey("tiles") and png["tiles"].kind == JArray:
    return %*{
      "_images": png["tiles"],
      "width": png["width"],
      "height": png["height"],
      "scene": name,
    }
  %*{
    "_image": png["base64"],
    "_preview": png["preview"],
    "path": png["path"],
    "bytes": png["bytes"],
    "width": png["width"],
    "height": png["height"],
    "scene": name,
  }

proc dispatchAgent*[T](api: T; name: string; args: JsonNode;
    vaultPath = ""): JsonNode =
  case name
  of "list_scenes":
    api.listScenes()
  of "describe_scene":
    let scene = stringArgument(args, "scene", "")
    api.describeScene(scene, intArgument(args, "limit", 400),
      stringArgument(args, "type", ""))
  of "read_elements":
    api.readElements(stringArgument(args, "scene", ""), args)
  of "read_scene":
    api.readScene(stringArgument(args, "scene", ""), args)
  of "create_scene":
    api.createScene(stringArgument(args, "name", "Untitled"), argument(args, "elements"))
  of "add_elements":
    api.addElements(stringArgument(args, "scene", ""), argument(args, "elements"),
      stringArgument(args, "label", ""))
  of "update_elements":
    api.updateElements(stringArgument(args, "scene", ""), argument(args, "elements"),
      stringArgument(args, "label", ""), argument(args, "ids"), argument(args, "patch"))
  of "delete_elements":
    api.deleteElements(stringArgument(args, "scene", ""), argument(args, "ids"),
      stringArgument(args, "label", ""))
  of "move_elements":
    api.moveElements(stringArgument(args, "scene", ""), args,
      stringArgument(args, "label", ""))
  of "replace_scene":
    api.replaceElements(stringArgument(args, "scene", ""), argument(args, "elements"),
      stringArgument(args, "label", ""))
  of "set_background":
    api.setBackground(stringArgument(args, "scene", ""),
      stringArgument(args, "color", ""), stringArgument(args, "label", ""))
  of "import_svg":
    api.importSvg(stringArgument(args, "scene", ""),
      stringArgument(args, "svg", ""), args, stringArgument(args, "label", ""))
  of "check_scene":
    api.checkScene(stringArgument(args, "scene", ""))
  of "snapshot_scene":
    api.snapshotScene(stringArgument(args, "scene", ""),
      stringArgument(args, "label", ""))
  of "list_history":
    api.listHistory(stringArgument(args, "scene", ""))
  of "restore_snapshot":
    api.restoreSnapshot(stringArgument(args, "scene", ""),
      stringArgument(args, "snapshot", ""))
  of "render_scene":
    let scene = api.readScene(stringArgument(args, "scene", ""),
      %*{"includeFiles": true})
    let tiles = argument(args, "tiles")
    let divisor =
      if tiles.isNil: 1.0
      elif tiles.kind in {JInt, JFloat}: max(1.0, tiles.getFloat)
      else: 1.0
    args["inlineLimit"] = %int(floor(InlineImageLimit.float / divisor))
    let png = renderScene(scene, args)
    shapeRenderResult(scene, png)
  of "add_comment":
    api.addComment(stringArgument(args, "scene", ""),
      stringArgument(args, "elementId", ""), stringArgument(args, "body", ""),
      stringArgument(args, "label", ""), stringArgument(args, "author", ""),
      stringArgument(args, "authorKind", ""))
  of "list_comments":
    api.listComments(stringArgument(args, "scene", ""),
      stringArgument(args, "elementId", ""), stringArgument(args, "status", ""),
      intArgument(args, "limit", 500))
  of "update_comment":
    api.updateComment(stringArgument(args, "scene", ""),
      stringArgument(args, "elementId", ""),
      stringArgument(args, "commentId", ""), stringArgument(args, "action", ""),
      stringArgument(args, "label", ""))
  of "sketchdex_info":
    runtimeInfo(vaultPath)
  else:
    raise newException(ValueError, "unknown tool: " & name)
