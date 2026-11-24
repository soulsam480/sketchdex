import std/[json, os, osproc, strtabs, strutils, streams, tempfiles, unittest]

const repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))
const metricsPath = repoRoot / "server" / "font-metrics.json"

proc almostEqual(actual, expected: float): bool =
  let scale = max(abs(actual), abs(expected))
  if scale == 0.0: return actual == expected
  abs(actual - expected) <= 1e-9 * scale

const Now = 1700000000000'i64

when defined(windows):
  const binarySuffix = ".exe"
else:
  const binarySuffix = ""

const defaultBinaryPath = repoRoot / "nim" / "bin" / ("sketchdex-core" & binarySuffix)

type RunResult = tuple[output, stderr: string, exitCode: int]

proc runCore(binary: string; arguments: openArray[string]; input: string;
    environment: StringTableRef = nil): RunResult =
  let process = startProcess(binary, args = arguments, env = environment,
    options = {poUsePath})
  defer: process.close()
  process.inputStream.write(input)
  process.inputStream.flush()
  var firstLine: string
  if process.outputStream.readLine(firstLine):
    result.output = firstLine & "\n"
  process.inputStream.close()
  result.output.add(process.outputStream.readAll())
  result.stderr = process.errorStream.readAll()
  result.exitCode = process.waitForExit(timeout = 10_000)

proc requestLine(id: int; op: string; args: JsonNode): string =
  $(%*{"id": id, "op": op, "args": args}) & "\n"

proc responseLines(run: RunResult): seq[JsonNode] =
  if run.exitCode != 0:
    echo "sketchdex-core exited with code ", run.exitCode, "; stderr=", run.stderr.escape
    return
  check run.exitCode == 0
  if run.output.len == 0:
    echo "sketchdex-core returned empty stdout; stderr=", run.stderr.escape
    return
  check run.stderr == ""
  check run.output.endsWith("\n")
  var text = run.output
  text.stripLineEnd()
  for line in text.splitLines():
    result.add(parseJson(line))

proc singleResponse(run: RunResult): JsonNode =
  let lines = responseLines(run)
  check lines.len == 1
  if lines.len == 1: lines[0] else: newJNull()

proc checkSuccess(response: JsonNode; id: int) =
  check response["id"].getInt == id
  check response["ok"].getBool

proc checkFailure(response: JsonNode; id: int; kind: string) =
  check response["id"].getInt == id
  check not response["ok"].getBool
  check response["error"]["kind"].getStr == kind
  check response["error"]["message"].getStr.len > 0

suite "sketchdex-core CLI":
  var binary, tempDir, tempMetricsPath: string

  setup:
    let configuredBinary = getEnv("SKETCHDEX_CORE_BIN")
    binary = absolutePath(if configuredBinary.len > 0: configuredBinary
      else: defaultBinaryPath)
    doAssert fileExists(binary), "core binary not found: " & binary
    let configuredMetrics = getEnv("SKETCHDEX_TEST_METRICS")
    let sourceMetrics = absolutePath(if configuredMetrics.len > 0: configuredMetrics
      else: metricsPath)
    doAssert fileExists(sourceMetrics), "metrics file not found: " & sourceMetrics
    tempDir = createTempDir("sketchdex-core-test-", "")
    tempMetricsPath = tempDir / "font-metrics.json"
    copyFile(sourceMetrics, tempMetricsPath)

  teardown:
    removeDir(tempDir)

  test "version prints the exact version":
    let run = runCore(binary, ["--version"], "")
    check run.exitCode == 0
    check run.output == "sketchdex-core 0.1.0\n"
    check run.stderr == ""

  test "bench prints one summary line for a small build":
    let requestPath = tempDir / "bench-request.json"
    writeFile(requestPath, $(%*{
      "op": "build",
      "args": {
        "specs": [%*{"type": "rectangle", "label": "Hello"}],
        "now": Now
      }
    }))
    let run = runCore(binary,
      ["--bench", requestPath, "3", "--metrics", tempMetricsPath], "")
    let response = singleResponse(run)
    check response.len == 4
    check response["iterations"].getInt == 3
    check response["avgMs"].getFloat >= 0.0
    check response["elements"].getInt == 2
    check response["updated"].getInt == 0

  test "bench keeps metrics and warnings out of stdout":
    let requestPath = tempDir / "bench-warning-request.json"
    writeFile(requestPath, $(%*{
      "op": "build",
      "args": {"specs": [%*{"type": "future-widget"}], "now": Now}
    }))
    let run = runCore(binary,
      ["--bench", requestPath, "1", "--metrics", tempMetricsPath], "")
    let response = singleResponse(run)
    check response.len == 4
    check response["elements"].getInt == 1
    check not response.hasKey("warnings")
    check not response.hasKey("metrics")
    check not run.output.contains("passed through")
    check not run.output.contains("advance")

  test "bench rejects a missing request file":
    let missingPath = tempDir / "missing-bench-request.json"
    let run = runCore(binary,
      ["--bench", missingPath, "1", "--metrics", tempMetricsPath], "")
    check run.exitCode == 2
    check run.output == ""
    check run.stderr.contains("benchmark request file not found")

  test "bench rejects zero iterations":
    let requestPath = tempDir / "bench-zero-request.json"
    writeFile(requestPath, """{"op":"build","args":{}}""")
    let run = runCore(binary,
      ["--bench", requestPath, "0", "--metrics", tempMetricsPath], "")
    check run.exitCode == 2
    check run.output == ""
    check run.stderr.contains("positive integer")

  test "bench caps iterations at ten thousand":
    let requestPath = tempDir / "bench-cap-request.json"
    writeFile(requestPath, """{"op":"build","args":{"specs":[],"now":1700000000000}}""")
    let run = runCore(binary,
      ["--bench", requestPath, "10001", "--metrics", tempMetricsPath], "")
    let response = singleResponse(run)
    check response["iterations"].getInt == 10_000
    check response["elements"].getInt == 0

  test "ping works in once mode":
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(1, "ping", newJObject()))
    let response = singleResponse(run)
    checkSuccess(response, 1)
    check response["result"]["version"].getStr == "0.1.0"

  test "build accepts missing specs":
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(2, "build", newJObject()))
    let response = singleResponse(run)
    checkSuccess(response, 2)
    check response["result"].len == 3
    check response["result"]["elements"].len == 0
    check response["result"]["warnings"].len == 0
    check response["result"]["updated"].len == 0

  test "build accepts null specs":
    let args = parseJson("""{"specs":null}""")
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(3, "build", args))
    let response = singleResponse(run)
    checkSuccess(response, 3)
    check response["result"]["elements"].len == 0
    check response["result"]["warnings"].len == 0
    check response["result"]["updated"].len == 0

  test "build accepts missing existing":
    let args = parseJson("""{"specs":[]}""")
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(4, "build", args))
    let response = singleResponse(run)
    checkSuccess(response, 4)
    check response["result"]["elements"].len == 0

  test "build rejects null existing":
    let args = parseJson("""{"specs":[],"existing":null}""")
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(30, "build", args))
    let response = singleResponse(run)
    checkFailure(response, 30, "internal")
    check response["error"]["message"].getStr == "existing is not iterable"

  test "build creates a rectangle plus its label":
    let args = %*{
      "specs": [%*{
        "id": "rect",
        "type": "rectangle",
        "width": 160,
        "height": 80,
        "label": "Hello"
      }],
      "now": Now
    }
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(5, "build", args))
    let response = singleResponse(run)
    checkSuccess(response, 5)
    let elements = response["result"]["elements"]
    check elements.len == 2
    let rectangle = elements[0]
    let label = elements[1]
    check rectangle["type"].getStr == "rectangle"
    check label["type"].getStr == "text"
    check label["id"].getStr != rectangle["id"].getStr
    check label["containerId"].getStr == "rect"
    check label["text"].getStr == "Hello"
    check label["originalText"].getStr == "Hello"
    check almostEqual(label["fontSize"].getFloat, 20.0)
    check almostEqual(label["fontFamily"].getFloat, 5.0)
    check label["updated"].getInt == Now
    check rectangle["updated"].getInt == Now
    check rectangle["strokeColor"].getStr == "#1e1e1e"
    check label["strokeColor"].getStr == "#1e1e1e"
    check rectangle["boundElements"][0]["id"].getStr == label["id"].getStr

  test "patch updates text and revision fields":
    let args = %*{
      "element": %*{
        "id": "text-1",
        "type": "text",
        "text": "old",
        "originalText": "old",
        "fontSize": 20,
        "fontFamily": 5,
        "width": 30,
        "height": 25,
        "version": 1,
        "updated": 1
      },
      "patch": %*{"text": "new"},
      "now": Now
    }
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(6, "patch", args))
    let response = singleResponse(run)
    checkSuccess(response, 6)
    let element = response["result"]["element"]
    check element["id"].getStr == "text-1"
    check element["text"].getStr == "new"
    check element["originalText"].getStr == "new"
    check element["version"].getInt == 2
    check element["updated"].getInt == Now

  test "grow expands a matching container":
    let args = %*{
      "text": %*{"id": "label", "type": "text", "containerId": "box", "height": 40},
      "container": %*{
        "id": "box",
        "type": "rectangle",
        "width": 100,
        "height": 30,
        "version": 1
      },
      "now": Now
    }
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(7, "grow", args))
    let response = singleResponse(run)
    checkSuccess(response, 7)
    let container = response["result"]["container"]
    check container["id"].getStr == "box"
    check container["height"].getInt == 50
    check container["version"].getInt == 2
    check container["updated"].getInt == Now

  test "measure uses real metrics and keeps fractional font families":
    for entry in [
      (5.0, 148.1375),
      (5.5, 149.96791628334867)
    ]:
      let args = %*{
        "text": "Hello, world! 0123",
        "fontSize": 17.5,
        "fontFamily": entry[0]
      }
      let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
        requestLine(8, "measure", args))
      let response = singleResponse(run)
      checkSuccess(response, 8)
      check almostEqual(response["result"]["width"].getFloat, entry[1])
      check almostEqual(response["result"]["height"].getFloat, 21.875)

  test "measure defaults empty text and font values":
    let args = %*{"text": ""}
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(22, "measure", args))
    let response = singleResponse(run)
    checkSuccess(response, 22)
    check almostEqual(response["result"]["width"].getFloat, 10.0)
    check almostEqual(response["result"]["height"].getFloat, 25.0)

  test "wrap uses measured widths":
    let args = %*{
      "text": "one two three four",
      "maxWidth": 70,
      "fontSize": 20,
      "fontFamily": 5
    }
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(9, "wrap", args))
    let response = singleResponse(run)
    checkSuccess(response, 9)
    check response["result"]["text"].getStr == "one\ntwo\nthree\nfour"

  test "wrap defaults font values":
    let args = %*{"text": "a b", "maxWidth": 50}
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(23, "wrap", args))
    let response = singleResponse(run)
    checkSuccess(response, 23)
    check response["result"]["text"].getStr == "a b"

  test "resample defaults to eighteen pixel anchors":
    let args = %*{
      "points": [
        [0, 0], [10, 0], [20, 0], [30, 0], [40, 0],
        [50, 0], [60, 0], [70, 0], [80, 0], [90, 0]
      ]
    }
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(10, "resample", args))
    let response = singleResponse(run)
    checkSuccess(response, 10)
    let points = response["result"]["points"]
    check points.len == 6
    for index, expected in [0.0, 18.0, 36.0, 54.0, 72.0, 90.0]:
      check almostEqual(points[index][0].getFloat, expected)
      check almostEqual(points[index][1].getFloat, 0.0)

  test "ink follows paper luminance":
    for entry in [("#121212", "#e9ecef"), ("#ffffff", "#1e1e1e")]:
      let args = %*{"paper": entry[0]}
      let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
        requestLine(11, "ink", args))
      let response = singleResponse(run)
      checkSuccess(response, 11)
      check response["result"]["ink"].getStr == entry[1]

  test "ink defaults null or missing paper to light ink":
    for args in [%*{"paper": newJNull()}, newJObject()]:
      let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
        requestLine(24, "ink", args))
      let response = singleResponse(run)
      checkSuccess(response, 24)
      check response["result"]["ink"].getStr == "#1e1e1e"

  test "luminance expands short hex colors":
    let args = %*{"color": "#abc"}
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(12, "luminance", args))
    let response = singleResponse(run)
    checkSuccess(response, 12)
    check almostEqual(response["result"]["luminance"].getFloat, 0.4844632879252147)

  test "luminance defaults null or missing color to one":
    for args in [%*{"color": newJNull()}, newJObject()]:
      let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
        requestLine(25, "luminance", args))
      let response = singleResponse(run)
      checkSuccess(response, 25)
      check almostEqual(response["result"]["luminance"].getFloat, 1.0)

  test "malformed request envelopes return bad_request":
    for entry in [
      ("{", 0),
      ("[]", 0),
      ("{\"op\":\"ping\",\"args\":{}}", 0),
      ("{\"id\":1.5,\"op\":\"ping\",\"args\":{}}", 0),
      ("{\"id\":\"1\",\"op\":\"ping\",\"args\":{}}", 0),
      ("{\"id\":0,\"op\":\"ping\",\"args\":{}}", 0),
      ("{\"id\":13,\"args\":{}}", 13),
      ("{\"id\":14,\"op\":\"ping\",\"args\":[]}", 14)
    ]:
      let run = runCore(binary, ["--once", "--metrics", tempMetricsPath], entry[0] & "\n")
      checkFailure(singleResponse(run), entry[1], "bad_request")

  test "unknown ops return bad_request":
    let run = runCore(binary, ["--once", "--metrics", tempMetricsPath],
      requestLine(15, "unknown", newJObject()))
    checkFailure(singleResponse(run), 15, "bad_request")

  test "serve flushes three responses and exits cleanly on EOF":
    let process = startProcess(binary,
      args = ["--serve", "--metrics", tempMetricsPath], options = {poUsePath})
    defer: process.close()

    process.inputStream.write("{\n")
    process.inputStream.flush()
    var line: string
    check process.outputStream.readLine(line)
    checkFailure(parseJson(line), 0, "bad_request")

    process.inputStream.write(requestLine(16, "measure", %*{"text": "bad", "fontSize": "bad"}))
    process.inputStream.write(requestLine(17, "ping", newJObject()))
    process.inputStream.flush()
    process.inputStream.close()

    check process.outputStream.readLine(line)
    checkFailure(parseJson(line), 16, "internal")
    check process.outputStream.readLine(line)
    let ping = parseJson(line)
    checkSuccess(ping, 17)
    check ping["result"]["version"].getStr == "0.1.0"
    check not process.outputStream.readLine(line)
    check process.errorStream.readAll() == ""
    check process.waitForExit(timeout = 10_000) == 0

  test "serve rejects a 70 MiB line and accepts the next request":
    let process = startProcess(binary,
      args = ["--serve", "--metrics", tempMetricsPath], options = {poUsePath})
    defer: process.close()

    process.inputStream.write("{\"id\":26,\"op\":\"ping\",\"args\":{\"padding\":\"")
    let chunk = repeat('a', 64 * 1024)
    for _ in 0 ..< (70 * 1024 * 1024) div chunk.len:
      process.inputStream.write(chunk)
    process.inputStream.write("\"}}\n")
    process.inputStream.flush()

    var line: string
    check process.outputStream.readLine(line)
    let rejected = parseJson(line)
    checkFailure(rejected, 26, "bad_request")
    check rejected["error"]["message"].getStr == "request line exceeds 64 MiB"

    process.inputStream.write(requestLine(27, "ping", newJObject()))
    process.inputStream.flush()
    check process.outputStream.readLine(line)
    let ping = parseJson(line)
    checkSuccess(ping, 27)
    check ping["result"]["version"].getStr == "0.1.0"

    process.inputStream.close()
    check not process.outputStream.readLine(line)
    check process.errorStream.readAll() == ""
    check process.waitForExit(timeout = 10_000) == 0

  test "serve rejects a 129-deep array and accepts the next request":
    let process = startProcess(binary,
      args = ["--serve", "--metrics", tempMetricsPath], options = {poUsePath})
    defer: process.close()

    let deep = "{\"id\":28,\"op\":\"ping\",\"args\":{\"deep\":" &
      repeat('[', 129) & "0" & repeat(']', 129) & "}}\n"
    process.inputStream.write(deep)
    process.inputStream.flush()

    var line: string
    check process.outputStream.readLine(line)
    let rejected = parseJson(line)
    checkFailure(rejected, 28, "bad_request")
    check rejected["error"]["message"].getStr == "JSON nesting exceeds 128 containers"

    process.inputStream.write(requestLine(29, "ping", newJObject()))
    process.inputStream.flush()
    check process.outputStream.readLine(line)
    let ping = parseJson(line)
    checkSuccess(ping, 29)
    check ping["result"]["version"].getStr == "0.1.0"

    process.inputStream.close()
    check not process.outputStream.readLine(line)
    check process.errorStream.readAll() == ""
    check process.waitForExit(timeout = 10_000) == 0

  test "metrics can come from SKETCHDEX_METRICS":
    let environment = newStringTable()
    environment["SKETCHDEX_METRICS"] = tempMetricsPath
    let run = runCore(binary, ["--once"],
      requestLine(18, "ping", newJObject()), environment)
    checkSuccess(singleResponse(run), 18)

  test "missing metrics exits with code two":
    let missingPath = tempDir / "missing.json"
    let run = runCore(binary, ["--once", "--metrics", missingPath],
      requestLine(19, "ping", newJObject()))
    check run.exitCode == 2
    check run.output == ""
    check run.stderr.contains("failed to load metrics")
    check run.stderr.contains(missingPath)

  test "invalid metrics JSON exits with code two":
    let invalidPath = tempDir / "invalid.json"
    writeFile(invalidPath, "not json")
    let run = runCore(binary, ["--once", "--metrics", invalidPath],
      requestLine(20, "ping", newJObject()))
    check run.exitCode == 2
    check run.output == ""
    check run.stderr.contains("failed to load metrics")

  test "empty metrics do not fall back to heuristic widths":
    let emptyPath = tempDir / "empty.json"
    writeFile(emptyPath, "{}")
    let run = runCore(binary, ["--once", "--metrics", emptyPath],
      requestLine(21, "ping", newJObject()))
    check run.exitCode == 2
    check run.output == ""
    check run.stderr.contains("no font families found")

  test "missing or unknown flags print usage and exit with code two":
    let emptyEnvironment = newStringTable()
    for arguments in [@[], @["--once"], @["--unknown"]]:
      let run = runCore(binary, arguments, "", emptyEnvironment)
      check run.exitCode == 2
      check run.output == ""
      check run.stderr.contains("Usage: sketchdex-core")
