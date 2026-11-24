import std/[asyncdispatch, asyncnet, json, locks, monotimes, options, os, re,
  strutils, tables, times, uri]

import ../core/[elements, jsvalue, random_ids]
import ../mcp/rpc
import ../server/[agent, comments, history, vault]
import ../server/watch as filewatch

const
  DefaultMaxBodyBytes* = 32 * 1024 * 1024
  HeartbeatMs* = 25_000
  MaxHeaderBytes = 64 * 1024
  MaxLineBytes = 64 * 1024
  ReadTimeoutMs = 120_000
  ScanIntervalMs = 250
  EchoWindowMs = 2_500
  AgentOps* = [
    "list", "describe", "read", "elements", "path", "create", "add", "update",
    "delete", "move", "replace", "write", "background", "snapshot", "svg",
    "check", "history", "restore", "discard", "clear", "build",
    "comment-add", "comment-list", "comment-update"
  ]

type
  HttpMethod* = enum
    hmGet, hmPost, hmPut, hmPatch, hmDelete, hmHead, hmOptions, hmOther

  IncomingRequest* = object
    reqMethod*: HttpMethod
    target*: string
    path*: string
    parts*: seq[string]
    headers*: Table[string, string]
    body*: string
    client*: AsyncSocket

  HttpFailure* = object of CatchableError
    status*: int
    allow*: seq[string]

  ClientGone* = object of CatchableError

  BodyBuffer = ref object
    data: string

  SseClient* = ref object
    socket*: AsyncSocket
    pending*: seq[string]
    closed*: bool

  WriteNote* = object
    by*: string
    at*: MonoTime
    rev*: Option[string]

  Watcher* = ref object
    api*: AgentApi
    clients*: seq[SseClient]
    recent*: Table[string, WriteNote]
    changes*: seq[filewatch.WatchChange]
    changeLock*: Lock
    closed*: bool

  HttpServer* = ref object
    socket*: AsyncSocket
    api*: AgentApi
    watcher*: Watcher
    fileWatch*: filewatch.Watcher
    assetsDir*: string
    maxBodyBytes*: int
    port*: Port
    url*: string

let loopbackPattern = re(
  r"^(localhost|127(\.[0-9]{1,3}){3}|\[::1\]|::1)(:[0-9]+)?$",
  {reIgnoreCase})

proc fail(status: int; message: string; allowed: varargs[string]): void {.noreturn.} =
  var error = newException(HttpFailure, message)
  error.status = status
  error.allow = @allowed
  raise error

proc methodNotAllowed(allowed: varargs[string]) {.noreturn.} =
  fail(405, "method not allowed", allowed)

proc notFound() {.noreturn.} =
  fail(404, "not found")

proc reasonPhrase(status: int): string =
  case status
  of 200: "OK"
  of 202: "Accepted"
  of 400: "Bad Request"
  of 403: "Forbidden"
  of 404: "Not Found"
  of 405: "Method Not Allowed"
  of 408: "Request Timeout"
  of 413: "Payload Too Large"
  of 415: "Unsupported Media Type"
  of 417: "Expectation Failed"
  of 500: "Internal Server Error"
  of 501: "Not Implemented"
  of 503: "Service Unavailable"
  else: "Error"

proc sendResponse(socket: AsyncSocket; status: int; body: string;
    contentType: string; extraHeaders: seq[tuple[name, value: string]] = @[];
    head = false): Future[void] {.async.} =
  var message = "HTTP/1.1 " & $status & " " & reasonPhrase(status) & "\r\n"
  message.add("Content-Type: " & contentType & "\r\n")
  message.add("Content-Length: " & $body.len & "\r\n")
  message.add("Connection: close\r\n")
  message.add("Cache-Control: no-store\r\n")
  for pair in extraHeaders:
    message.add(pair.name & ": " & pair.value & "\r\n")
  message.add("\r\n")
  if not head:
    message.add(body)
  await socket.send(message)

proc sendJson(socket: AsyncSocket; status: int; value: JsonNode;
    extraHeaders: seq[tuple[name, value: string]] = @[]): Future[void] {.async.} =
  await sendResponse(socket, status, $value, "application/json", extraHeaders)

proc errorMessage(error: ref CatchableError): string =
  error.msg.splitLines()[0]

proc sendJsonError(socket: AsyncSocket; error: ref HttpFailure): Future[void] {.async.} =
  var headers: seq[tuple[name, value: string]]
  if error.allow.len > 0:
    headers.add(("Allow", error.allow.join(", ")))
  await sendJson(socket, error.status, %*{"error": errorMessage(error)}, headers)

proc parseMethod(value: string): HttpMethod =
  case value.toUpperAscii
  of "GET": hmGet
  of "POST": hmPost
  of "PUT": hmPut
  of "PATCH": hmPatch
  of "DELETE": hmDelete
  of "HEAD": hmHead
  of "OPTIONS": hmOptions
  else: hmOther

proc hexValue(ch: char): int =
  case ch
  of '0' .. '9': ord(ch) - ord('0')
  of 'a' .. 'f': ord(ch) - ord('a') + 10
  of 'A' .. 'F': ord(ch) - ord('A') + 10
  else: -1

proc decodePath(raw: string): string =
  var index = 0
  while index < raw.len:
    let ch = raw[index]
    if ch == '%':
      if index + 2 >= raw.len:
        fail(400, "path contains an invalid escape")
      let high = hexValue(raw[index + 1])
      let low = hexValue(raw[index + 2])
      if high < 0 or low < 0:
        fail(400, "path contains an invalid escape")
      let decoded = char((high shl 4) or low)
      if decoded == '\0' or decoded == '\\' or ord(decoded) < 32 or ord(decoded) == 127:
        fail(400, "path contains a forbidden character")
      result.add(decoded)
      index += 3
    else:
      if ch == '\0' or ch == '\\' or ord(ch) < 32 or ord(ch) == 127:
        fail(400, "path contains a forbidden character")
      result.add(ch)
      inc index

proc parseTarget(target: string): tuple[path: string, parts: seq[string]] =
  var rawPath = target
  if target.startsWith("http://") or target.startsWith("https://"):
    try:
      let parsed = parseUri(target)
      rawPath = parsed.path
    except UriParseError:
      fail(400, "request target is not a valid URL")
  if rawPath.len == 0 or not rawPath.startsWith("/") or rawPath.startsWith("//"):
    fail(400, "request target must be an absolute path")
  let queryStart = rawPath.find('?')
  if queryStart >= 0:
    rawPath = rawPath[0 ..< queryStart]
  if '#' in rawPath:
    fail(400, "request target must not contain a fragment")
  let decoded = decodePath(rawPath)
  var parts: seq[string]
  for part in decoded.split('/'):
    if part.len == 0 or part == ".":
      continue
    if part == "..":
      fail(400, "path traversal is not allowed")
    parts.add(part)
  result.path = "/" & parts.join("/")
  result.parts = parts

proc readLine(socket: AsyncSocket): Future[tuple[text: string, eof: bool]] {.async.} =
  var line = newFutureVar[string]()
  let reading = socket.recvLineInto(line, maxLength = MaxLineBytes)
  if not await withTimeout(reading, ReadTimeoutMs):
    fail(408, "request timed out")
  let text = line.mget
  if text.len == 0:
    return ("", true)
  if text.len > MaxLineBytes:
    fail(413, "request line is too large")
  if text == "\r\n":
    return ("", false)
  result = (text, false)

proc appendExactly(socket: AsyncSocket; count: int; body: BodyBuffer) {.async.} =
  var remaining = count
  while remaining > 0:
    let wanted = min(remaining, 64 * 1024)
    let reading = socket.recv(wanted)
    if not await withTimeout(reading, ReadTimeoutMs):
      fail(408, "request timed out")
    let chunk = reading.read()
    if chunk.len == 0:
      raise newException(ClientGone, "client disconnected")
    body.data.add(chunk)
    remaining -= chunk.len

proc contentLength(value: string; cap: int): int =
  let text = value.strip
  if text.len == 0:
    fail(400, "invalid Content-Length")
  var total = 0'i64
  for ch in text:
    if ch notin {'0' .. '9'}:
      fail(400, "invalid Content-Length")
    total = total * 10 + int64(ord(ch) - ord('0'))
    if total > int64(cap):
      fail(413, "request body exceeds " & $cap & " bytes")
  int(total)

proc chunkSize(line: string; remaining: int): int =
  let text = line.split(';')[0].strip
  if text.len == 0:
    fail(400, "invalid chunk size")
  var total = 0'i64
  for ch in text:
    let digit = hexValue(ch)
    if digit < 0:
      fail(400, "invalid chunk size")
    total = total * 16 + int64(digit)
    if total > int64(remaining):
      fail(413, "request body exceeds the configured limit")
  int(total)

proc validHeaderName(name: string): bool =
  if name.len == 0: return false
  for ch in name:
    if not (ch in {'A' .. 'Z', 'a' .. 'z', '0' .. '9'} or ch in {'!', '#', '$',
        '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~'}):
      return false
  true

proc appendSeparator(socket: AsyncSocket): Future[string] {.async.} =
  var separator = BodyBuffer()
  await appendExactly(socket, 2, separator)
  separator.data

proc readChunkedBody(socket: AsyncSocket; cap: int): Future[string] {.async.} =
  var buffer = BodyBuffer(data: newStringOfCap(min(cap, 64 * 1024)))
  while true:
    let line = await readLine(socket)
    if line.eof:
      raise newException(ClientGone, "client disconnected")
    let count = chunkSize(line.text, cap - buffer.data.len)
    if count == 0:
      var trailerBytes = 0
      var trailerCount = 0
      while true:
        let trailer = await readLine(socket)
        if trailer.eof:
          raise newException(ClientGone, "client disconnected")
        if trailer.text.len == 0: break
        inc trailerCount
        trailerBytes += trailer.text.len + 2
        if trailerCount > 100 or trailerBytes > MaxHeaderBytes:
          fail(413, "request trailers are too large")
      break
    await appendExactly(socket, count, buffer)
    let separator = await appendSeparator(socket)
    if separator != "\r\n":
      fail(400, "invalid chunk separator")
  result = move(buffer.data)

proc readRequest(socket: AsyncSocket; cap: int): Future[IncomingRequest] {.async.} =
  let first = await readLine(socket)
  if first.eof:
    raise newException(ClientGone, "client disconnected")
  let fields = first.text.strip.splitWhitespace()
  if fields.len != 3:
    fail(400, "invalid request line")
  if fields[2] notin ["HTTP/1.0", "HTTP/1.1"]:
    fail(400, "unsupported HTTP version")
  result.reqMethod = parseMethod(fields[0])
  result.target = fields[1]
  result.client = socket
  let target = parseTarget(fields[1])
  result.path = target.path
  result.parts = target.parts
  result.headers = initTable[string, string]()
  var headerBytes = first.text.len + 2
  while true:
    let line = await readLine(socket)
    if line.eof:
      raise newException(ClientGone, "client disconnected")
    if line.text.len == 0: break
    headerBytes += line.text.len + 2
    if headerBytes > MaxHeaderBytes:
      fail(413, "request headers are too large")
    if line.text[0] in {' ', '\t'}:
      fail(400, "obsolete header folding is not allowed")
    let colon = line.text.find(':')
    if colon <= 0:
      fail(400, "invalid header line")
    let name = line.text[0 ..< colon].strip
    if not validHeaderName(name):
      fail(400, "invalid header name")
    let key = name.toLowerAscii
    let value = line.text[colon + 1 .. ^1].strip
    if key in ["content-length", "transfer-encoding", "host", "expect", "origin"] and
        result.headers.hasKey(key):
      fail(400, "duplicate " & name & " header")
    if result.headers.hasKey(key):
      result.headers[key] = result.headers[key] & ", " & value
    else:
      result.headers[key] = value

  let hasLength = result.headers.hasKey("content-length")
  let chunked = result.headers.hasKey("transfer-encoding")
  if hasLength and chunked:
    fail(400, "Content-Length and Transfer-Encoding cannot both be present")
  if chunked and result.headers["transfer-encoding"].toLowerAscii.strip != "chunked":
    fail(501, "only chunked transfer encoding is supported")
  let expectsContinue = result.headers.hasKey("expect")
  if expectsContinue and result.headers["expect"].toLowerAscii.strip != "100-continue":
    fail(417, "unsupported Expect header")
  if hasLength:
    let count = contentLength(result.headers["content-length"], cap)
    if expectsContinue:
      await socket.send("HTTP/1.1 100 Continue\r\n\r\n")
    var body = BodyBuffer()
    await appendExactly(socket, count, body)
    result.body = move(body.data)
  elif chunked:
    if expectsContinue:
      await socket.send("HTTP/1.1 100 Continue\r\n\r\n")
    result.body = await readChunkedBody(socket, cap)

proc isLoopbackHost(value: string): bool =
  match(value.strip, loopbackPattern)

proc originHost(value: string): string =
  try:
    let parsed = parseUri(value)
    if parsed.scheme notin ["http", "https"] or parsed.hostname.len == 0:
      return ""
    var host = parsed.hostname
    if ':' in host and not host.startsWith("["):
      host = "[" & host & "]"
    if parsed.port.len > 0:
      host.add(":" & parsed.port)
    host
  except UriParseError:
    ""

proc refuse(req: IncomingRequest) =
  let host = req.headers.getOrDefault("host")
  if not isLoopbackHost(host):
    fail(403, "refusing host \"" & host & "\": sketchdex only answers on localhost")
  if req.reqMethod in {hmPost, hmPut, hmPatch, hmDelete} and req.headers.hasKey("origin"):
    let origin = req.headers["origin"]
    if not isLoopbackHost(originHost(origin)):
      fail(403, "refusing cross-site request from \"" & origin & "\"")

proc readJsonBody(req: IncomingRequest): JsonNode =
  if req.body.len == 0:
    return newJObject()
  let contentType = req.headers.getOrDefault("content-type").toLowerAscii
  if not contentType.startsWith("application/json"):
    fail(415, "send the body as application/json")
  try:
    parseJson(req.body)
  except JsonParsingError:
    fail(400, "body is not valid JSON")

proc objectBody(req: IncomingRequest): JsonNode =
  result = readJsonBody(req)
  if result.isNil or result.kind != JObject:
    fail(400, "body must be a JSON object")

proc textField(body: JsonNode; key: string): string =
  let value = body.field(key)
  if value.isNil or value.kind != JString: "" else: value.getStr

proc boolField(body: JsonNode; key: string; fallback: bool): bool =
  let value = body.field(key)
  if value.isNil or value.kind == JNull: fallback
  elif value.kind == JBool: value.getBool
  else: fail(400, key & " must be a boolean")

proc intField(body: JsonNode; key: string; fallback: int): int =
  let value = body.field(key)
  if value.isNil or value.kind == JNull: fallback
  elif value.kind == JInt: int(value.getInt)
  elif value.kind == JFloat: int(value.getFloat)
  else: fail(400, key & " must be a number")

proc revisionOption(body: JsonNode): Option[string] =
  let value = body.field("ifRev")
  if value.isNil or value.kind == JNull:
    none(string)
  elif value.kind == JString:
    some(value.getStr)
  else:
    fail(400, "ifRev must be a string")

proc sceneIdOf(value: JsonNode): string =
  if value.isNil or value.kind != JObject: return ""
  value.field("sceneId").stringOr("")

proc statusOf(error: ref CatchableError): int =
  if error of HttpFailure:
    HttpFailure(error[]).status
  elif error of BadIdError:
    BadIdError(error[]).status
  elif error of SceneConflict:
    SceneConflict(error[]).status
  elif error of AgentError:
    AgentError(error[]).status
  elif error of CommentError:
    CommentError(error[]).status
  elif error of JsonParsingError:
    400
  elif error of ValueError:
    let message = error.msg
    if message == "bad id" or message.startsWith("label is required"):
      400
    elif message.startsWith("no scene matching"):
      404
    elif message.contains("matches ") and " scenes" in message:
      409
    else:
      500
  elif error of IOError or error of OSError:
    let message = error.msg.toLowerAscii
    if "no such file" in message or "not found" in message:
      404
    else:
      500
  else:
    let message = error.msg
    if message.startsWith("no scene matching") or message.contains("matches ") and
        " scenes" in message:
      404
    elif message.startsWith("bad id"):
      400
    else:
      500

proc errorResponse(error: ref CatchableError): JsonNode =
  var body = %*{"error": errorMessage(error)}
  if error of SceneConflict:
    let conflict = SceneConflict(error[])
    body["code"] = %conflict.code
    body["rev"] = %conflict.currentRev
  body

proc newWatcher*(api: AgentApi): Watcher =
  Watcher(
    api: api,
    clients: @[],
    recent: initTable[string, WriteNote](),
    changes: @[],
    closed: false
  )

proc enqueueChange(watcher: Watcher; change: filewatch.WatchChange) {.gcsafe.} =
  watcher.changeLock.withLock:
    if not watcher.closed:
      watcher.changes.add(change)

proc takeChanges(watcher: Watcher): seq[filewatch.WatchChange] =
  watcher.changeLock.withLock:
    result = watcher.changes
    watcher.changes.setLen(0)

proc dropClient(watcher: Watcher; client: SseClient) =
  client.closed = true
  var index = 0
  while index < watcher.clients.len:
    if watcher.clients[index] == client:
      watcher.clients.delete(index)
      return
    inc index

proc queue(watcher: Watcher; frame: string) =
  var index = 0
  while index < watcher.clients.len:
    let client = watcher.clients[index]
    if client.closed or client.socket.isClosed:
      watcher.clients.delete(index)
    else:
      client.pending.add(frame)
      inc index

proc push*(watcher: Watcher; event: JsonNode) =
  watcher.queue("data: " & $event & "\n\n")

proc noteWrite*(watcher: Watcher; sceneId, by: string;
    revision: Option[string] = none(string)) =
  if sceneId.len == 0: return
  watcher.recent[sceneId] = WriteNote(
    by: if by.len > 0: by else: "app",
    at: getMonoTime(),
    rev: revision
  )

proc announce(watcher: Watcher; change: filewatch.WatchChange) =
  let sceneId = change.sceneId
  if change.kind == filewatch.changeRemoved:
    watcher.recent.del(sceneId)
    watcher.push(%*{"type": "removed", "id": sceneId, "at": nowMs()})
    return
  let current = watcher.api.vault.rev(sceneId)
  if current.isNone:
    watcher.recent.del(sceneId)
    watcher.push(%*{"type": "removed", "id": sceneId, "at": nowMs()})
    return
  let revision = current.get
  var by = "external"
  if watcher.recent.hasKey(sceneId):
    let note = watcher.recent[sceneId]
    if note.rev.isSome:
      if note.rev.get == revision:
        by = note.by
    elif getMonoTime() - note.at < initDuration(milliseconds = EchoWindowMs):
      by = note.by
  var snapshot: JsonNode = nil
  if by == "external":
    try:
      snapshot = watcher.api.noteExternalChange(sceneId)
    except CatchableError:
      snapshot = nil
  watcher.push(%*{"type": "scene", "id": sceneId, "by": by, "at": nowMs()})
  if not snapshot.isNil and snapshot.kind != JNull:
    watcher.push(%*{"type": "history", "id": sceneId})

proc watcherLoop(watcher: Watcher) {.async.} =
  try:
    while not watcher.closed:
      await sleepAsync(ScanIntervalMs)
      for change in watcher.takeChanges():
        watcher.announce(change)
  except CatchableError as error:
    if not watcher.closed:
      stderr.writeLine("[sketchdex] watcher failed: " & error.msg)

proc close*(watcher: Watcher) =
  watcher.closed = true
  watcher.changeLock.withLock:
    watcher.changes.setLen(0)
  for client in watcher.clients:
    client.closed = true
    client.socket.close()
  watcher.clients.setLen(0)

proc sendSseChunk(socket: AsyncSocket; data: string): Future[void] {.async.} =
  await socket.send(toHex(data.len) & "\r\n" & data & "\r\n")

proc serveSse(req: IncomingRequest, watcher: Watcher): Future[void] {.async.} =
  if req.reqMethod != hmGet:
    methodNotAllowed("GET")
  let client = SseClient(socket: req.client)
  watcher.clients.add(client)
  try:
    await req.client.send(
      "HTTP/1.1 200 OK\r\n" &
      "Content-Type: text/event-stream\r\n" &
      "Cache-Control: no-cache, no-transform\r\n" &
      "Connection: keep-alive\r\n" &
      "Transfer-Encoding: chunked\r\n" &
      "X-Accel-Buffering: no\r\n\r\n"
    )
    await sendSseChunk(req.client, "retry: 2000\n\n")
    let disconnected = req.client.recv(1)
    var nextHeartbeat = getMonoTime() + initDuration(milliseconds = HeartbeatMs)
    while not client.closed and not req.client.isClosed:
      await sleepAsync(ScanIntervalMs) or disconnected
      if disconnected.finished:
        break
      if client.pending.len > 0:
        let frames = move(client.pending)
        client.pending = @[]
        for frame in frames:
          await sendSseChunk(req.client, frame)
      let now = getMonoTime()
      if now >= nextHeartbeat:
        await sendSseChunk(req.client, ": heartbeat 25s\n\n")
        nextHeartbeat = now + initDuration(milliseconds = HeartbeatMs)
  except CatchableError:
    discard
  finally:
    watcher.dropClient(client)
    try:
      await req.client.send("0\r\n\r\n")
    except CatchableError:
      discard

proc mimeType(path: string): string =
  case splitFile(path).ext.toLowerAscii
  of ".html": "text/html; charset=utf-8"
  of ".js", ".mjs": "text/javascript; charset=utf-8"
  of ".css": "text/css; charset=utf-8"
  of ".json": "application/json; charset=utf-8"
  of ".svg": "image/svg+xml"
  of ".png": "image/png"
  of ".jpg", ".jpeg": "image/jpeg"
  of ".woff2": "font/woff2"
  of ".woff": "font/woff"
  of ".ttf": "font/ttf"
  of ".webmanifest": "application/manifest+json"
  else: "application/octet-stream"

proc inside(root, file: string): bool =
  let relative = relativePath(file, root)
  relative.len > 0 and not relative.startsWith("..") and not isAbsolute(relative)

proc serveStatic(req: IncomingRequest, server: HttpServer): Future[void] {.async.} =
  if req.reqMethod notin {hmGet, hmHead}:
    methodNotAllowed("GET", "HEAD")
  let root = expandFilename(server.assetsDir)
  var file = root
  if req.parts.len > 0:
    file = file / req.parts.join("/")
  if not fileExists(file) or dirExists(file):
    file = root / "index.html"
  elif not inside(root, expandFilename(file)):
    fail(404, "asset is outside the assets directory")
  let body =
    try:
      readFile(file)
    except IOError:
      fail(404, "asset not found")
  await sendResponse(req.client, 200, body, mimeType(file), head = req.reqMethod == hmHead)

proc sendAgentResult(req: IncomingRequest, server: HttpServer; value: JsonNode) {.async.} =
  let sceneId = sceneIdOf(value)
  if sceneId.len > 0:
    server.watcher.noteWrite(sceneId, "agent", server.api.vault.rev(sceneId))
  await sendJson(req.client, 200, value)

proc routeAgent(req: IncomingRequest, server: HttpServer) {.async.} =
  let api = server.api
  if req.reqMethod == hmGet and req.parts.len == 1:
    await sendJson(req.client, 200, %*{"ops": AgentOps})
    return
  if req.reqMethod != hmPost or req.parts.len != 2:
    methodNotAllowed("GET", "POST")
  let op = req.parts[1]
  if op notin AgentOps:
    fail(404, "unknown op \"" & op & "\"")
  let body = objectBody(req)
  var result: JsonNode
  case op
  of "list":
    result = api.listScenes()
  of "describe":
    result = api.describeScene(textField(body, "scene"),
      intField(body, "limit", 400), textField(body, "type"))
  of "read":
    result = api.readScene(textField(body, "scene"), body)
  of "elements":
    result = api.readElements(textField(body, "scene"), body)
  of "path":
    result = api.scenePath(textField(body, "scene"))
  of "create":
    result = api.createScene(
      if textField(body, "name").len > 0: textField(body, "name") else: "Untitled",
      body.field("elements"))
  of "add":
    result = api.addElements(textField(body, "scene"), body.field("elements"),
      textField(body, "label"))
  of "update":
    result = api.updateElements(textField(body, "scene"), body.field("elements"),
      textField(body, "label"), body.field("ids"), body.field("patch"))
  of "delete":
    result = api.deleteElements(textField(body, "scene"), body.field("ids"),
      textField(body, "label"))
  of "move":
    result = api.moveElements(textField(body, "scene"), body, textField(body, "label"))
  of "replace":
    result = api.replaceElements(textField(body, "scene"), body.field("elements"),
      textField(body, "label"))
  of "write":
    result = api.writeScene(textField(body, "scene"), body.field("elements"),
      body.field("appState"), textField(body, "label"))
  of "background":
    result = api.setBackground(textField(body, "scene"), textField(body, "color"),
      textField(body, "label"))
  of "snapshot":
    result = api.snapshotScene(textField(body, "scene"), textField(body, "label"))
  of "svg":
    result = api.importSvg(textField(body, "scene"), textField(body, "svg"), body,
      textField(body, "label"))
  of "check":
    result = api.checkScene(textField(body, "scene"), body)
  of "history":
    result = api.listHistory(textField(body, "scene"))
  of "restore":
    result = api.restoreSnapshot(textField(body, "scene"), textField(body, "snapshot"))
  of "discard":
    result = api.discardSnapshot(textField(body, "scene"), textField(body, "snapshot"))
  of "clear":
    result = api.clearHistory(textField(body, "scene"))
  of "comment-add":
    result = api.addComment(textField(body, "scene"), textField(body, "elementId"),
      textField(body, "body"), textField(body, "label"), textField(body, "author"),
      textField(body, "authorKind"))
  of "comment-list":
    result = api.listComments(textField(body, "scene"), textField(body, "elementId"),
      textField(body, "status"), intField(body, "limit", 500))
  of "comment-update":
    result = api.updateComment(textField(body, "scene"), textField(body, "elementId"),
      textField(body, "commentId"), textField(body, "action"), textField(body, "label"))
  of "build":
    let specs = body.field("specs")
    if specs.isNil:
      fail(400, "specs is required")
    let existing = body.field("existing")
    let ink = textField(body, "ink")
    let nowValue = body.field("now")
    let now =
      if not nowValue.isNil and nowValue.kind == JInt: nowValue.getInt
      else: nowMs()
    result = buildElements(specs, if existing.isNil: newJArray() else: existing,
      if ink.len > 0: ink else: "#1e1e1e", now)
  else:
    fail(404, "unknown op \"" & op & "\"")
  await sendAgentResult(req, server, result)

proc routeHistory(req: IncomingRequest, server: HttpServer; sceneId: string) {.async.} =
  let api = server.api
  if req.parts.len == 3:
    if req.reqMethod == hmGet:
      let listing = api.history.list(sceneId)
      await sendJson(req.client, 200, %*{"entries": listing.entries, "bytes": listing.bytes})
      return
    if req.reqMethod == hmDelete:
      discard api.history.clear(sceneId)
      server.watcher.push(%*{"type": "history", "id": sceneId})
      await sendJson(req.client, 200, %*{"entries": newJArray()})
      return
    methodNotAllowed("GET", "DELETE")
  let snapshotId = req.parts[3]
  if req.parts.len == 5 and req.parts[4] == "restore":
    if req.reqMethod != hmPost:
      methodNotAllowed("POST")
    let result = api.restoreSnapshot(sceneId, snapshotId)
    server.watcher.noteWrite(sceneId, "agent", api.vault.rev(sceneId))
    server.watcher.push(%*{"type": "history", "id": sceneId})
    await sendJson(req.client, 200, result)
  if req.parts.len == 4:
    if req.reqMethod == hmGet:
      await sendJson(req.client, 200, api.history.read(sceneId, snapshotId))
      return
    if req.reqMethod == hmDelete:
      let entries = api.history.discard(sceneId, snapshotId)
      server.watcher.push(%*{"type": "history", "id": sceneId})
      await sendJson(req.client, 200, %*{"entries": entries})
      return
    methodNotAllowed("GET", "DELETE")
  notFound()

proc routeScenes(req: IncomingRequest, server: HttpServer) {.async.} =
  let store = server.api.vault
  if req.parts.len == 1:
    if req.reqMethod == hmGet:
      await sendJson(req.client, 200, store.list())
      return
    if req.reqMethod == hmPost:
      let body = objectBody(req)
      let imported = body.field("import")
      if not imported.isNil and imported.kind != JNull:
        await sendJson(req.client, 200, store.importScene(imported))
      else:
        let name = textField(body, "name")
        await sendJson(req.client, 200, store.create(
          if name.len > 0: name else: "Untitled"))
      return
    methodNotAllowed("GET", "POST")

  let sceneId = req.parts[1]
  if req.parts.len >= 3:
    case req.parts[2]
    of "history":
      await routeHistory(req, server, sceneId)
    of "thumb":
      if req.parts.len != 3: notFound()
      if req.reqMethod == hmGet:
        await sendJson(req.client, 200, %*{"svg": store.readThumb(sceneId)})
      elif req.reqMethod == hmPut:
        let body = objectBody(req)
        store.writeThumb(sceneId, textField(body, "svg"))
        await sendJson(req.client, 200, %*{"ok": true})
      else:
        methodNotAllowed("GET", "PUT")
    of "duplicate":
      if req.parts.len != 3: notFound()
      if req.reqMethod != hmPost: methodNotAllowed("POST")
      await sendJson(req.client, 200, store.duplicate(sceneId))
    else:
      notFound()
    return

  if req.parts.len != 2: notFound()
  case req.reqMethod
  of hmGet:
    let path = store.scenePath(sceneId)
    if path.isNone:
      fail(400, "bad id")
    if not fileExists(path.get):
      notFound()
    let payload = store.read(sceneId)
    server.api.observe(sceneId, payload)
    await sendJson(req.client, 200, payload)
  of hmPut:
    let body = objectBody(req)
    let payload = body.field("payload")
    if payload.isNil:
      fail(400, "payload is required")
    let options = SaveOptions(
      touch: boolField(body, "touch", true),
      ifRev: revisionOption(body)
    )
    let scenePath = store.scenePath(sceneId)
    if scenePath.isSome and fileExists(scenePath.get):
      try:
        let current = store.read(sceneId)
        let adopted = adoptComments(payload.field("elements"),
          current.field("elements"))
        if not adopted.isNil: payload["elements"] = adopted
      except CatchableError:
        discard
    let client = req.headers.getOrDefault("x-sketchdex-client")
    server.watcher.noteWrite(sceneId, client)
    try:
      let scenes = store.save(sceneId, payload, options)
      let revision = store.rev(sceneId)
      server.watcher.noteWrite(sceneId, client, revision)
      server.api.observe(sceneId, payload)
      await sendJson(req.client, 200, %*{"scenes": scenes, "rev": revision})
    except SceneConflict as conflict:
      server.watcher.noteWrite(sceneId, "external")
      await sendJson(req.client, 409, %*{
        "error": conflict.msg,
        "code": conflict.code,
        "rev": conflict.currentRev
      })
  of hmPatch:
    let body = objectBody(req)
    let client = req.headers.getOrDefault("x-sketchdex-client")
    server.watcher.noteWrite(sceneId, client)
    let scenes = store.patch(sceneId, body)
    server.watcher.noteWrite(sceneId, client, store.rev(sceneId))
    await sendJson(req.client, 200, scenes)
  of hmDelete:
    try:
      discard server.api.history.clear(sceneId)
    except CatchableError:
      discard
    server.api.invalidateScene(sceneId)
    await sendJson(req.client, 200, store.delete(sceneId))
  else:
    methodNotAllowed("GET", "PUT", "PATCH", "DELETE")

proc routeApi(req: IncomingRequest, server: HttpServer) {.async.} =
  refuse(req)
  if req.parts.len == 0:
    notFound()
  case req.parts[0]
  of "vault":
    if req.parts.len != 1: notFound()
    if req.reqMethod != hmGet: methodNotAllowed("GET")
    await sendJson(req.client, 200, %*{"vault": server.api.vault.root})
  of "events":
    if req.parts.len != 1: notFound()
    await serveSse(req, server.watcher)
  of "agent":
    await routeAgent(req, server)
  of "scenes":
    await routeScenes(req, server)
  else:
    notFound()

proc serveMcp(req: IncomingRequest, server: HttpServer): Future[void] {.async.} =
  if req.reqMethod != hmPost:
    methodNotAllowed("POST")
  if req.body.len == 0:
    fail(400, "body is not valid JSON")
  let contentType = req.headers.getOrDefault("content-type").toLowerAscii
  if not contentType.startsWith("application/json"):
    fail(415, "send the body as application/json")
  let valid =
    try:
      discard parseJson(req.body)
      true
    except JsonParsingError:
      false
  let dispatcher = proc(name: string, args: JsonNode): JsonNode =
    dispatchAgent(server.api, name, args, server.api.vault.root)
  let response = handleMcpRequest(req.body, dispatcher)
  if not valid:
    await sendResponse(req.client, 400, response, "application/json")
  elif response.len == 0:
    await sendResponse(req.client, 202, "", "application/json")
  else:
    await sendResponse(req.client, 200, response, "application/json")

proc route(req: IncomingRequest, server: HttpServer): Future[void] {.async.} =
  if req.path == "/mcp":
    refuse(req)
    await serveMcp(req, server)
  elif req.path == "/api" or req.path.startsWith("/api/"):
    var apiRequest = req
    apiRequest.parts = req.parts[1 .. ^1]
    await routeApi(apiRequest, server)
  else:
    await serveStatic(req, server)

proc handleConnection(socket: AsyncSocket, server: HttpServer) {.async.} =
  try:
    let request = await readRequest(socket, server.maxBodyBytes)
    await route(request, server)
  except ClientGone:
    discard
  except HttpFailure as error:
    try:
      await sendJsonError(socket, error)
    except CatchableError:
      discard
  except CatchableError as error:
    let status = statusOf(error)
    if status >= 500:
      stderr.writeLine("[sketchdex] request failed: " & error.msg)
    try:
      await sendJson(socket, status, errorResponse(error))
    except CatchableError:
      discard
  finally:
    socket.close()

proc watchCallback(hub: Watcher): filewatch.WatchCallback =
  proc(change: filewatch.WatchChange) {.gcsafe.} =
    hub.enqueueChange(change)

proc newHttpServer*(vaultPath, assetsDir: string;
    maxBodyBytes = DefaultMaxBodyBytes): HttpServer =
  if maxBodyBytes <= 0:
    raise newException(ValueError, "max body size must be positive")
  let assets = absolutePath(assetsDir)
  if not fileExists(assets / "index.html"):
    raise newException(IOError, "no built app found at " & assets / "index.html")
  result = HttpServer(
    assetsDir: assets,
    maxBodyBytes: maxBodyBytes,
    port: Port(0),
    url: ""
  )
  result.api = newAgentApi(vaultPath)
  result.watcher = newWatcher(result.api)
  result.fileWatch = filewatch.newWatcher(result.api.vault,
    watchCallback(result.watcher))

proc listen*(server: HttpServer; port: Port) {.async.} =
  server.socket = newAsyncSocket()
  try:
    server.socket.bindAddr(port, "127.0.0.1")
    server.socket.listen()
  except CatchableError:
    server.socket.close()
    raise
  let (_, bound) = server.socket.getLocalAddr()
  server.port = bound
  server.url = "http://127.0.0.1:" & $int(bound)
  server.fileWatch.start()
  asyncCheck watcherLoop(server.watcher)

proc serve*(server: HttpServer) {.async.} =
  while true:
    let (_, client) = await server.socket.acceptAddr()
    asyncCheck handleConnection(client, server)

proc close*(server: HttpServer) =
  server.socket.close()
  server.watcher.close()
  server.fileWatch.close()
