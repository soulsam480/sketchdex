import std/[json, unittest]

proc almostEqual*(actual, expected: float): bool =
  let scale = max(abs(actual), abs(expected))
  if scale == 0.0: return actual == expected
  abs(actual - expected) <= 1e-9 * scale

proc checkJson*(actual: JsonNode; expected: string) =
  check parseJson($actual) == parseJson(expected)
