import std/[asyncdispatch, json, net, os, osproc, strutils]

import ../core/[metrics_data, textmetrics]
import ../mcp/[docs, rpc, stdio]
import ../server/[agent, http, render, vault]

const
  Version* = "0.6.0"
  SourceRoot = parentDir(parentDir(currentSourcePath()))
  Usage = "sketchdex " & Version & "\n\n" &
    "  sketchdex mcp             run MCP over stdio\n" &
    "  sketchdex mcp --serve     also serve the app beside the session\n" &
    "  sketchdex app             serve the app, REST API, SSE, and MCP HTTP\n" &
    "  sketchdex vault           print the vault path\n" &
    "  sketchdex docs [topic]    print the manual\n" &
    "  sketchdex update [--check] update the binary and UI assets\n\n" &
    "  --vault <dir>             scene folder\n" &
    "  --port <n>                app port, default 5173\n" &
    "  --assets <dir>            built app directory, default dist/\n" &
    "  --max-body <bytes>        request body cap, default 32 MiB\n" &
    "  --strict-port             app mode fails if --port is taken\n" &
    "  --no-open                 do not open the browser for mcp --serve\n" &
    "  --version                 print the version\n" &
    "  --help                    print this help\n"

type
  Command = enum
    cmdMcp, cmdApp, cmdDocs, cmdVault, cmdUpdate
  Options = object
    command: Command
    port: int
    vaultPath: string
    assetsDir: string
    maxBodyBytes: int
    docsTopic: string
    help, version, updateCheck, serve, noOpen, strictPort: bool

proc usageError(message: string) {.noreturn.} =
  stderr.writeLine("sketchdex: " & message)
  stderr.writeLine(Usage)
  quit(2)

proc expandHome(path: string): string =
  if path == "~":
    getHomeDir()
  elif path.startsWith("~/") or path.startsWith("~\\"):
    getHomeDir() / path[2 .. ^1]
  else:
    path

const DefaultPort = 5173

proc parsePort(value: string): int =
  if value.len == 0:
    usageError("--port requires a number")
  try:
    result = parseInt(value)
  except ValueError:
    usageError("--port must be a number")
  if result < 0 or result > 65535:
    usageError("--port must be between 0 and 65535")

proc parseBodyCap(value: string): int =
  if value.len == 0:
    usageError("--max-body requires a positive number of bytes")
  try:
    result = parseInt(value)
  except ValueError:
    usageError("--max-body must be a number of bytes")
  if result <= 0:
    usageError("--max-body must be positive")

proc optionValue(arguments: seq[string]; index: var int; name: string): string =
  if index + 1 >= arguments.len or arguments[index + 1].startsWith("--"):
    usageError(name & " requires a value")
  inc index
  arguments[index]

proc parseOptions(arguments: seq[string]): Options =
  result.command = cmdMcp
  result.port = DefaultPort
  result.maxBodyBytes = DefaultMaxBodyBytes
  var positional: seq[string]
  var seenPort, seenVault, seenAssets, seenBody = false
  var index = 0
  while index < arguments.len:
    let argument = arguments[index]
    case argument
    of "--version", "-v":
      result.version = true
    of "--help", "-h":
      result.help = true
    of "--no-open":
      result.noOpen = true
    of "--serve":
      result.serve = true
    of "--strict-port":
      result.strictPort = true
    of "--check":
      result.updateCheck = true
    of "--port":
      if seenPort: usageError("--port may only be supplied once")
      result.port = parsePort(optionValue(arguments, index, "--port"))
      seenPort = true
    of "--vault":
      if seenVault: usageError("--vault may only be supplied once")
      result.vaultPath = optionValue(arguments, index, "--vault")
      seenVault = true
    of "--assets":
      if seenAssets: usageError("--assets may only be supplied once")
      result.assetsDir = optionValue(arguments, index, "--assets")
      seenAssets = true
    of "--max-body":
      if seenBody: usageError("--max-body may only be supplied once")
      result.maxBodyBytes = parseBodyCap(optionValue(arguments, index, "--max-body"))
      seenBody = true
    else:
      if argument.startsWith("--port="):
        if seenPort: usageError("--port may only be supplied once")
        result.port = parsePort(argument["--port=".len .. ^1])
        seenPort = true
      elif argument.startsWith("--vault="):
        if seenVault: usageError("--vault may only be supplied once")
        result.vaultPath = argument["--vault=".len .. ^1]
        seenVault = true
      elif argument.startsWith("--assets="):
        if seenAssets: usageError("--assets may only be supplied once")
        result.assetsDir = argument["--assets=".len .. ^1]
        seenAssets = true
      elif argument.startsWith("--max-body="):
        if seenBody: usageError("--max-body may only be supplied once")
        result.maxBodyBytes = parseBodyCap(argument["--max-body=".len .. ^1])
        seenBody = true
      elif argument.startsWith("-"):
        usageError("unknown flag " & argument)
      else:
        positional.add(argument)
    inc index

  if not seenBody:
    let configured = getEnv("SKETCHDEX_MAX_BODY")
    if configured.len > 0:
      result.maxBodyBytes = parseBodyCap(configured)

  let serveEnv = getEnv("SKETCHDEX_MCP_SERVE").toLowerAscii
  if serveEnv in ["1", "true", "yes", "on"]:
    result.serve = true
  let noOpenEnv = getEnv("SKETCHDEX_NO_OPEN").toLowerAscii
  if noOpenEnv in ["1", "true", "yes", "on"]:
    result.noOpen = true

  if positional.len > 0:
    case positional[0]
    of "mcp": result.command = cmdMcp
    of "app": result.command = cmdApp
    of "docs":
      result.command = cmdDocs
      if positional.len > 1:
        result.docsTopic = positional[1]
      if positional.len > 2:
        usageError("docs accepts at most one topic")
    of "vault":
      result.command = cmdVault
      if positional.len > 1:
        usageError("vault accepts no arguments")
    of "update":
      result.command = cmdUpdate
      if positional.len > 1:
        usageError("update accepts no arguments")
    else:
      usageError("unknown command \"" & positional[0] & "\"")
  elif positional.len > 1:
    usageError("unexpected argument \"" & positional[1] & "\"")

proc configuredVault(path: string): string =
  let selected =
    if path.len > 0: expandHome(path)
    else: getEnv("SKETCHDEX_VAULT")
  if selected.len > 0: absolutePath(expandHome(selected))
  else: ""

proc defaultAssetsDir(): string =
  for candidate in [
      getAppDir() / "dist",
      parentDir(getAppDir()) / "dist",
      getCurrentDir() / "dist",
  ]:
    if fileExists(candidate / "index.html"):
      return candidate
  SourceRoot / "dist"

proc configuredAssets(path: string): string =
  absolutePath(if path.len > 0: expandHome(path) else: defaultAssetsDir())

proc loadMetricsOrExit() =
  let configured = getEnv(METRICS_PATH_ENV)
  var failures: seq[string]
  if configured.len > 0:
    let path = expandHome(configured)
    try:
      if not fileExists(path):
        raise newException(IOError, "file does not exist")
      if loadMetrics(path) > 0: return
      failures.add(path & ": no font families found")
    except CatchableError as error:
      failures.add(path & ": " & error.msg)
  try:
    if loadEmbeddedMetrics() > 0: return
    failures.add("embedded metrics: no font families found")
  except CatchableError as error:
    failures.add("embedded metrics: " & error.msg)
  stderr.writeLine("sketchdex: failed to load metrics: " & failures.join("; "))
  quit(2)

proc addressInUse(error: ref OSError): bool =
  let message = error.msg.toLowerAscii
  "address already in use" in message or "eaddrinuse" in message

proc runApp(options: Options) {.async.} =
  let assets = configuredAssets(options.assetsDir)
  setRenderAssets(assets)
  let server = newHttpServer(configuredVault(options.vaultPath), assets,
    options.maxBodyBytes)
  var port = options.port
  var started = false
  while port <= 65535 and (options.port == 0 or port < options.port + 20):
    try:
      await server.listen(Port(port))
      started = true
      break
    except OSError as error:
      if options.port == 0 or not addressInUse(error) or options.strictPort:
        stderr.writeLine("sketchdex app: " & error.msg)
        quit(1)
      inc port
  if not started:
    stderr.writeLine("sketchdex app: no free port found")
    quit(1)
  stdout.writeLine("sketchdex " & Version)
  stdout.writeLine("  app    " & server.url)
  stdout.writeLine("  vault  " & server.api.vault.root)
  flushFile(stdout)
  await server.serve()

proc portAccepts(port: int): bool =
  if port <= 0 or port > 65535:
    return false
  try:
    let socket = newSocket()
    defer: socket.close()
    socket.connect("127.0.0.1", Port(port))
    result = true
  except CatchableError:
    result = false

proc openBrowser(url: string) =
  let command =
    when defined(macosx):
      "open " & quoteShell(url)
    elif defined(windows):
      "explorer " & quoteShell(url)
    else:
      "xdg-open " & quoteShell(url)
  discard execShellCmd(command)

proc startSidecar(options: Options): Process =
  if portAccepts(options.port):
    stderr.writeLine("sketchdex: app already listening on http://127.0.0.1:" &
      $options.port)
    return nil
  var arguments = @["app"]
  var url = "http://127.0.0.1:" & $DefaultPort
  if options.port > 0:
    arguments.add("--port")
    arguments.add($options.port)
    arguments.add("--strict-port")
    url = "http://127.0.0.1:" & $options.port
  if options.vaultPath.len > 0:
    arguments.add("--vault")
    arguments.add(options.vaultPath)
  if options.assetsDir.len > 0:
    arguments.add("--assets")
    arguments.add(options.assetsDir)
  let child = startProcess(getAppFilename(), args = arguments, options = {poUsePath})
  if options.port > 0:
    sleep(250)
    if not child.running():
      child.close()
      if portAccepts(options.port):
        stderr.writeLine("sketchdex: app already listening on " & url)
        if not options.noOpen:
          openBrowser(url)
        return nil
      stderr.writeLine("sketchdex: the app exited; run `sketchdex app` to see why")
      return nil
  result = child
  stderr.writeLine("sketchdex: app " & url & " beside the stdio session")
  if not options.noOpen:
    openBrowser(url)

proc runMcp(options: Options) =
  loadMetricsOrExit()
  setRenderAssets(defaultAssetsDir())
  var sidecar: Process
  if options.serve:
    try:
      sidecar = startSidecar(options)
    except OSError as error:
      stderr.writeLine("sketchdex: could not start the app: " & error.msg)
  try:
    let api = newAgentApi(configuredVault(options.vaultPath))
    let dispatcher = proc(name: string, args: JsonNode): JsonNode =
      dispatchAgent(api, name, args, api.vault.root)
    serveStdio(dispatcher)
  finally:
    if sidecar != nil:
      if sidecar.running():
        sidecar.terminate()
      sidecar.close()

const ReleaseRepo = "soulsam480/sketchdex"

proc versionParts(value: string): seq[int] =
  for part in value.split('.'):
    try: result.add(parseInt(part))
    except ValueError: result.add(0)

proc versionLess(a, b: string): bool =
  let left = versionParts(a)
  let right = versionParts(b)
  for index in 0 ..< max(left.len, right.len):
    let l = if index < left.len: left[index] else: 0
    let r = if index < right.len: right[index] else: 0
    if l != r: return l < r
  false

proc platformSuffix(): string =
  let osName =
    when defined(macosx): "darwin"
    elif defined(windows): "windows"
    else: "linux"
  let arch =
    when hostCPU == "arm64" or hostCPU == "aarch64": "arm64"
    else: "x64"
  osName & "-" & arch

proc runCurl(url, destination: string): string =
  let command =
    if destination.len > 0:
      "curl -fsSL " & quoteShell(url) & " -o " & quoteShell(destination)
    else:
      "curl -fsSL " & quoteShell(url)
  let outcome = execCmdEx(command, options = {poUsePath, poStdErrToStdOut})
  if outcome.exitCode != 0:
    raise newException(IOError, "curl failed: " & outcome.output.strip)
  outcome.output

proc sha256(path: string): string =
  let command =
    when defined(macosx):
      "shasum -a 256 " & quoteShell(path)
    else:
      "sha256sum " & quoteShell(path)
  let outcome = execCmdEx(command, options = {poUsePath, poStdErrToStdOut})
  if outcome.exitCode != 0:
    raise newException(IOError, "sha256 failed: " & outcome.output.strip)
  outcome.output.splitWhitespace()[0]

proc runUpdate(checkOnly: bool) =
  let latest = parseJson(runCurl(
    "https://api.github.com/repos/" & ReleaseRepo & "/releases/latest", ""))
  let tag = latest["tag_name"].getStr
  let version = tag.strip(chars = {'v'})
  if not versionLess(Version, version):
    stdout.writeLine("sketchdex " & Version & " is up to date")
    return

  let suffix = platformSuffix()
  let assetName = "sketchdex-" & version & "-" & suffix & ".tar.gz"
  var download = ""
  for asset in latest["assets"]:
    if asset["name"].getStr == assetName:
      download = asset["browser_download_url"].getStr
  if download.len == 0:
    stderr.writeLine("sketchdex update: no " & assetName & " in " & tag)
    stderr.writeLine("  https://github.com/" & ReleaseRepo & "/releases/tag/" & tag)
    quit(1)

  if checkOnly:
    stdout.writeLine("sketchdex " & Version & " can update to " & version)
    stdout.writeLine(download)
    return

  when defined(windows):
    stdout.writeLine("download and replace the binary manually:")
    stdout.writeLine("  " & download)
    return

  let temporary = getTempDir() / ("sketchdex-update-" & $getCurrentProcessId())
  removeDir(temporary)
  createDir(temporary)
  defer:
    try: removeDir(temporary)
    except OSError: discard

  let tarball = temporary / assetName
  discard runCurl(download, tarball)
  discard runCurl(download & ".sha256", tarball & ".sha256")
  let expected = readFile(tarball & ".sha256").splitWhitespace()[0]
  if sha256(tarball) != expected:
    raise newException(IOError, "checksum mismatch for " & assetName)

  let extracted = execCmdEx("tar -xzf " & quoteShell(tarball) & " -C " & quoteShell(temporary),
    options = {poUsePath, poStdErrToStdOut})
  if extracted.exitCode != 0:
    raise newException(IOError, "tar failed: " & extracted.output.strip)

  let root = temporary / ("sketchdex-" & version & "-" & suffix)
  let currentBinary = getAppFilename()
  let configuredAssets = getEnv("SKETCHDEX_ASSETS")
  let currentDist =
    if configuredAssets.len > 0: absolutePath(configuredAssets)
    else: defaultAssetsDir()

  let stagedBinary = currentBinary & ".new"
  copyFile(root / "sketchdex", stagedBinary)
  setFilePermissions(stagedBinary, {
    fpUserRead, fpUserWrite, fpUserExec,
    fpGroupRead, fpGroupExec,
    fpOthersRead, fpOthersExec
  })
  moveFile(stagedBinary, currentBinary)

  let oldDist = currentDist & ".old"
  removeDir(oldDist)
  try:
    moveDir(currentDist, oldDist)
    moveDir(root / "dist", currentDist)
    removeDir(oldDist)
  except OSError:
    if dirExists(oldDist) and not dirExists(currentDist):
      moveDir(oldDist, currentDist)
    raise

  stdout.writeLine("sketchdex updated to " & version)
  stdout.writeLine("restart the MCP client and the app to use it")

when isMainModule:
  let options = parseOptions(commandLineParams())
  if options.help:
    stdout.write(Usage)
    quit(0)
  if options.version:
    stdout.writeLine(Version)
    quit(0)
  case options.command
  of cmdApp:
    loadMetricsOrExit()
    waitFor runApp(options)
  of cmdMcp:
    runMcp(options)
  of cmdDocs:
    try:
      stdout.write(getTopic(options.docsTopic))
    except ValueError as error:
      stderr.writeLine("sketchdex docs: " & error.msg)
      quit(2)
  of cmdVault:
    stdout.writeLine(newVault(configuredVault(options.vaultPath)).root)
  of cmdUpdate:
    runUpdate(options.updateCheck)
