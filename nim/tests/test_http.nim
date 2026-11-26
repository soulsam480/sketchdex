import std/[httpclient, json, net, os, osproc, sets, streams, strtabs, strutils, tables, tempfiles, unittest]

const
  repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))
  defaultBinary = "/tmp/sketchdex"
  defaultMetrics = repoRoot / "server" / "font-metrics.json"

type
  HeaderPair = tuple[name, value: string]

proc configuredBinary(): string =
  absolutePath(getEnv("SKETCHDEX_BIN", defaultBinary))

proc environment(extra: openArray[tuple[key, value: string]]): StringTableRef =
  result = newStringTable()
  for pair in envPairs():
    result[pair.key] = pair.value
  for pair in extra:
    result[pair.key] = pair.value

proc request(baseUrl: string, httpMethod: HttpMethod, path: string, body = "", contentType = "",
    extraHeaders: openArray[HeaderPair] = []): Response =
  var headers = newHttpHeaders()
  if contentType.len > 0:
    headers["Content-Type"] = contentType
  for pair in extraHeaders:
    headers[pair.name] = pair.value
  let client = newHttpClient(timeout = 5_000, maxRedirects = 0)
  try:
    result = client.request(baseUrl & path, httpMethod = httpMethod,
      headers = headers, body = body)
  finally:
    client.close()

proc jsonRequest(baseUrl: string, httpMethod: HttpMethod, path: string; body: JsonNode;
    extraHeaders: openArray[HeaderPair] = []): Response =
  request(baseUrl, httpMethod, path, $body, "application/json", extraHeaders)

proc checkJsonError(response: Response; status: int) =
  check response.code == HttpCode(status)
  check response.headers.getOrDefault("Content-Type").startsWith("application/json")
  let body = parseJson(response.body)
  check body.hasKey("error")
  check body["error"].getStr.len > 0

proc recvExact(socket: Socket; count: int; timeout: int): string =
  result = newString(count)
  var received = 0
  while received < count:
    let size = socket.recv(addr result[received], count - received, timeout)
    if size <= 0:
      raise newException(IOError, "SSE socket closed before the frame arrived")
    received += size

proc recvChunk(socket: Socket; timeout: int): string =
  let sizeLine = socket.recvLine(timeout).strip
  let size = parseHexInt(sizeLine)
  if size == 0:
    discard socket.recvLine(timeout)
    return ""
  result = recvExact(socket, size, timeout)
  check socket.recvLine(timeout).strip.len == 0

proc readSseHeaders(socket: Socket): Table[string, string] =
  result = initTable[string, string]()
  let status = socket.recvLine(5_000)
  check status.startsWith("HTTP/1.1 200")
  while true:
    let line = socket.recvLine(5_000).strip
    if line.len == 0: break
    let colon = line.find(':')
    if colon > 0:
      result[line[0 ..< colon].toLowerAscii] = line[colon + 1 .. ^1].strip

proc readHttpResponse(socket: Socket): tuple[status: int, headers: Table[string, string], body: string] =
  let statusLine = socket.recvLine(5_000)
  result.status = parseInt(statusLine.splitWhitespace()[1])
  result.headers = initTable[string, string]()
  while true:
    let line = socket.recvLine(5_000).strip
    if line.len == 0: break
    let colon = line.find(':')
    if colon > 0:
      result.headers[line[0 ..< colon].toLowerAscii] = line[colon + 1 .. ^1].strip
  let length = parseInt(result.headers.getOrDefault("content-length", "0"))
  result.body = recvExact(socket, length, 5_000)

proc processCommands(): tuple[parents: Table[int, int], commands: Table[int, string]] =
  var parents = initTable[int, int]()
  var commands = initTable[int, string]()
  let output = execProcess("/bin/ps", args = ["-axo", "pid=,ppid=,comm="],
    options = {poUsePath})
  for line in output.splitLines:
    let fields = line.strip.splitWhitespace
    if fields.len < 3: continue
    try:
      let pid = parseInt(fields[0])
      let parent = parseInt(fields[1])
      parents[pid] = parent
      commands[pid] = fields[2 .. ^1].join(" ")
    except ValueError:
      discard
  (parents, commands)

proc checkNoNodeDescendant(pid: int) =
  when defined(posix):
    let snapshot = processCommands()
    var children = initTable[int, seq[int]]()
    for child, parent in snapshot.parents:
      if not children.hasKey(parent):
        children[parent] = @[]
      children[parent].add(child)
    var pending = @[pid]
    var visited = initHashSet[int]()
    var index = 0
    while index < pending.len:
      let current = pending[index]
      inc index
      if current in visited: continue
      visited.incl(current)
      check not snapshot.commands.getOrDefault(current).toLowerAscii.contains("node")
      for child in children.getOrDefault(current):
        pending.add(child)

proc runCli(binary: string; arguments: openArray[string];
    env: StringTableRef = nil): tuple[output, stderr: string, exitCode: int] =
  let process = startProcess(binary, args = arguments, env = env,
    options = {poUsePath})
  defer: process.close()
  result.output = process.outputStream.readAll()
  result.stderr = process.errorStream.readAll()
  result.exitCode = process.waitForExit(timeout = 10_000)

suite "sketchdex HTTP app":
  var
    binary, tempDir, assetsDir, vaultDir, baseUrl: string
    serverProcess: Process
    serverPort: Port

  setup:
    serverProcess = nil
    tempDir = ""
    binary = configuredBinary()
    doAssert fileExists(binary), "server binary not found: " & binary
    tempDir = createTempDir("sketchdex-http-test-", "")
    assetsDir = tempDir / "assets"
    vaultDir = tempDir / "vault"
    createDir(assetsDir)
    writeFile(assetsDir / "index.html", "<!doctype html><title>Sketchdex test</title><div id=\"root\"></div>")
    writeFile(assetsDir / "asset.js", "console.log('served');\n")
    let env = environment({
      "SKETCHDEX_METRICS": defaultMetrics,
      "SKETCHDEX_MAX_BODY": "1024"
    })
    serverProcess = startProcess(binary,
      args = ["app", "--port", "0", "--vault", vaultDir, "--assets", assetsDir],
      env = env, options = {poUsePath})
    var banner, appLine: string
    check serverProcess.outputStream.readLine(banner)
    check serverProcess.outputStream.readLine(appLine)
    check banner.startsWith("sketchdex ")
    check appLine.startsWith("  app    http://127.0.0.1:")
    doAssert appLine.startsWith("  app    http://127.0.0.1:"),
      "server did not print its URL: " & banner & " / " & appLine
    baseUrl = appLine.strip.splitWhitespace()[^1]
    serverPort = Port(parseInt(baseUrl.split(':')[^1]))

  teardown:
    if serverProcess != nil:
      serverProcess.terminate()
      discard serverProcess.waitForExit(timeout = 5_000)
      serverProcess.close()
    if tempDir.len > 0:
      removeDir(tempDir)

  test "serves static assets and the SPA fallback":
    let root = request(baseUrl, HttpGet, "/")
    check root.code == Http200
    check root.headers.getOrDefault("Content-Type").startsWith("text/html")
    check root.body.contains("Sketchdex test")
    let fallback = request(baseUrl, HttpGet, "/library/scenes/not-a-file")
    check fallback.code == Http200
    check fallback.body == root.body
    let asset = request(baseUrl, HttpGet, "/asset.js")
    check asset.code == Http200
    check asset.headers.getOrDefault("Content-Type").startsWith("text/javascript")
    check asset.body == "console.log('served');\n"

  test "reports the vault and enforces Host and Origin guards":
    let vault = request(baseUrl, HttpGet, "/api/vault")
    check vault.code == Http200
    check parseJson(vault.body)["vault"].getStr == absolutePath(vaultDir)
    let badHost = request(baseUrl, HttpGet, "/api/vault",
      extraHeaders = [("Host", "evil.example")])
    checkJsonError(badHost, 403)
    let badOrigin = jsonRequest(baseUrl, HttpPost, "/api/scenes", %*{"name": "blocked"},
      extraHeaders = [("Origin", "https://evil.example")])
    checkJsonError(badOrigin, 403)
    let localOrigin = jsonRequest(baseUrl, HttpPost, "/api/scenes", %*{"name": "allowed"},
      extraHeaders = [("Origin", "http://127.0.0.1:1234")])
    check localOrigin.code == Http200

  test "reads and replaces the vault library with a revision guard":
    let initial = request(baseUrl, HttpGet, "/api/library")
    check initial.code == Http200
    let initialBody = parseJson(initial.body)
    check initialBody["rev"].kind == JNull
    check initialBody["items"].len == 0

    let item = %*{
      "id": "lib-item-1",
      "name": "Server",
      "elements": [%*{"type": "rectangle", "width": 40, "height": 20}]
    }
    let written = jsonRequest(baseUrl, HttpPut, "/api/library", %*{"items": [item]})
    check written.code == Http200
    let rev = parseJson(written.body)["rev"].getStr
    check rev.len > 0

    let after = request(baseUrl, HttpGet, "/api/library")
    check after.code == Http200
    let afterBody = parseJson(after.body)
    check afterBody["rev"].getStr == rev
    check afterBody["items"].len == 1
    check afterBody["items"][0]["id"].getStr == "lib-item-1"

    let stale = jsonRequest(baseUrl, HttpPut, "/api/library", %*{
      "items": [item], "ifRev": "stale"
    })
    checkJsonError(stale, 409)

  test "the scene lifecycle works over HTTP":
    let createdResponse = jsonRequest(baseUrl, HttpPost, "/api/scenes", %*{"name": "HTTP scene"})
    check createdResponse.code == Http200
    let created = parseJson(createdResponse.body)
    let id = created["id"].getStr
    check created["name"].getStr == "HTTP scene"

    let listed = request(baseUrl, HttpGet, "/api/scenes")
    check listed.code == Http200
    var found = false
    for meta in parseJson(listed.body):
      if meta["id"].getStr == id:
        found = true
        break
    check found

    let read = request(baseUrl, HttpGet, "/api/scenes/" & id)
    check read.code == Http200
    let payload = parseJson(read.body)
    check payload["elements"].len == 0
    let revision = payload["rev"].getStr

    let saved = jsonRequest(baseUrl, HttpPut, "/api/scenes/" & id, %*{
      "payload": {"elements": [], "appState": {"viewBackgroundColor": "#121212"}, "files": {}},
      "touch": true,
      "ifRev": revision
    })
    check saved.code == Http200
    check parseJson(saved.body)["rev"].getStr.len > 0

    let patched = jsonRequest(baseUrl, HttpPatch, "/api/scenes/" & id, %*{"name": "Renamed"})
    check patched.code == Http200
    let renamed = request(baseUrl, HttpGet, "/api/scenes/" & id)
    check parseJson(renamed.body)["name"].getStr == "Renamed"

    let thumbWrite = jsonRequest(baseUrl, HttpPut, "/api/scenes/" & id / "thumb", %*{"svg": "<svg></svg>"})
    check thumbWrite.code == Http200
    let thumbRead = request(baseUrl, HttpGet, "/api/scenes/" & id / "thumb")
    check thumbRead.code == Http200
    check parseJson(thumbRead.body)["svg"].getStr == "<svg></svg>"

    let duplicate = jsonRequest(baseUrl, HttpPost, "/api/scenes/" & id / "duplicate", newJObject())
    check duplicate.code == Http200
    let duplicateId = parseJson(duplicate.body)["id"].getStr
    check duplicateId != id

    let imported = jsonRequest(baseUrl, HttpPost, "/api/scenes", %*{
      "import": {
        "meta": {"name": "Imported"},
        "payload": {"elements": [], "appState": {}, "files": {}}
      }
    })
    check imported.code == Http200
    let importedId = parseJson(imported.body)["id"].getStr

    for sceneId in [id, duplicateId, importedId]:
      let deleted = request(baseUrl, HttpDelete, "/api/scenes/" & sceneId)
      check deleted.code == Http200
    let missing = request(baseUrl, HttpGet, "/api/scenes/" & id)
    checkJsonError(missing, 404)

  test "builds elements and records agent history":
    let built = jsonRequest(baseUrl, HttpPost, "/api/agent/build", %*{
      "specs": [%*{"id": "box", "type": "rectangle", "width": 120, "height": 60, "label": "Box"}]
    })
    check built.code == Http200
    let builtBody = parseJson(built.body)
    check builtBody["elements"].len == 2
    check builtBody["elements"][0]["type"].getStr == "rectangle"
    check builtBody["elements"][1]["type"].getStr == "text"

    let created = jsonRequest(baseUrl, HttpPost, "/api/agent/create", %*{"name": "Agent scene"})
    check created.code == Http200
    let id = parseJson(created.body)["sceneId"].getStr
    let added = jsonRequest(baseUrl, HttpPost, "/api/agent/add", %*{
      "scene": id,
      "elements": [%*{"type": "rectangle", "width": 100, "height": 50, "label": "Agent box"}],
      "label": "add the agent box"
    })
    check added.code == Http200
    check parseJson(added.body)["added"].getInt == 2

    let history = request(baseUrl, HttpGet, "/api/scenes/" & id / "history")
    check history.code == Http200
    let entries = parseJson(history.body)["entries"]
    check entries.len > 0
    let snapshotId = entries[0]["id"].getStr
    let snapshot = request(baseUrl, HttpGet, "/api/scenes/" & id / "history" / snapshotId)
    check snapshot.code == Http200
    let restored = jsonRequest(baseUrl, HttpPost,
      "/api/scenes/" & id / "history" / snapshotId / "restore", newJObject())
    check restored.code == Http200
    let discarded = request(baseUrl, HttpDelete,
      "/api/scenes/" & id / "history" / snapshotId)
    check discarded.code == Http200
    let cleared = request(baseUrl, HttpDelete, "/api/scenes/" & id / "history")
    check cleared.code == Http200
    check parseJson(cleared.body)["entries"].len == 0

  test "streams SSE headers and a 25 second heartbeat":
    let socket = newSocket()
    socket.connect("127.0.0.1", serverPort)
    defer: socket.close()
    socket.send("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:" & $serverPort &
      "\r\nConnection: close\r\n\r\n")
    let headers = readSseHeaders(socket)
    check headers.getOrDefault("content-type").startsWith("text/event-stream")
    check headers.getOrDefault("cache-control") == "no-cache, no-transform"
    check headers.getOrDefault("transfer-encoding") == "chunked"
    check recvChunk(socket, 5_000).contains("retry: 2000")
    check recvChunk(socket, 30_000).contains(": heartbeat")

  test "serves MCP initialize over HTTP":
    let response = jsonRequest(baseUrl, HttpPost, "/mcp", %*{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "nim-http-test", "version": "1"}
      }
    })
    check response.code == Http200
    let body = parseJson(response.body)
    check body["jsonrpc"].getStr == "2.0"
    check body["id"].getInt == 1
    check body["result"]["serverInfo"]["name"].getStr == "sketchdex"
    check body["result"]["serverInfo"]["version"].getStr.len > 0

  test "errors answer JSON with the right status":
    checkJsonError(request(baseUrl, HttpGet, "/api/missing"), 404)
    let notAllowed = request(baseUrl, HttpPost, "/api/vault")
    checkJsonError(notAllowed, 405)
    check notAllowed.headers.getOrDefault("Allow").contains("GET")
    checkJsonError(request(baseUrl, HttpPost, "/api/scenes", "{",
      "application/json"), 400)
    checkJsonError(request(baseUrl, HttpPost, "/api/scenes", repeat('x', 2048),
      "application/json"), 413)
    checkJsonError(request(baseUrl, HttpPost, "/api/scenes", "{}", "text/plain"), 415)
    checkJsonError(request(baseUrl, HttpGet, "/%2e%2e/package.json"), 400)
    checkJsonError(request(baseUrl, HttpGet, "/api/scenes/..%2F.."), 400)

  test "maps missing and ambiguous agent scenes to 404 and 409":
    let missing = jsonRequest(baseUrl, HttpPost, "/api/agent/read",
      %*{"scene": "no-such-scene"})
    checkJsonError(missing, 404)
    for _ in 0 ..< 2:
      let created = jsonRequest(baseUrl, HttpPost, "/api/scenes",
        %*{"name": "Same name"})
      check created.code == Http200
    let ambiguous = jsonRequest(baseUrl, HttpPost, "/api/agent/read",
      %*{"scene": "Same name"})
    checkJsonError(ambiguous, 409)

  test "preserves empty-body JSON behavior":
    let response = request(baseUrl, HttpPost, "/api/agent/list")
    check response.code == Http200
    check parseJson(response.body).kind == JArray

  test "reads chunked JSON and rejects an oversized chunk":
    let validSocket = newSocket()
    validSocket.connect("127.0.0.1", serverPort)
    defer: validSocket.close()
    validSocket.send("POST /api/agent/list HTTP/1.1\r\nHost: 127.0.0.1:" & $serverPort &
      "\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n" &
      "1\r\n{\r\n1\r\n}\r\n0\r\n\r\n")
    let valid = readHttpResponse(validSocket)
    check valid.status == 200
    check parseJson(valid.body).kind == JArray

    let largeSocket = newSocket()
    largeSocket.connect("127.0.0.1", serverPort)
    defer: largeSocket.close()
    largeSocket.send("POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:" & $serverPort &
      "\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n" &
      "800\r\n")
    let large = readHttpResponse(largeSocket)
    check large.status == 413
    check parseJson(large.body).hasKey("error")

  test "comments attach to one element and a canvas save cannot drop them":
    let created = jsonRequest(baseUrl, HttpPost, "/api/agent/create", %*{
      "name": "comments", "elements": [%*{"type": "rectangle", "width": 80, "height": 40}]
    })
    check created.code == Http200
    let sceneId = parseJson(created.body)["sceneId"].getStr
    let described = jsonRequest(baseUrl, HttpPost, "/api/agent/describe", %*{"scene": sceneId})
    let elementId = parseJson(described.body)["elements"][0]["id"].getStr

    let added = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-add", %*{
      "scene": sceneId, "elementId": elementId, "body": "Check this connector.",
      "author": "You", "authorKind": "human", "label": "comment: check it"
    })
    check added.code == Http200
    let addedBody = parseJson(added.body)
    let commentId = addedBody["comment"]["id"].getStr
    check commentId.startsWith("cmt_")
    check addedBody["comment"]["author"]["name"].getStr == "You"
    check addedBody["open"].getInt == 1

    let listed = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-list", %*{"scene": sceneId})
    check parseJson(listed.body)["comments"][0]["body"].getStr == "Check this connector."

    let counted = jsonRequest(baseUrl, HttpPost, "/api/agent/describe", %*{"scene": sceneId})
    check parseJson(counted.body)["comments"]["open"].getInt == 1
    for element in parseJson(counted.body)["elements"]:
      if element["id"].getStr == elementId:
        check element["comments"]["open"].getInt == 1

    # the browser holds a stale copy without the comment: save it anyway
    let scene = request(baseUrl, HttpGet, "/api/scenes/" & sceneId)
    var payload = parseJson(scene.body)
    for element in payload["elements"]:
      if element.hasKey("customData"): element.delete("customData")
    let saved = jsonRequest(baseUrl, HttpPut, "/api/scenes/" & sceneId, %*{
      "payload": %*{
        "elements": payload["elements"], "appState": payload["appState"], "files": {}
      },
      "touch": true, "ifRev": payload["rev"]
    })
    check saved.code == Http200
    let afterSave = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-list", %*{"scene": sceneId})
    check parseJson(afterSave.body)["comments"].len == 1

    let searched = jsonRequest(baseUrl, HttpPost, "/api/agent/search", %*{
      "scene": sceneId, "query": "connector"
    })
    let hits = parseJson(searched.body)
    check hits["matched"].getInt == 1
    check hits["results"][0]["id"].getStr == elementId
    check hits["results"][0]["match"].getStr == "comment"

    let resolved = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-update", %*{
      "scene": sceneId, "elementId": elementId, "commentId": commentId,
      "action": "resolve", "label": "resolve it"
    })
    check resolved.code == Http200
    check parseJson(resolved.body)["status"].getStr == "resolved"
    let again = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-update", %*{
      "scene": sceneId, "elementId": elementId, "commentId": commentId,
      "action": "resolve", "label": "resolve it"
    })
    check not parseJson(again.body)["changed"].getBool

    let missingLabel = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-add", %*{
      "scene": sceneId, "elementId": elementId, "body": "no label"
    })
    check missingLabel.code == Http400
    let missingElement = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-add", %*{
      "scene": sceneId, "elementId": "nope", "body": "x", "label": "x"
    })
    check missingElement.code == Http404

    let deleted = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-update", %*{
      "scene": sceneId, "elementId": elementId, "commentId": commentId,
      "action": "delete", "label": "delete it"
    })
    check parseJson(deleted.body)["status"].getStr == "deleted"
    let empty = jsonRequest(baseUrl, HttpPost, "/api/agent/comment-list", %*{"scene": sceneId})
    check parseJson(empty.body)["total"].getInt == 0

  test "runs without a Node child process":
    checkNoNodeDescendant(processID(serverProcess))

suite "sketchdex CLI":
  test "prints version and docs":
    let binary = configuredBinary()
    let version = runCli(binary, ["--version"])
    check version.exitCode == 0
    check version.output == "0.6.0\n"
    check version.stderr == ""
    let docs = runCli(binary, ["docs", "tools"])
    check docs.exitCode == 0
    check docs.output.contains("# Tools")
    check docs.stderr == ""

  test "finds default assets and embedded metrics without environment overrides":
    let binary = configuredBinary()
    let tempDir = createTempDir("sketchdex-default-runtime-", "")
    let binDir = tempDir / "bin"
    let assetsDir = tempDir / "dist"
    createDir(binDir)
    createDir(assetsDir)
    let installedBinary = binDir / "sketchdex"
    copyFile(binary, installedBinary)
    writeFile(assetsDir / "index.html", "<h1>default assets</h1>")
    var env = newStringTable()
    for pair in envPairs():
      env[pair.key] = pair.value
    env.del("SKETCHDEX_METRICS")
    let process = startProcess(installedBinary,
      args = ["app", "--port", "0", "--vault", tempDir / "vault"],
      env = env, options = {poUsePath})
    defer:
      process.terminate()
      discard process.waitForExit(timeout = 5_000)
      process.close()
      removeDir(tempDir)
    var banner, appLine: string
    check process.outputStream.readLine(banner)
    check process.outputStream.readLine(appLine)
    let baseUrl = appLine.strip.splitWhitespace()[^1]
    check request(baseUrl, HttpGet, "/").body == "<h1>default assets</h1>"
    let built = jsonRequest(baseUrl, HttpPost, "/api/agent/build", %*{
      "specs": [%*{"type": "rectangle", "width": 80, "height": 40, "label": "Embedded"}]
    })
    check built.code == Http200
    check parseJson(built.body)["elements"].len == 2

  test "mcp --serve runs the app beside the session and stops it":
    let binary = configuredBinary()
    let tempDir = createTempDir("sketchdex-serve-test-", "")
    let assetsDir = tempDir / "dist"
    createDir(assetsDir)
    writeFile(assetsDir / "index.html", "<h1>serve assets</h1>")
    defer: removeDir(tempDir)
    let env = environment({
      "SKETCHDEX_METRICS": defaultMetrics,
      "SKETCHDEX_NO_OPEN": "1"
    })
    let probe = newSocket()
    probe.bindAddr(Port(0))
    let (_, freePort) = probe.getLocalAddr()
    probe.close()
    let port = int(freePort)
    let process = startProcess(binary,
      args = ["mcp", "--serve", "--port", $port, "--vault", tempDir / "vault",
        "--assets", assetsDir],
      env = env, options = {poUsePath})
    var appUp = false
    for attempt in 0 ..< 60:
      try:
        let client = newHttpClient(timeout = 500)
        try:
          let response = client.request("http://127.0.0.1:" & $port & "/api/vault")
          appUp = response.code == Http200 and
            parseJson(response.body)["vault"].getStr == absolutePath(tempDir / "vault")
        finally:
          client.close()
      except CatchableError:
        discard
      if appUp: break
      sleep(50)
    check appUp

    process.inputStream.writeLine($(%*{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "nim-serve-test", "version": "1"}
      }
    }))
    process.inputStream.flush()
    check parseJson(process.outputStream.readLine())["result"]["serverInfo"]["name"].
      getStr == "sketchdex"

    process.inputStream.close()
    check process.waitForExit(timeout = 10_000) == 0
    process.close()

    var stopped = false
    for attempt in 0 ..< 60:
      try:
        let client = newHttpClient(timeout = 200)
        try:
          discard client.request("http://127.0.0.1:" & $port & "/api/vault")
        finally:
          client.close()
      except CatchableError:
        stopped = true
        break
      sleep(50)
    check stopped

  test "runs MCP initialize over stdio":
    let binary = configuredBinary()
    let tempDir = createTempDir("sketchdex-stdio-test-", "")
    defer: removeDir(tempDir)
    let env = environment({"SKETCHDEX_METRICS": defaultMetrics})
    let process = startProcess(binary, args = ["mcp", "--vault", tempDir / "vault"],
      env = env, options = {poUsePath})
    defer: process.close()
    process.inputStream.writeLine($(%*{
      "jsonrpc": "2.0",
      "id": 1,
      "method": "initialize",
      "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "nim-stdio-test", "version": "1"}
      }
    }))
    process.inputStream.flush()
    process.inputStream.close()
    let output = process.outputStream.readAll()
    check output.len > 0
    let response = parseJson(output.splitLines[0])
    check response["id"].getInt == 1
    check response["result"]["serverInfo"]["name"].getStr == "sketchdex"
    check process.waitForExit(timeout = 10_000) == 0
