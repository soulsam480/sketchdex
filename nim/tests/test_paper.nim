import std/[json, unittest]

import ../core/paper
import ./test_helpers

proc checkJson(actual: JsonNode; expected: string) =
  check parseJson($actual) == parseJson(expected)

suite "paper":
  test "six-digit hex forms normalize case and surrounding whitespace":
    for color in ["#000000", "#ffffff", "#123456", "#abcdef", "#ABCDEF", "#AbCdEf", " \t#AbCdEf\n", "  #abc  "]:
      let expected = case color
        of "#000000": 0.0
        of "#ffffff": 1.0
        of "#123456": 0.03256466884775973
        of "#abcdef", "#ABCDEF", "#AbCdEf", " \t#AbCdEf\n": 0.5855256521034803
        of "  #abc  ": 0.4844632879252147
        else: 0.0
      check almostEqual(luminance(color), expected)

  test "three-digit hex forms expand each nibble":
    for color in ["#000", "#fff", "#123", "#ABC", "#aBc"]:
      let expected = case color
        of "#000": 0.0
        of "#fff": 1.0
        of "#123": 0.015022419420735887
        of "#ABC", "#aBc": 0.4844632879252147
        else: 0.0
      check almostEqual(luminance(color), expected)

  test "invalid transparent and non-hex colors read as light":
    for color in ["", "transparent", "red", "#12", "#1234", "#12345", "#1234567", "#000000ff", "#ggg", "123456", "##123456", "#12 345"]:
      check luminance(color) == 1.0
      check not isDarkPaper(color)
      check inkFor(color) == INK_ON_LIGHT

  test "dark threshold is strict below 0.4":
    check almostEqual(luminance("#a9a9a9"), 0.3967552307256268)
    check isDarkPaper("#a9a9a9")
    check inkFor("#a9a9a9") == INK_ON_DARK
    check almostEqual(luminance("#aaaaaa"), 0.4019777798321958)
    check not isDarkPaper("#aaaaaa")
    check inkFor("#aaaaaa") == INK_ON_LIGHT

  test "inkFor follows paper luminance":
    check inkFor("#000000") == INK_ON_DARK
    check inkFor("#121212") == INK_ON_DARK
    check inkFor("#ffffff") == INK_ON_LIGHT
    check inkFor("transparent") == INK_ON_LIGHT

  test "paperOf falls back for missing null and non-string colors":
    check paperOf(nil) == LIGHT_PAPER
    check paperOf(%*{}) == LIGHT_PAPER
    check paperOf(%*{"viewBackgroundColor": nil}) == LIGHT_PAPER
    check paperOf(%*{"viewBackgroundColor": 42}) == LIGHT_PAPER
    check paperOf(%*{"viewBackgroundColor": true}) == LIGHT_PAPER
    check paperOf(%*{"viewBackgroundColor": %*{"nested": true}}) == LIGHT_PAPER

  test "paperOf preserves string colors":
    check paperOf(%*{"viewBackgroundColor": "#121212"}) == "#121212"
    check paperOf(%*{"viewBackgroundColor": "#ffffff"}) == "#ffffff"
    check paperOf(%*{"viewBackgroundColor": "transparent"}) == "transparent"

  test "freshAppState matches the JavaScript oracle":
    checkJson freshAppState(), """{"viewBackgroundColor":"#121212","currentItemStrokeColor":"#e9ecef"}"""
    checkJson freshAppState("#000000"), """{"viewBackgroundColor":"#000000","currentItemStrokeColor":"#e9ecef"}"""
    checkJson freshAppState("#ffffff"), """{"viewBackgroundColor":"#ffffff","currentItemStrokeColor":"#1e1e1e"}"""
    checkJson freshAppState("transparent"), """{"viewBackgroundColor":"transparent","currentItemStrokeColor":"#1e1e1e"}"""
