import std/[base64, json, os, osproc, sets, strutils, tables, unittest]

import ../core/elements
import ../server/render

const
  Now = 1_700_000_000_000'i64

proc pngDimensions(data: string): tuple[width, height: int] =
  doAssert data.len >= 24
  doAssert data[0 .. 7] == "\x89PNG\r\n\x1a\n"
  doAssert data[12 .. 15] == "IHDR"
  result.width = (ord(data[16]) shl 24) or (ord(data[17]) shl 16) or
    (ord(data[18]) shl 8) or ord(data[19])
  result.height = (ord(data[20]) shl 24) or (ord(data[21]) shl 16) or
    (ord(data[22]) shl 8) or ord(data[23])

when defined(posix):
  proc descendantHasName(fragment: string): bool =
    let output = execProcess("ps", args = ["-axo", "pid=,ppid=,comm="],
      options = {poUsePath, poStdErrToStdOut})
    var children = initTable[int, seq[int]]()
    var names = initTable[int, string]()
    for line in output.splitLines():
      let parts = line.strip.splitWhitespace(maxsplit = 2)
      if parts.len != 3: continue
      let pid = parseInt(parts[0])
      let parent = parseInt(parts[1])
      children.mgetOrPut(parent, @[]).add(pid)
      names[pid] = parts[2].toLowerAscii
    var pending = @[getCurrentProcessId()]
    var seen = initHashSet[int]()
    while pending.len > 0:
      let parent = pending.pop()
      if seen.containsOrIncl(parent): continue
      for pid in children.getOrDefault(parent):
        if names.getOrDefault(pid).contains(fragment.toLowerAscii): return true
        pending.add(pid)
    false

elif defined(windows):
  proc descendantHasName(fragment: string): bool =
    let script = "$all = Get-CimInstance Win32_Process; " &
      "$ids = @(" & $getCurrentProcessId() & "); " &
      "do { $next = $all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId; " &
      "$ids += $next } while ($next); " &
      "$all | Where-Object { $ids -contains $_.ProcessId } | Select-Object -ExpandProperty Name"
    let output = execProcess("powershell", args = ["-NoProfile", "-NonInteractive", "-Command", script],
      options = {poUsePath, poStdErrToStdOut})
    output.toLowerAscii.contains(fragment.toLowerAscii)

suite "Nim render orchestration":
  test "renders a rectangle through Chromium and cleans up the process tree":
    let repoAssets = getCurrentDir() / "dist"
    let assetRoot = if fileExists(repoAssets / "index.html"): repoAssets else: getEnv("SKETCHDEX_TEST_ASSETS")
    if not fileExists(assetRoot / "render.html") or not dirExists(assetRoot / "assets"):
      quit("BLOCKED: render asset dependency missing: " & assetRoot)

    putEnv("SKETCHDEX_DIST", assetRoot)
    let built = buildElements(%*[%*{
      "id": "rect",
      "type": "rectangle",
      "width": 120,
      "height": 80,
      "label": "Rectangle"
    }], newJArray(), "#1e1e1e", Now)
    let scene = %*{
      "id": "render-test",
      "name": "Rectangle",
      "elements": built["elements"],
      "appState": {"viewBackgroundColor": "#ffffff"},
      "files": newJObject()
    }

    try:
      let rendered = renderScene(scene, %*{
        "scale": 1,
        "maxWidth": 300,
        "tiles": 1,
        "inlineLimit": 150_000
      })
      check rendered.hasKey("path")
      check not rendered.hasKey("tiles")
      let path = rendered["path"].getStr
      defer:
        try: removeFile(path)
        except OSError: discard

      let png = readFile(path)
      check png.len > 24
      let dimensions = pngDimensions(png)
      check dimensions.width == 168
      check dimensions.height == 128
      check rendered["width"].getInt == dimensions.width
      check rendered["height"].getInt == dimensions.height
      check rendered["bytes"].getInt == png.len
      check decode(rendered["base64"].getStr) == png
      check rendered["preview"].kind == JNull
      check not descendantHasName("node")
      check not descendantHasName("chromium")
      check not descendantHasName("chrome")
    except BrowserNotFoundError as error:
      echo "SKIP: Chromium unavailable. " & error.msg
      quit(0)
