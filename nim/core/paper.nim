import std/[json, strutils, math]

const DARK_PAPER* = "#121212"
const LIGHT_PAPER* = "#ffffff"
const DEFAULT_PAPER* = DARK_PAPER
const INK_ON_DARK* = "#e9ecef"
const INK_ON_LIGHT* = "#1e1e1e"

proc channel(hex: string; at: int): float =
  float(parseHexInt(hex[at ..< at + 2])) / 255.0

proc linear(c: float): float =
  if c <= 0.03928: c / 12.92 else: pow((c + 0.055) / 1.055, 2.4)

proc isHex6(s: string): bool =
  if s.len != 7 or s[0] != '#': return false
  for i in 1 .. 6:
    if s[i] notin {'0'..'9', 'a'..'f'}: return false
  true

proc isHex3(s: string): bool =
  if s.len != 4 or s[0] != '#': return false
  for i in 1 .. 3:
    if s[i] notin {'0'..'9', 'a'..'f'}: return false
  true

proc luminance*(color: string): float =
  let hex = color.strip().toLowerAscii()
  var long = ""
  if isHex6(hex):
    long = hex
  elif isHex3(hex):
    long = "#" & $hex[1] & $hex[1] & $hex[2] & $hex[2] & $hex[3] & $hex[3]
  else:
    return 1.0
  0.2126 * linear(channel(long, 1)) +
    0.7152 * linear(channel(long, 3)) +
    0.0722 * linear(channel(long, 5))

proc isDarkPaper*(color: string): bool =
  luminance(color) < 0.4

proc inkFor*(paper: string): string =
  if isDarkPaper(paper): INK_ON_DARK else: INK_ON_LIGHT

proc paperOf*(appState: JsonNode): string =
  if appState.isNil: return LIGHT_PAPER
  let paper = appState{"viewBackgroundColor"}
  if paper.isNil or paper.kind != JString: LIGHT_PAPER else: paper.getStr

proc freshAppState*(paper = DEFAULT_PAPER): JsonNode =
  result = %*{
    "viewBackgroundColor": paper,
    "currentItemStrokeColor": inkFor(paper)
  }
