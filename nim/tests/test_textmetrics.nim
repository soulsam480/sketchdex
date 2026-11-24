import std/[os, unittest]
import ../core/textmetrics
import ./test_helpers

const repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))
const metricsPath = repoRoot / "server" / "font-metrics.json"

proc checkMeasure(text: string; fontSize: float; fontFamily: float; width, height: float) =
  let measured = measureText(text, fontSize, fontFamily)
  check almostEqual(measured.width, width)
  check almostEqual(measured.height, height)

suite "textmetrics":
  setup:
    check loadMetrics(metricsPath) > 0

  test "measured widths match JavaScript across supported fonts":
    for entry in [
      (1.0, 148.89),
      (2.0, 140.08400000000003),
      (3.0, 184.5585),
      (5.0, 148.1375),
      (6.0, 148.83749999999998),
      (7.0, 135.6425),
      (8.0, 173.25),
    ]:
      let (font, width) = entry
      checkMeasure("Hello, world! 0123", 17.5, font, width, 21.875)

  test "an unknown fractional font uses the heuristic fallback":
    checkMeasure("Hello, world! 0123", 17.5, 5.5, 149.96791628334867, 21.875)

  test "empty text keeps the minimum width and one line height":
    checkMeasure("", 20.0, 5.0, 10.0, 25.0)

  test "newlines include empty lines in width and height":
    checkMeasure("a\nbb\n\ncccc", 16.0, 5.0, 32.256, 80.0)
    checkMeasure("tail\n", 18.0, 2.0, 23.0112, 45.0)
    checkMeasure("\n", 12.0, 1.0, 6.0, 30.0)

  test "CJK glyphs use measured and fallback widths":
    checkMeasure("漢字かな", 20.0, 5.0, 80.0, 25.0)
    checkMeasure("漢字かな", 20.0, 5.5, 97.5896964121435, 25.0)

  test "emoji code points stay whole":
    checkMeasure("😀👩‍💻", 18.0, 5.0, 64.9566, 22.5)
    checkMeasure("😀👩‍💻", 18.0, 5.5, 76.3029438822447, 22.5)

  test "combining marks are measured as separate code points":
    checkMeasure("e\u0301 A\u030a", 22.0, 5.0, 62.2688, 27.5)
    checkMeasure("e\u0301 A\u030a", 22.0, 5.5, 59.7126954921803, 27.5)

  test "long words and repeated spaces keep their measured widths":
    checkMeasure("supercalifragilisticexpialidocious", 15.0, 5.0, 229.81499999999997, 18.75)
    checkMeasure("a  b   c", 19.0, 5.0, 69.065, 23.75)

  test "measured glyph advances differ from fallback advances":
    checkMeasure("iiii", 20.0, 5.0, 19.52, 25.0)
    checkMeasure("iiii", 20.0, 5.5, 21.95768169273229, 25.0)
    checkMeasure("mmmm", 20.0, 5.0, 53.040000000000006, 25.0)
    checkMeasure("mmmm", 20.0, 5.5, 70.75252989880403, 25.0)
    check measureText("iiii", 20.0, 5.0).width != measureText("iiii", 20.0, 5.5).width
    check measureText("mmmm", 20.0, 5.0).width != measureText("mmmm", 20.0, 5.5).width

  test "zero and negative wrap widths return the original text":
    check wrapText("one  two\nthree", 0.0, 20.0, 5.0) == "one  two\nthree"
    check wrapText("one  two\nthree", -10.0, 20.0, 5.0) == "one  two\nthree"

  test "wrapping matches JavaScript for words, long words and paragraphs":
    check wrapText("one two three four", 70.0, 20.0, 5.0) == "one\ntwo\nthree\nfour"
    check wrapText("supercalifragilistic", 55.0, 20.0, 5.0) == "super\ncalifr\nagilis\ntic"
    check wrapText("one two\nthree four", 60.0, 20.0, 5.0) == "one\ntwo\nthree\nfour"

  test "wrapping preserves repeated spaces and splits CJK by code point":
    check wrapText("a  b   c", 1000.0, 19.0, 5.0) == "a  b   c"
    check wrapText("a  b   c", 25.0, 19.0, 5.0) == "a \nb \nc"
    check wrapText("漢字かな文字", 45.0, 20.0, 5.0) == "漢字\nかな\n文字"

  test "labelMaxWidth matches container geometry":
    for entry in [
      ("rectangle", [(100.0, 90.0), (101.0, 91.0), (123.5, 113.5)]),
      ("ellipse", [(100.0, 61.0), (101.0, 61.0), (123.5, 77.0)]),
      ("diamond", [(100.0, 40.0), (101.0, 41.0), (123.5, 52.0)]),
    ]:
      let (kind, widths) = entry
      for size in widths:
        let (width, expected) = size
        check almostEqual(labelMaxWidth(kind, width), expected)

  test "containerHeightFor rounds fractional text heights":
    for entry in [
      ("rectangle", [(20.0, 30.0), (20.1, 31.0), (20.5, 31.0), (21.0, 31.0), (25.25, 36.0)]),
      ("ellipse", [(20.0, 42.0), (20.1, 44.0), (20.5, 44.0), (21.0, 44.0), (25.25, 51.0)]),
      ("diamond", [(20.0, 60.0), (20.1, 62.0), (20.5, 62.0), (21.0, 62.0), (25.25, 72.0)]),
    ]:
      let (kind, heights) = entry
      for size in heights:
        let (textHeight, expected) = size
        check almostEqual(containerHeightFor(kind, textHeight), expected)
