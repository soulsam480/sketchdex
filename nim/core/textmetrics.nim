import std/[json, os, strutils, tables, math, unicode]
import ./jsvalue

const LINE_HEIGHT* = 1.25
const BOUND_TEXT_PADDING = 5.0
const DEFAULT_FONT_SIZE* = 20.0
const DEFAULT_FONT_FAMILY* = 5.0
const METRICS_PATH_ENV* = "SKETCHDEX_METRICS"

const NARROW = {'i', 'l', 'j', 't', 'f', 'r', 'I', '|', '!', '.', ',', ';', ':', '\'', '`', '(', ')', '[', ']', '{', '}'}
const WIDE = {'m', 'w', 'M', 'W', '@', '%'}
const UPPER = {'A'..'Z'} - {'I', 'M'}

const REFERENCE = "the quick brown fox jumps over the lazy dog, 0123456789 THE QUICK"

type
  FontTable = object
    mean: float
    advance: Table[string, float]

var METRICS: Table[string, FontTable]
var referenceMean = 1.0

proc charWeight(ch: Rune): float =
  let c = ch.int32
  if c == 32: return 0.5
  if c < 128:
    let a = char(c)
    if NARROW.contains(a): return 0.45
    if WIDE.contains(a): return 1.45
    if UPPER.contains(a): return 1.1
    if a in {'0'..'9'}: return 1.0
  if c > 0x2e80: return 2.0
  0.95

proc computeReferenceMean() =
  var total = 0.0
  var count = 0
  for ch in REFERENCE.runes:
    total += charWeight(ch)
    count += 1
  referenceMean = total / float(count)

proc fontFactor(fontFamily: float): float =
  if fontFamily == 1.0: 0.53
  elif fontFamily == 2.0: 0.50
  elif fontFamily == 3.0: 0.60
  elif fontFamily == DEFAULT_FONT_FAMILY: 0.51
  elif fontFamily == 6.0: 0.50
  elif fontFamily == 7.0: 0.55
  elif fontFamily == 8.0: 0.53
  else: 0.51

proc loadMetricsFromText*(text: string): int =
  let root = parseJson(text)
  METRICS = initTable[string, FontTable]()
  for family, table in root:
    var entry = FontTable(mean: floatOr(table{"mean"}, 0.0))
    entry.advance = initTable[string, float]()
    let advance = table{"advance"}
    if advance.isObj:
      for glyph, value in advance:
        entry.advance[glyph] = floatOr(value, 0.0)
    METRICS[family] = entry
  METRICS.len

proc loadMetrics*(path: string): int =
  if not fileExists(path):
    METRICS = initTable[string, FontTable]()
    return 0
  loadMetricsFromText(readFile(path))

proc widthScale(fontFamily: float): float =
  fontFactor(fontFamily) / referenceMean

proc glyphAdvance(ch: Rune; fontFamily: float): float =
  let family = jsNumberString(fontFamily)
  if METRICS.hasKey(family):
    let table = addr METRICS[family]
    let glyph = $ch
    if table[].advance.hasKey(glyph):
      return table[].advance[glyph]
    if ch.int32 > 0x2e80:
      return 1.0
    return table[].mean
  charWeight(ch) * widthScale(fontFamily)

proc lineWidth(line: string; fontSize: float; fontFamily: float): float =
  var run = 0.0
  for ch in line.runes:
    run += glyphAdvance(ch, fontFamily)
  run * fontSize

proc measureText*(text: string; fontSize: float; fontFamily = DEFAULT_FONT_FAMILY): tuple[width, height: float] =
  var width = 0.0
  let lines = text.split('\n')
  for line in lines:
    width = max(width, lineWidth(line, fontSize, fontFamily))
  (max(width, fontSize * 0.5), float(lines.len) * fontSize * LINE_HEIGHT)

proc wrapText*(text: string; maxWidth: float; fontSize: float; fontFamily = DEFAULT_FONT_FAMILY): string =
  if not (maxWidth > 0.0): return text
  var outputLines: seq[string]

  for paragraph in text.split('\n'):
    var line = ""
    for word in paragraph.split(' '):
      let candidate = if line.len > 0: line & " " & word else: word
      if lineWidth(candidate, fontSize, fontFamily) <= maxWidth:
        line = candidate
        continue
      if line.len > 0:
        outputLines.add(line)
        line = ""

      var piece = ""
      var run = 0.0
      for ch in word.runes:
        let advance = glyphAdvance(ch, fontFamily)
        if piece.len > 0 and (run + advance) * fontSize > maxWidth:
          outputLines.add(piece)
          piece = ""
          run = 0.0
        piece.add($ch)
        run += advance
      line = piece
    outputLines.add(line)

  outputLines.join("\n")

proc labelMaxWidth*(kind: string; width: float): float =
  if kind == "diamond":
    float(jsRoundInt(width / 2.0)) - BOUND_TEXT_PADDING * 2.0
  elif kind == "ellipse":
    float(jsRoundInt((width / 2.0) * sqrt(2.0))) - BOUND_TEXT_PADDING * 2.0
  else:
    width - BOUND_TEXT_PADDING * 2.0

proc containerHeightFor*(kind: string; textHeight: float): float =
  let padding = BOUND_TEXT_PADDING * 2.0
  let h = ceil(textHeight)
  if kind == "diamond":
    2.0 * (h + padding)
  elif kind == "ellipse":
    float(jsRoundInt(((h + padding) / sqrt(2.0)) * 2.0))
  else:
    h + padding

computeReferenceMean()
