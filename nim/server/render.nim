import std/[asyncdispatch, asynchttpserver, asyncfutures, atomics, base64,
  envvars, httpcore, json, math, monotimes, options, os,
  strutils, tempfiles, times, uri]

when defined(posix):
  import std/posix

import ../core/jsvalue

when defined(windows):
  import std/[winlean, widestrs]
elif not defined(posix):
  {.error: "render orchestration requires POSIX or Windows".}

type
  BrowserNotFoundError* = object of CatchableError
  RenderError* = object of CatchableError

  Region = object
    x, y, width, height: float

  RenderOptions = object
    scale, maxWidth: float
    dark, transparent: bool
    region: Option[Region]
    ids: seq[string]
    tiles, inlineLimit: int

  BrowserProcess = object
    active: bool
    stderrPath: string
    when defined(posix):
      pid: Pid
      reaped: bool
    elif defined(windows):
      processHandle, threadHandle, jobHandle: Handle
      reaped: bool

  RenderListener = ref object
    token, distRoot, payload: string
    result: Future[JsonNode]

const
  DeadlineMs = 60_000
  RequestReadTimeoutMs = 10_000
  MaxOtherBodyBytes = 1024 * 1024
  MaxResultBodyBytes = 256 * 1024 * 1024
  RenderKeepFor = 24 * 60 * 60 * 1_000_000_000'i64
  CookieName = "sketchdex_render"

when defined(posix):
  var spawnErrno {.importc: "errno", header: "<errno.h>".}: cint
  var spawnEintr {.importc: "EINTR", header: "<errno.h>".}: cint

elif defined(windows):
  type
    IoCounters = object
      readOperationCount, writeOperationCount, otherOperationCount: uint64
      readTransferCount, writeTransferCount, otherTransferCount: uint64

    JobBasicLimitInformation = object
      perProcessUserTimeLimit, perJobUserTimeLimit: int64
      limitFlags: DWORD
      minimumWorkingSetSize, maximumWorkingSetSize: uint
      activeProcessLimit: DWORD
      affinity: uint
      priorityClass, schedulingClass: DWORD

    JobExtendedLimitInformation = object
      basicLimitInformation: JobBasicLimitInformation
      ioInfo: IoCounters
      processMemoryLimit, jobMemoryLimit: uint
      peakProcessMemoryUsed, peakJobMemoryUsed: uint

  const
    CreateSuspended = 0x0000_0004'i32
    JobObjectExtendedLimitInformation = 9'i32
    JobObjectLimitKillOnJobClose = 0x0000_2000'i32

  proc createJobObjectW(attributes: pointer; name: WideCString): Handle {.
      stdcall, dynlib: "kernel32", importc: "CreateJobObjectW".}
  proc assignProcessToJobObject(job, process: Handle): WINBOOL {.
      stdcall, dynlib: "kernel32", importc: "AssignProcessToJobObject".}
  proc setInformationJobObject(job: Handle; infoClass: int32;
      info: pointer; infoLength: int32): WINBOOL {.
      stdcall, dynlib: "kernel32", importc: "SetInformationJobObject".}
  proc terminateJobObject(job: Handle; exitCode: int): WINBOOL {.
      stdcall, dynlib: "kernel32", importc: "TerminateJobObject".}
  proc systemFunction036(buffer: pointer; length: cint): uint8 {.
      stdcall, dynlib: "advapi32", importc: "SystemFunction036".}

  proc windowsError(operation: string): ref RenderError =
    newException(RenderError, operation & ": Windows error " & $getLastError())

proc secureRandomHex(byteCount: int): string =
  var bytes: array[32, uint8]
  doAssert byteCount <= bytes.len
  when defined(posix):
    let file = open("/dev/urandom", fmRead)
    try:
      var offset = 0
      while offset < byteCount:
        let count = readBuffer(file, addr bytes[offset], byteCount - offset)
        if count <= 0: raise newException(RenderError, "could not read secure randomness")
        offset += count
    finally:
      file.close()
  elif defined(windows):
    if systemFunction036(addr bytes[0], cint(byteCount)) == 0:
      raise newException(RenderError, "could not read secure randomness")
  const digits = "0123456789abcdef"
  result = newStringOfCap(byteCount * 2)
  for index in 0 ..< byteCount:
    result.add(digits[int(bytes[index]) shr 4])
    result.add(digits[int(bytes[index]) and 0x0f])

proc expandBrowserPath(path: string): string =
  if path.startsWith("~"): expandTilde(path) else: path

proc executablePath(path: string): Option[string] =
  let expanded = absolutePath(expandBrowserPath(path))
  if fileExists(expanded) and not dirExists(expanded): some(expanded)
  else: none(string)

proc findInPath(name: string): Option[string] =
  let found = findExe(name)
  if found.len > 0: some(absolutePath(found))
  else: none(string)

proc resolveBrowser(): string =
  let forced = getEnv("SKETCHDEX_BROWSER").strip
  if forced.len == 0:
    raise newException(BrowserNotFoundError,
      "render_scene needs SKETCHDEX_BROWSER set to the path of a Chromium-based browser")
  let direct = executablePath(forced)
  if direct.isSome: return direct.get
  let named = findInPath(forced)
  if named.isSome: return named.get
  raise newException(BrowserNotFoundError,
    "SKETCHDEX_BROWSER does not point to an executable browser: " & forced)

var renderAssetsOverride = ""

proc setRenderAssets*(path: string) =
  renderAssetsOverride = path

proc distRoot(): string =
  let configured = getEnv("SKETCHDEX_ASSETS")
  if configured.len > 0: return absolutePath(expandBrowserPath(configured))
  if renderAssetsOverride.len > 0:
    return absolutePath(expandBrowserPath(renderAssetsOverride))
  let renderConfigured = getEnv("SKETCHDEX_DIST")
  if renderConfigured.len > 0: absolutePath(expandBrowserPath(renderConfigured))
  else:
    for candidate in [getAppDir() / ".." / "dist", getCurrentDir() / "dist"]:
      if fileExists(candidate / "render.html"): return candidate
    currentSourcePath().parentDir.parentDir / "dist"

proc outputRoot(): string =
  getTempDir() / "sketchdex-renders"

proc pruneOldOutput() =
  let root = outputRoot()
  createDir(root)
  let cutoff = getTime() - initDuration(nanoseconds = RenderKeepFor)
  for path in walkFiles(root / "*"):
    try:
      if getFileInfo(path).lastWriteTime < cutoff: removeFile(path)
    except OSError:
      discard

proc numberValue(node: JsonNode; key: string; fallback: float): float =
  let value = node.field(key)
  if value.isNil or value.kind == JNull: return fallback
  if not value.isFiniteNumber:
    raise newException(ValueError, "render option " & key & " must be a finite number")
  value.getFloat

proc boolValue(node: JsonNode; key: string; fallback: bool): bool =
  let value = node.field(key)
  if value.isNil or value.kind == JNull: return fallback
  if value.kind != JBool:
    raise newException(ValueError, "render option " & key & " must be a boolean")
  value.getBool

proc parseRenderOptions(node: JsonNode): RenderOptions =
  let options = if node.isNil: newJObject() else: node
  if options.kind != JObject:
    raise newException(ValueError, "render options must be an object")

  var scale = numberValue(options, "scale", 1.0)
  var maxWidth = numberValue(options, "maxWidth", 1400.0)
  if scale <= 0: scale = 1.0
  if maxWidth <= 0: maxWidth = 1400.0

  let tilesValue = numberValue(options, "tiles", 1.0)
  let tiles = max(1, min(8, int(round(tilesValue))))
  let inlineValue = numberValue(options, "inlineLimit", 150_000.0)
  if inlineValue > high(int).float or inlineValue < 1:
    raise newException(ValueError, "render option inlineLimit must be a positive integer")

  result = RenderOptions(
    scale: scale,
    maxWidth: maxWidth,
    dark: boolValue(options, "dark", false),
    transparent: boolValue(options, "transparent", false),
    ids: @[],
    tiles: tiles,
    inlineLimit: int(inlineValue)
  )

  let ids = options.field("ids")
  if not ids.isNil and ids.kind != JNull:
    if ids.kind != JArray:
      raise newException(ValueError, "render option ids must be an array")
    for id in ids:
      if id.kind != JString:
        raise newException(ValueError, "render option ids must contain strings")
      result.ids.add(id.getStr)

  let region = options.field("region")
  if not region.isNil and region.kind != JNull:
    if region.kind != JObject:
      raise newException(ValueError, "render option region must be an object")
    result.region = some(Region(
      x: numberValue(region, "x", 0.0),
      y: numberValue(region, "y", 0.0),
      width: numberValue(region, "width", 0.0),
      height: numberValue(region, "height", 0.0)
    ))

proc scenePayload(scene: JsonNode): string =
  if scene.isNil or scene.kind != JObject:
    raise newException(ValueError, "scene must be an object")
  let elements = scene.field("elements")
  let appState = scene.field("appState")
  let files = scene.field("files")
  if not elements.isNil and elements.kind != JNull and elements.kind != JArray:
    raise newException(ValueError, "scene elements must be an array")
  if not appState.isNil and appState.kind != JNull and appState.kind != JObject:
    raise newException(ValueError, "scene appState must be an object")
  if not files.isNil and files.kind != JNull and files.kind != JObject:
    raise newException(ValueError, "scene files must be an object")
  $(%*{
    "elements": if elements.isNil or elements.kind == JNull: newJArray() else: elements,
    "appState": if appState.isNil or appState.kind == JNull: newJObject() else: appState,
    "files": if files.isNil or files.kind == JNull: newJObject() else: files
  })

proc browserFlags(profile, url: string): seq[string] =
  result = @[
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=Translate",
    "--user-data-dir=" & profile,
    "--window-size=1600,1200"
  ]
  when defined(posix):
    if getuid() == 0: result.add("--no-sandbox")
  result.add(url)

when defined(posix):
  proc checkSpawn(status: cint; operation: string) =
    if status != 0:
      raise newException(RenderError, operation & ": " & $strerror(status))

  proc spawnPosix(binary: string; arguments: seq[string]; stderrPath: string): Pid =
    var attributes: Tposix_spawnattr
    var actions: Tposix_spawn_file_actions
    checkSpawn(posix_spawn_file_actions_init(actions), "could not initialize browser file actions")
    defer: discard posix_spawn_file_actions_destroy(actions)
    checkSpawn(posix_spawnattr_init(attributes), "could not initialize browser attributes")
    defer: discard posix_spawnattr_destroy(attributes)

    var argvValues = @[binary]
    argvValues.add(arguments)
    let argv = allocCStringArray(argvValues)
    defer: deallocCStringArray(argv)
    var environmentValues: seq[string]
    for key, value in envPairs(): environmentValues.add(key & "=" & value)
    let environment = allocCStringArray(environmentValues)
    defer: deallocCStringArray(environment)

    checkSpawn(posix_spawn_file_actions_addopen(actions, 0, "/dev/null",
      O_RDONLY, 0.Mode), "could not redirect browser stdin")
    checkSpawn(posix_spawn_file_actions_addopen(actions, 1, "/dev/null",
      O_WRONLY, 0.Mode), "could not redirect browser stdout")
    checkSpawn(posix_spawn_file_actions_addopen(actions, 2, stderrPath.cstring,
      O_WRONLY or O_CREAT or O_TRUNC, 0o600.Mode), "could not redirect browser stderr")

    var signalMask: Sigset
    checkSpawn(sigemptyset(signalMask), "could not clear browser signal mask")
    checkSpawn(posix_spawnattr_setsigmask(attributes, signalMask),
      "could not set browser signal mask")
    checkSpawn(posix_spawnattr_setpgroup(attributes, 0),
      "could not create browser process group")
    let flags = POSIX_SPAWN_SETPGROUP or POSIX_SPAWN_SETSIGMASK
    checkSpawn(posix_spawnattr_setflags(attributes, flags),
      "could not set browser spawn flags")

    let status = posix_spawn(result, binary.cstring, actions, attributes,
      argv, environment)
    checkSpawn(status, "could not launch browser")

elif defined(windows):
  proc spawnWindows(binary: string; arguments: seq[string]; stderrPath: string): BrowserProcess =
    let job = createJobObjectW(nil, nil)
    if job == 0: raise windowsError("could not create browser job object")
    var keepJob = false
    defer:
      if not keepJob: discard closeHandle(job)

    var limits = JobExtendedLimitInformation()
    limits.basicLimitInformation.limitFlags = JobObjectLimitKillOnJobClose
    if setInformationJobObject(job, JobObjectExtendedLimitInformation,
        addr limits, int32(sizeof(limits))) == 0:
      raise windowsError("could not configure browser job object")

    let nullHandle = createFileW(newWideCString("NUL"),
      GENERIC_READ or GENERIC_WRITE, FILE_SHARE_READ or FILE_SHARE_WRITE,
      nil, OPEN_EXISTING, 0, 0)
    if nullHandle == INVALID_HANDLE_VALUE:
      raise windowsError("could not open NUL for browser")
    defer: discard closeHandle(nullHandle)
    let errorHandle = createFileW(newWideCString(stderrPath), GENERIC_WRITE,
      FILE_SHARE_READ or FILE_SHARE_WRITE or FILE_SHARE_DELETE, nil,
      CREATE_ALWAYS, 0, 0)
    if errorHandle == INVALID_HANDLE_VALUE:
      raise windowsError("could not open browser stderr file")
    defer: discard closeHandle(errorHandle)
    if setHandleInformation(nullHandle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0 or
        setHandleInformation(errorHandle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) == 0:
      raise windowsError("could not mark browser handles inheritable")

    var commandValues = @[binary]
    commandValues.add(arguments)
    let applicationName = newWideCString(binary)
    var commandLine = newWideCString(quoteShellCommand(commandValues))
    var startup = STARTUPINFO(
      cb: int32(sizeof(STARTUPINFO)),
      dwFlags: STARTF_USESTDHANDLES,
      hStdInput: nullHandle,
      hStdOutput: nullHandle,
      hStdError: errorHandle
    )
    var processInfo: PROCESS_INFORMATION
    if createProcessW(applicationName, commandLine, nil, nil, 1,
        CreateSuspended or CREATE_NO_WINDOW, nil, nil, startup, processInfo) == 0:
      raise windowsError("could not launch browser")

    var keepProcess = false
    defer:
      if not keepProcess:
        discard terminateProcess(processInfo.hProcess, 1)
        discard closeHandle(processInfo.hThread)
        discard closeHandle(processInfo.hProcess)

    if assignProcessToJobObject(job, processInfo.hProcess) == 0:
      raise windowsError("could not assign browser to job object")
    if resumeThread(processInfo.hThread) == -1:
      raise windowsError("could not resume browser")

    result = BrowserProcess(
      active: true,
      stderrPath: stderrPath,
      processHandle: processInfo.hProcess,
      threadHandle: processInfo.hThread,
      jobHandle: job
    )
    keepProcess = true
    keepJob = true

proc launchBrowser(binary: string; arguments: seq[string];
    stderrPath: string): BrowserProcess =
  when defined(posix):
    BrowserProcess(active: true, stderrPath: stderrPath,
      pid: spawnPosix(binary, arguments, stderrPath))
  elif defined(windows):
    spawnWindows(binary, arguments, stderrPath)

proc pollBrowser(browser: ptr BrowserProcess): tuple[active: bool, exitCode, signal: int] =
  when defined(posix):
    if browser.reaped: return (false, 0, 0)
    var status: cint
    let waited = waitpid(browser.pid, status, WNOHANG)
    if waited == 0: return (true, 0, 0)
    if waited < 0:
      if spawnErrno == spawnEintr: return (true, 0, 0)
      return (false, -1, 0)
    browser.reaped = true
    if WIFEXITED(status): return (false, int(WEXITSTATUS(status)), 0)
    if WIFSIGNALED(status): return (false, 0, int(WTERMSIG(status)))
    return (false, -1, 0)
  elif defined(windows):
    let waited = waitForSingleObject(browser.processHandle, 0)
    if waited == WAIT_TIMEOUT: return (true, 0, 0)
    if waited != WAIT_OBJECT_0: return (false, -1, 0)
    var code: int32
    if getExitCodeProcess(browser.processHandle, code) == 0:
      return (false, -1, 0)
    browser.reaped = true
    return (false, int(code), 0)

proc stopBrowser(browser: var BrowserProcess) =
  if not browser.active: return
  when defined(posix):
    discard posix.kill(-browser.pid, SIGKILL)
    discard posix.kill(browser.pid, SIGKILL)
    if not browser.reaped:
      while true:
        var status: cint
        let waited = waitpid(browser.pid, status, 0)
        if waited == browser.pid or (waited < 0 and spawnErrno != spawnEintr): break
    browser.reaped = true
  elif defined(windows):
    if browser.jobHandle != 0:
      discard terminateJobObject(browser.jobHandle, 1)
    if waitForSingleObject(browser.processHandle, 5_000) != WAIT_OBJECT_0:
      discard terminateProcess(browser.processHandle, 1)
      discard waitForSingleObject(browser.processHandle, 5_000)
    if browser.threadHandle != 0: discard closeHandle(browser.threadHandle)
    if browser.processHandle != 0: discard closeHandle(browser.processHandle)
    if browser.jobHandle != 0: discard closeHandle(browser.jobHandle)
    browser.threadHandle = 0
    browser.processHandle = 0
    browser.jobHandle = 0
    browser.reaped = true
  browser.active = false

proc browserStderrTail(browser: BrowserProcess): string =
  try:
    let text = readFile(browser.stderrPath)
    if text.len <= 500: text else: text[text.len - 500 .. text.len - 1]
  except IOError, OSError:
    ""

proc tokenMatches(actual, expected: string): bool =
  if actual.len != expected.len: return false
  var difference = 0
  for index in 0 ..< expected.len:
    difference = difference or (ord(actual[index]) xor ord(expected[index]))
  difference == 0

proc queryValue(query, key: string): string =
  for name, value in decodeQuery(query):
    if name == key: return value
  ""

proc cookieValue(headers: HttpHeaders): string =
  for part in string(headers.getOrDefault("Cookie")).split(';'):
    let separator = part.find('=')
    if separator > 0 and part[0 ..< separator].strip == CookieName:
      return part[separator + 1 .. part.len - 1].strip
  ""

proc authorized(request: Request, listener: RenderListener): bool =
  let queryToken = queryValue(request.url.query, "token")
  if queryToken.len > 0 and tokenMatches(queryToken, listener.token): return true
  let cookieToken = cookieValue(request.headers)
  cookieToken.len > 0 and tokenMatches(cookieToken, listener.token)

proc mimeType(path: string): string =
  case toLowerAscii(path.splitFile.ext)
  of ".html": "text/html; charset=utf-8"
  of ".js", ".mjs": "text/javascript; charset=utf-8"
  of ".css": "text/css; charset=utf-8"
  of ".json", ".map": "application/json; charset=utf-8"
  of ".svg": "image/svg+xml"
  of ".png": "image/png"
  of ".jpg", ".jpeg": "image/jpeg"
  of ".webp": "image/webp"
  of ".ico": "image/x-icon"
  of ".woff": "font/woff"
  of ".woff2": "font/woff2"
  of ".ttf": "font/ttf"
  of ".otf": "font/otf"
  of ".wasm": "application/wasm"
  of ".webmanifest": "application/manifest+json"
  else: "application/octet-stream"

proc responseHeaders(contentType: string; cookie = ""): HttpHeaders =
  var headers = @[
    ("Content-Type", contentType),
    ("Cache-Control", "no-store"),
    ("Connection", "close"),
    ("X-Content-Type-Options", "nosniff")
  ]
  if cookie.len > 0: headers.add(("Set-Cookie", cookie))
  newHttpHeaders(headers)

proc settleResult(listener: RenderListener; value: JsonNode) =
  if not listener.result.finished: listener.result.complete(value)

proc handleRequest(listener: RenderListener; request: Request): Future[void] {.async, gcsafe.} =
  if not authorized(request, listener):
    await request.respond(Http403, "Forbidden", responseHeaders("text/plain"))
    return

  let path =
    try: decodeUrl(request.url.path, decodePlus = false)
    except ValueError:
      await request.respond(Http400, "Bad Request", responseHeaders("text/plain"))
      return

  if path == "/__result":
    if request.reqMethod != HttpPost:
      await request.respond(Http405, "Method Not Allowed", responseHeaders("text/plain"))
      return
    if request.body.len > MaxResultBodyBytes:
      await request.respond(Http413, "Payload Too Large", responseHeaders("text/plain"))
      return
    if not toLowerAscii(string(request.headers.getOrDefault("Content-Type")))
        .startsWith("text/plain"):
      await request.respond(Http415, "Unsupported Media Type", responseHeaders("text/plain"))
      settleResult(listener, %*{"error": "render callback did not use text/plain"})
      return
    let parsed =
      try: parseJson(request.body)
      except JsonParsingError as error:
        settleResult(listener, %*{"error": "unreadable render result: " & error.msg})
        nil
    if not parsed.isNil and parsed.kind != JObject:
      settleResult(listener, %*{"error": "render result was not an object"})
    else:
      try:
        await request.respond(Http204, "", responseHeaders("application/json"))
      finally:
        if not parsed.isNil: settleResult(listener, parsed)
    return

  if request.body.len > MaxOtherBodyBytes:
    await request.respond(Http413, "Payload Too Large", responseHeaders("text/plain"))
    return
  if request.reqMethod != HttpGet:
    await request.respond(Http405, "Method Not Allowed", responseHeaders("text/plain"))
    return

  if path == "/__payload":
    await request.respond(Http200, listener.payload,
      responseHeaders("application/json; charset=utf-8"))
    return

  if path == "/" or path == "/render.html":
    let file = listener.distRoot / "render.html"
    try:
      let body = readFile(file)
      let cookie = CookieName & "=" & listener.token & "; Path=/; HttpOnly; SameSite=Strict"
      await request.respond(Http200, body, responseHeaders(mimeType(file), cookie))
    except IOError, OSError:
      await request.respond(Http404, "Not Found", responseHeaders("text/plain"))
    return

  if path.contains('\0') or path.contains('\\'):
    await request.respond(Http400, "Bad Request", responseHeaders("text/plain"))
    return
  var relative = path
  while relative.startsWith("/"): relative = relative[1 .. relative.len - 1]
  if relative.len == 0:
    await request.respond(Http404, "Not Found", responseHeaders("text/plain"))
    return
  var file = listener.distRoot / relative
  normalizePath(file)
  let fromRoot = relativePath(file, listener.distRoot)
  if fromRoot == ".." or fromRoot.startsWith("../") or
      fromRoot.startsWith("..\\") or isAbsolute(fromRoot):
    await request.respond(Http403, "Forbidden", responseHeaders("text/plain"))
    return
  if not fileExists(file) or dirExists(file):
    await request.respond(Http404, "Not Found", responseHeaders("text/plain"))
    return
  try:
    await request.respond(Http200, readFile(file), responseHeaders(mimeType(file)))
  except IOError, OSError:
    await request.respond(Http404, "Not Found", responseHeaders("text/plain"))

proc serveRequests(server: AsyncHttpServer; listener: RenderListener;
    stop: ptr Atomic[bool]): Future[void] {.async.} =
  let callback = proc(request: Request): Future[void] {.closure, gcsafe.} =
    handleRequest(listener, request)
  while not stop[].load:
    try:
      await server.acceptRequest(callback)
    except OSError:
      if stop[].load: return
      raise

proc waitForShot(pending: Future[JsonNode]; browser: ptr BrowserProcess): Future[JsonNode] {.async.} =
  let started = getMonoTime()
  while true:
    if pending.finished: return pending.read
    let state = pollBrowser(browser)
    if not state.active:
      let exit =
        if state.signal > 0: "signal " & $state.signal
        else: $state.exitCode
      raise newException(RenderError,
        "the browser exited (" & exit & ") before rendering\n" & browserStderrTail(browser[]))
    if (getMonoTime() - started).inMilliseconds >= DeadlineMs:
      raise newException(RenderError,
        "render timed out\n" & browserStderrTail(browser[]))
    await sleepAsync(100)

proc numberText(value: float): string =
  if value == floor(value): $int(value) else: $value

proc renderUrl(origin, token: string; options: RenderOptions): string =
  var query = @[
    ("scale", numberText(options.scale)),
    ("maxWidth", numberText(options.maxWidth)),
    ("dark", if options.dark: "1" else: "0"),
    ("inlineLimit", $options.inlineLimit),
    ("tiles", $options.tiles),
    ("token", token),
    ("result", origin & "/__result?token=" & token)
  ]
  if options.transparent: query.add(("bg", "0"))
  if options.ids.len > 0: query.add(("only", join(options.ids, ",")))
  if options.region.isSome:
    let region = options.region.get
    query.add(("region", @[
      numberText(region.x), numberText(region.y),
      numberText(region.width), numberText(region.height)
    ].join(",")))
  origin & "/render.html?" & encodeQuery(query)

proc runRender(scene, rawOptions: JsonNode): Future[JsonNode] {.async.} =
  let options = parseRenderOptions(rawOptions)
  let binary = resolveBrowser()
  let assets = distRoot()
  if not fileExists(assets / "render.html"):
    raise newException(RenderError,
      "the built render page is missing: " & assets / "render.html")

  pruneOldOutput()
  let payload = scenePayload(scene)
  let profile = createTempDir("sketchdex-browser-", "")
  let token = secureRandomHex(32)
  let shotFuture = newFuture[JsonNode]("sketchdex.render.result")
  let listener = RenderListener(token: token, distRoot: assets,
    payload: payload, result: shotFuture)
  let server = newAsyncHttpServer(maxBody = MaxResultBodyBytes,
    readTimeout = RequestReadTimeoutMs)
  var stop: Atomic[bool]
  stop.store(false)
  var browser: BrowserProcess
  var serving: Future[void]

  try:
    server.listen(Port(0), "127.0.0.1")
    serving = serveRequests(server, listener, addr stop)
    let origin = "http://127.0.0.1:" & $int(server.getPort)
    let url = renderUrl(origin, token, options)
    let stderrPath = profile / "chrome-stderr.log"
    browser = launchBrowser(binary, browserFlags(profile, url), stderrPath)
    let shot = await waitForShot(shotFuture, addr browser)
    let error = shot.field("error")
    if not error.isNil and error.kind == JString and error.getStr.len > 0:
      raise newException(RenderError, error.getStr)
    return shot
  finally:
    stopBrowser(browser)
    stop.store(true)
    server.close()
    if not serving.isNil:
      try: await serving
      except OSError: discard
    # Chromium children can release the profile a moment after the group kill.
    for _ in 0 ..< 20:
      try:
        removeDir(profile)
        break
      except OSError:
        sleep(25)

func dataUrlBase64(node: JsonNode; expectedPrefix: string): string =
  let dataUrl = node.field("dataUrl")
  if dataUrl.isNil or dataUrl.kind != JString or
      not dataUrl.getStr.startsWith(expectedPrefix):
    raise newException(RenderError, "render returned an invalid image data URL")
  let separator = dataUrl.getStr.find(',')
  if separator < 0:
    raise newException(RenderError, "render returned an invalid image data URL")
  dataUrl.getStr[separator + 1 .. dataUrl.getStr.len - 1]

proc safeSceneName(scene: JsonNode): string =
  let nameNode = scene.field("name")
  let name = if nameNode.isNil or nameNode.kind != JString: "scene" else: nameNode.getStr
  var pendingDash = false
  for ch in name:
    if ch in {'A' .. 'Z', 'a' .. 'z', '0' .. '9', '_', '-'}:
      if pendingDash and result.len > 0 and result[^1] != '-': result.add('-')
      result.add(ch)
      pendingDash = false
    elif result.len > 0:
      pendingDash = true
  while result.len > 0 and result[^1] == '-': result.setLen(result.len - 1)
  if result.len == 0: "scene" else: result[0 ..< min(40, result.len)]

proc sceneIdPrefix(scene: JsonNode): string =
  let idNode = scene.field("id")
  let id = if idNode.isNil or idNode.kind != JString: "scene" else: idNode.getStr
  id[0 ..< min(8, id.len)]

proc previewJson(image: JsonNode): JsonNode =
  let preview = image.field("preview")
  if preview.isNil or preview.kind != JObject: return newJNull()
  let mime = preview.field("mime")
  %*{
    "base64": dataUrlBase64(preview, "data:image/"),
    "width": preview["width"],
    "height": preview["height"],
    "mime": if mime.isNil or mime.kind != JString: "image/jpeg" else: mime.getStr
  }

proc unpackImage(image: JsonNode; scene: JsonNode; suffix: string): JsonNode =
  let base64 = dataUrlBase64(image, "data:image/png;base64,")
  let bytes =
    try: decode(base64)
    except ValueError as error:
      raise newException(RenderError, "render returned invalid base64: " & error.msg)
  if bytes.len == 0: raise newException(RenderError, "render produced nothing")
  let width = image.field("width")
  let height = image.field("height")
  if width.isNil or height.isNil or not width.isFiniteNumber or not height.isFiniteNumber:
    raise newException(RenderError, "render returned invalid image dimensions")
  let stamp = safeSceneName(scene) & "-" & sceneIdPrefix(scene) & "-" & secureRandomHex(2)
  let path = outputRoot() / (stamp & "-" & $width.getInt & "px" & suffix & ".png")
  writeFile(path, bytes)
  %*{
    "base64": base64,
    "path": path,
    "bytes": bytes.len,
    "width": width,
    "height": height,
    "preview": previewJson(image)
  }

proc renderScene*(scene: JsonNode; options: JsonNode): JsonNode =
  let shot = waitFor runRender(scene, options)
  if shot.hasKey("tiles") and shot["tiles"].kind == JArray:
    var tiles = newJArray()
    for index in 0 ..< shot["tiles"].len:
      let tile = shot["tiles"][index]
      let unpacked = unpackImage(tile, scene, "-tile" & $(index + 1))
      unpacked["region"] = copyNode(tile.field("region"))
      tiles.add(unpacked)
    return %*{
      "tiles": tiles,
      "width": shot["width"],
      "height": shot["height"]
    }
  unpackImage(shot, scene, "")
