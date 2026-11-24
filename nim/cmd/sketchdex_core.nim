import std/[json, monotimes, os, strutils, times]

import ../core/[elements, jsvalue, paper, random_ids, resample, textmetrics]

const
  Version = "0.1.0"
  MaxRequestLineBytes = 64 * 1024 * 1024
  InputChunkBytes = 64 * 1024
  MaxJsonNesting = 128
  MaxBenchIterations = 10_000
  Usage = "Usage: sketchdex-core (--serve | --once) --metrics <path>\n" &
    "       sketchdex-core --bench <request.json> <iterations> --metrics <path>\n" &
    "       sketchdex-core --version\n" &
    "SKETCHDEX_METRICS may supply the metrics path."

type
  RunMode = enum
    rmUnset, rmServe, rmOnce, rmVersion, rmBench
  Options = object
    mode: RunMode
    metricsPath: string
    benchRequestPath: string
    benchIterations: int
  Request = object
    id: int64
    op: string
    args: JsonNode
  BuildInput = object
    specs, existing: JsonNode
    ink: string
    now: int64
  RequestError = object of CatchableError
    requestId: int64
  OutcomeKind = enum
    outOk, outBadRequest, outInternal
  Outcome = object
    kind: OutcomeKind
    value: JsonNode
    message: string
  LineStatus = enum
    lsEof, lsOk, lsTooLarge
  LineResult = object
    status: LineStatus
    text: string
  InputReader = object
    buffer: array[InputChunkBytes, char]
    position, length: int

when defined(posix):
  var
    inputErrno {.importc: "errno", header: "<errno.h>".}: cint
    inputEintr {.importc: "EINTR", header: "<errno.h>".}: cint
  proc readInput(fd: cint; buffer: pointer; count: int): int {.
      importc: "read", header: "<unistd.h>".}
elif defined(windows):
  proc readInput(handle: int; buffer: pointer; count: int32;
      readCount: ptr int32; overlapped: pointer): int32 {.
      stdcall, dynlib: "kernel32", importc: "ReadFile".}
  proc lastInputError(): int32 {.
      stdcall, dynlib: "kernel32", importc: "GetLastError".}
else:
  {.error: "request line reader requires POSIX or Windows".}

proc readInputChunk(buffer: pointer; count: int): int =
  when defined(posix):
    while true:
      result = readInput(getFileHandle(stdin), buffer, count)
      if result >= 0: return
      if inputErrno == inputEintr: continue
      raise newException(IOError, "stdin read failed: errno " & $inputErrno)
  elif defined(windows):
    var readCount = 0'i32
    if readInput(getOsFileHandle(stdin), buffer, int32(count),
        addr readCount, nil) == 0:
      let error = lastInputError()
      if error == 109: return 0
      raise newException(IOError, "stdin read failed: Windows error " & $error)
    readCount.int

proc fillInput(reader: var InputReader): bool =
  reader.length = readInputChunk(addr reader.buffer[0], reader.buffer.len)
  reader.position = 0
  reader.length > 0

proc appendInput(text: var string; capacity: var int; data: openArray[char]) =
  let needed = text.len + data.len
  if needed > capacity:
    let grown =
      if capacity >= 8 * 1024 * 1024: MaxRequestLineBytes + 1
      else: min(MaxRequestLineBytes + 1, max(needed, capacity * 2))
    var replacement = newStringOfCap(grown)
    replacement.setLenUninit(text.len)
    if text.len > 0:
      copyMem(addr replacement[0], unsafeAddr text[0], text.len)
    text = move(replacement)
    capacity = grown
  let offset = text.len
  text.setLenUninit(needed)
  copyMem(addr text[offset], unsafeAddr data[0], data.len)

proc readLineBounded(reader: var InputReader; result: var LineResult) =
  result.status = lsEof
  result.text = newStringOfCap(InputChunkBytes * 2)
  var capacity = InputChunkBytes * 2
  var total = 0'i64
  var tooLarge = false
  while true:
    if reader.position >= reader.length:
      if not fillInput(reader):
        if total == 0: return
        let endsWithCr = result.text.len > 0 and result.text[^1] == '\r'
        let effective = total - (if endsWithCr: 1 else: 0)
        if tooLarge or effective > MaxRequestLineBytes:
          result.status = lsTooLarge
        else:
          if endsWithCr: result.text.setLen(result.text.len - 1)
          result.status = lsOk
        return

    let start = reader.position
    var stop = start
    while stop < reader.length and reader.buffer[stop] != '\n':
      inc stop
    let segment = stop - start
    if not tooLarge:
      let remaining = MaxRequestLineBytes + 1 - result.text.len
      let take = min(segment, remaining)
      if take > 0:
        appendInput(result.text, capacity,
          reader.buffer[start ..< start + take])
    total += segment
    reader.position = stop

    if stop < reader.length:
      inc reader.position
      let endsWithCr =
        if segment > 0: reader.buffer[stop - 1] == '\r'
        else: result.text.len > 0 and result.text[^1] == '\r'
      let effective = total - (if endsWithCr: 1 else: 0)
      if tooLarge or effective > MaxRequestLineBytes:
        result.status = lsTooLarge
      else:
        if result.text.len > 0 and result.text[^1] == '\r':
          result.text.setLen(result.text.len - 1)
        result.status = lsOk
      return

    if total > MaxRequestLineBytes + 1:
      tooLarge = true

proc skipJsonWhitespace(line: string; index: var int) =
  while index < line.len and line[index] in {' ', '\t', '\r', '\n'}:
    inc index

proc extractRequestId(line: string): int64 =
  var depth = 0
  var index = 0
  while index < line.len:
    case line[index]
    of '"':
      let start = index + 1
      inc index
      var escaped = false
      while index < line.len:
        let ch = line[index]
        if escaped:
          escaped = false
        elif ch == '\\':
          escaped = true
        elif ch == '"':
          break
        inc index
      if index >= line.len: return 0
      let token = line[start ..< index]
      inc index
      var next = index
      skipJsonWhitespace(line, next)
      if depth == 1 and token == "id" and next < line.len and line[next] == ':':
        inc next
        skipJsonWhitespace(line, next)
        var value = 0'i64
        var digits = 0
        while next < line.len and line[next] in {'0' .. '9'}:
          let digit = int64(line[next]) - int64('0')
          if value > (high(int64) - digit) div 10: return 0
          value = value * 10 + digit
          inc digits
          inc next
        if digits > 0 and value > 0 and next < line.len and
            line[next] in {' ', '\t', '\r', '\n', ',', '}'}:
          return value
        return 0
    of '{', '[':
      inc depth
    of '}', ']':
      if depth > 0: dec depth
    else:
      discard
    inc index

proc failRequest(requestId: int64; message: string) {.noreturn.} =
  let error = newException(RequestError, message)
  error.requestId = requestId
  raise error

proc validateNesting(line: string) =
  var depth = 0
  var inString = false
  var escaped = false
  for ch in line:
    if inString:
      if escaped:
        escaped = false
      elif ch == '\\':
        escaped = true
      elif ch == '"':
        inString = false
    else:
      case ch
      of '"': inString = true
      of '{', '[':
        inc depth
        if depth > MaxJsonNesting:
          failRequest(extractRequestId(line), "JSON nesting exceeds 128 containers")
      of '}', ']':
        if depth > 0: dec depth
      else:
        discard

proc inputError(message: string) {.noreturn.} =
  stderr.writeLine("sketchdex-core: " & message)
  quit(2)

proc usageError(message: string) {.noreturn.} =
  stderr.writeLine("sketchdex-core: " & message)
  stderr.writeLine(Usage)
  quit(2)

proc parseBenchIterations(value: string): int =
  if value.len == 0:
    usageError("--bench iterations must be a positive integer")
  result = 0
  for ch in value:
    if ch notin {'0' .. '9'}:
      usageError("--bench iterations must be a positive integer")
    let digit = int(ch) - int('0')
    result = min(MaxBenchIterations, result * 10 + digit)
  if result == 0:
    usageError("--bench iterations must be a positive integer")

proc parseOptions(arguments: seq[string]): Options =
  result.mode = rmUnset
  var metricsSeen = false
  var index = 0
  while index < arguments.len:
    case arguments[index]
    of "--serve", "--once", "--version":
      if result.mode != rmUnset:
        usageError("choose exactly one of --serve, --once, --bench, or --version")
      result.mode = case arguments[index]
        of "--serve": rmServe
        of "--once": rmOnce
        else: rmVersion
      inc index
    of "--bench":
      if result.mode != rmUnset:
        usageError("choose exactly one of --serve, --once, --bench, or --version")
      if index + 2 >= arguments.len or arguments[index + 1].startsWith("--") or
          arguments[index + 2].startsWith("--"):
        usageError("--bench requires a request file and iteration count")
      result.mode = rmBench
      result.benchRequestPath = arguments[index + 1]
      if result.benchRequestPath.len == 0:
        usageError("--bench requires a non-empty request path")
      result.benchIterations = parseBenchIterations(arguments[index + 2])
      index += 3
    of "--metrics":
      if metricsSeen:
        usageError("--metrics may only be supplied once")
      if index + 1 >= arguments.len or arguments[index + 1].startsWith("--"):
        usageError("--metrics requires a path")
      result.metricsPath = arguments[index + 1]
      if result.metricsPath.len == 0:
        usageError("--metrics requires a non-empty path")
      metricsSeen = true
      index += 2
    else:
      usageError("unknown argument: " & arguments[index])

  if result.mode == rmUnset:
    usageError("missing --serve, --once, --bench, or --version")
  if result.mode != rmVersion:
    if not metricsSeen:
      result.metricsPath = getEnv(METRICS_PATH_ENV)
    if result.metricsPath.len == 0:
      usageError("missing --metrics or SKETCHDEX_METRICS")

proc loadMetricsOrExit(path: string) =
  try:
    if not fileExists(path):
      raise newException(IOError, "file does not exist")
    if loadMetrics(path) == 0:
      raise newException(ValueError, "no font families found")
  except Exception as error:
    stderr.writeLine("sketchdex-core: failed to load metrics from " & path & ": " & error.msg)
    quit(2)

proc parseRequest(line: string): Request =
  validateNesting(line)
  let root = try:
      parseJson(line)
    except JsonParsingError as error:
      failRequest(extractRequestId(line), "malformed JSON: " & error.msg)

  if root.kind != JObject:
    failRequest(0, "request must be an object")

  let idNode = root.field("id")
  if idNode.isNil or idNode.kind != JInt or idNode.getInt < 1:
    failRequest(0, "id must be a positive integer")

  let opNode = root.field("op")
  if opNode.isNil or opNode.kind != JString:
    failRequest(idNode.getInt, "op must be a string")

  let argsNode = root.field("args")
  if argsNode.isNil or argsNode.kind != JObject:
    failRequest(idNode.getInt, "args must be an object")

  Request(id: idNode.getInt, op: opNode.getStr, args: argsNode)

proc required(args: JsonNode; key: string): JsonNode =
  result = args.field(key)
  if result.isNil:
    raise newException(ValueError, "missing argument: " & key)

proc stringArg(args: JsonNode; key: string): string =
  let value = required(args, key)
  if value.kind != JString:
    raise newException(ValueError, "argument " & key & " must be a string")
  value.getStr

proc stringArg(args: JsonNode; key: string; fallback: string): string =
  let value = args.field(key)
  if value.isNil or value.kind == JNull: return fallback
  if value.kind != JString:
    raise newException(ValueError, "argument " & key & " must be a string")
  value.getStr

proc numberArg(args: JsonNode; key: string): float =
  let value = required(args, key)
  if not value.isFiniteNumber:
    raise newException(ValueError, "argument " & key & " must be a finite number")
  value.getFloat

proc numberArg(args: JsonNode; key: string; fallback: float): float =
  let value = args.field(key)
  if value.isNil or value.kind == JNull: return fallback
  if not value.isFiniteNumber:
    raise newException(ValueError, "argument " & key & " must be a finite number")
  value.getFloat

proc int64Arg(args: JsonNode; key: string): int64 =
  let value = required(args, key)
  if value.kind != JInt:
    raise newException(ValueError, "argument " & key & " must be an integer")
  value.getInt

proc buildInput(args: JsonNode; now: int64): BuildInput =
  let existingNode = args.field("existing")
  BuildInput(
    specs: args.field("specs"),
    existing: if existingNode.isNil: newJArray() else: existingNode,
    ink: stringArg(args, "ink", "#1e1e1e"),
    now: now
  )

proc success(value: JsonNode): Outcome =
  Outcome(kind: outOk, value: value)

proc failure(kind: OutcomeKind; message: string): Outcome =
  Outcome(kind: kind, message: message)

proc dispatch(request: Request): Outcome =
  try:
    case request.op
    of "ping":
      success(%*{"version": Version})
    of "build":
      let now =
        if request.args.hasField("now"): int64Arg(request.args, "now")
        else: nowMs()
      let input = buildInput(request.args, now)
      success(buildElements(input.specs, input.existing, input.ink, input.now))
    of "patch":
      let element = required(request.args, "element")
      let patch = required(request.args, "patch")
      let now = int64Arg(request.args, "now")
      success(%*{"element": patchElement(element, patch, now)})
    of "grow":
      let text = required(request.args, "text")
      let container = required(request.args, "container")
      let now = int64Arg(request.args, "now")
      success(%*{"container": growContainerFor(text, container, now)})
    of "measure":
      let text = stringArg(request.args, "text", "")
      let fontSize = numberArg(request.args, "fontSize", 20.0)
      let fontFamily = numberArg(request.args, "fontFamily", 5.0)
      let measured = measureText(text, fontSize, fontFamily)
      success(%*{"width": measured.width, "height": measured.height})
    of "wrap":
      let text = stringArg(request.args, "text", "")
      let maxWidth = numberArg(request.args, "maxWidth")
      let fontSize = numberArg(request.args, "fontSize", 20.0)
      let fontFamily = numberArg(request.args, "fontFamily", 5.0)
      success(%*{"text": wrapText(text, maxWidth, fontSize, fontFamily)})
    of "resample":
      let points = required(request.args, "points")
      let step =
        if request.args.hasField("step"): numberArg(request.args, "step")
        else: 18.0
      success(%*{"points": resample(points, step)})
    of "ink":
      success(%*{"ink": inkFor(stringArg(request.args, "paper", ""))})
    of "luminance":
      success(%*{"luminance": luminance(stringArg(request.args, "color", ""))})
    else:
      failure(outBadRequest, "unknown op: " & request.op)
  except Exception as error:
    failure(outInternal, error.msg)

proc responseJson(requestId: int64; outcome: Outcome): JsonNode =
  case outcome.kind
  of outOk:
    %*{"id": requestId, "ok": true, "result": outcome.value}
  of outBadRequest:
    %*{
      "id": requestId,
      "ok": false,
      "error": {"kind": "bad_request", "message": outcome.message}
    }
  of outInternal:
    %*{
      "id": requestId,
      "ok": false,
      "error": {"kind": "internal", "message": outcome.message}
    }

proc handleLine(line: string): JsonNode =
  try:
    let request = parseRequest(line)
    responseJson(request.id, dispatch(request))
  except RequestError as error:
    responseJson(error.requestId, failure(outBadRequest, error.msg))
  except Exception as error:
    responseJson(0, failure(outInternal, error.msg))

proc writeResponse(response: JsonNode) =
  stdout.writeLine($response)
  stdout.flushFile()

proc writeOversizedResponse(line: LineResult) =
  let requestId = extractRequestId(line.text)
  writeResponse(responseJson(requestId,
    failure(outBadRequest, "request line exceeds 64 MiB")))

proc serve() =
  var reader = InputReader()
  try:
    while true:
      var line = LineResult()
      readLineBounded(reader, line)
      case line.status
      of lsEof: return
      of lsOk: writeResponse(handleLine(line.text))
      of lsTooLarge: writeOversizedResponse(line)
  except IOError as error:
    inputError("failed to consume request line: " & error.msg)

proc once() =
  var reader = InputReader()
  try:
    var line = LineResult()
    readLineBounded(reader, line)
    case line.status
    of lsEof: writeResponse(handleLine(""))
    of lsOk: writeResponse(handleLine(line.text))
    of lsTooLarge: writeOversizedResponse(line)
  except IOError as error:
    inputError("failed to consume request line: " & error.msg)

proc benchmark(requestPath: string; iterations: int) =
  if not fileExists(requestPath):
    inputError("benchmark request file not found: " & requestPath)
  let source =
    try:
      readFile(requestPath)
    except IOError as error:
      inputError("failed to read benchmark request: " & error.msg)

  try:
    validateNesting(source)
    let root = parseJson(source)
    if root.kind != JObject:
      inputError("benchmark request must be an object")
    let opNode = root.field("op")
    if opNode.isNil or opNode.kind != JString or opNode.getStr != "build":
      inputError("benchmark request op must be build")
    let args = root.field("args")
    if args.isNil or args.kind != JObject:
      inputError("benchmark request args must be an object")

    let now =
      if args.hasField("now"): int64Arg(args, "now")
      else: nowMs()
    let input = buildInput(args, now)
    let counts = block:
      let warmup = buildElements(input.specs, input.existing, input.ink, input.now)
      (warmup["elements"].len, warmup["updated"].len)

    let started = getMonoTime()
    for _ in 0 ..< iterations:
      discard buildElements(input.specs, input.existing, input.ink, input.now)
    let elapsed = getMonoTime() - started
    let avgMs = elapsed.inNanoseconds.float / 1_000_000.0 / iterations.float

    stdout.writeLine($ %*{
      "iterations": iterations,
      "avgMs": avgMs,
      "elements": counts[0],
      "updated": counts[1]
    })
    stdout.flushFile()
  except JsonParsingError as error:
    inputError("failed to parse benchmark request: " & error.msg)
  except RequestError as error:
    inputError(error.msg)
  except Exception as error:
    inputError("benchmark failed: " & error.msg)

when isMainModule:
  let options = parseOptions(commandLineParams())
  if options.mode == rmVersion:
    stdout.writeLine("sketchdex-core " & Version)
    stdout.flushFile()
    quit(0)

  loadMetricsOrExit(options.metricsPath)
  case options.mode
  of rmServe: serve()
  of rmOnce: once()
  of rmBench: benchmark(options.benchRequestPath, options.benchIterations)
  else: discard
