import std/[asyncdispatch, json, os, strutils]

import ../core/[metrics_data, textmetrics]
import ../mcp/[docs, rpc, stdio]
import ../server/[agent, http, render, vault]

const
  Version* = "0.2.0"
  SourceRoot = parentDir(parentDir(currentSourcePath()))
  Usage = "sketchdex " & Version & "\n\n" &
    "  sketchdex mcp             run MCP over stdio\n" &
    "  sketchdex app             serve the app, REST API, SSE, and MCP HTTP\n" &
    "  sketchdex vault           print the vault path\n" &
    "  sketchdex docs [topic]    print the manual\n\n" &
    "  --vault <dir>             scene folder\n" &
    "  --port <n>                app port, default 5173\n" &
    "  --assets <dir>            built app directory, default dist/\n" &
    "  --max-body <bytes>        request body cap, default 32 MiB\n" &
    "  --version                 print the version\n" &
    "  --help                    print this help\n"

type
  Command = enum
    cmdMcp, cmdApp, cmdDocs, cmdVault
  Options = object
    command: Command
    port: int
    vaultPath: string
    assetsDir: string
    maxBodyBytes: int
    docsTopic: string
    help, version: bool

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
  result.port = 5173
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
      discard
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
      if options.port == 0 or not addressInUse(error):
        raise
      inc port
  if not started:
    stderr.writeLine("sketchdex app: no free port found")
    quit(1)
  stdout.writeLine("sketchdex " & Version)
  stdout.writeLine("  app    " & server.url)
  stdout.writeLine("  vault  " & server.api.vault.root)
  flushFile(stdout)
  await server.serve()

proc runMcp(options: Options) =
  loadMetricsOrExit()
  setRenderAssets(defaultAssetsDir())
  let api = newAgentApi(configuredVault(options.vaultPath))
  let dispatcher = proc(name: string, args: JsonNode): JsonNode =
    dispatchAgent(api, name, args, api.vault.root)
  serveStdio(dispatcher)

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
