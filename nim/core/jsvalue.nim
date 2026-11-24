import std/[json, math, strutils]

proc isObj*(n: JsonNode): bool =
  not n.isNil and n.kind == JObject

proc isArr*(n: JsonNode): bool =
  not n.isNil and n.kind == JArray

proc field*(n: JsonNode; key: string): JsonNode =
  if n.isObj and n.hasKey(key): n[key] else: nil

proc hasField*(n: JsonNode; key: string): bool =
  n.isObj and n.hasKey(key)

proc isNumber*(n: JsonNode): bool =
  not n.isNil and (n.kind == JInt or n.kind == JFloat)

proc isFiniteNumber*(n: JsonNode): bool =
  if not n.isNumber: return false
  if n.kind == JInt: return true
  let f = n.getFloat
  f.classify notin {fcNan, fcInf, fcNegInf}

proc floatOr*(n: JsonNode; fallback: float): float =
  if not n.isFiniteNumber: return fallback
  if n.kind == JInt: float(n.getInt) else: n.getFloat

proc intOr*(n: JsonNode; fallback: int): int =
  if not n.isFiniteNumber: return fallback
  if n.kind == JInt: n.getInt else: int(n.getFloat)

proc arrayValue*(values: JsonNode; index: int): JsonNode =
  if values.isArr and index >= 0 and index < values.len: values[index] else: nil

proc numberNode*(value: float): JsonNode =
  if value.classify in {fcNan, fcInf, fcNegInf}: return newJNull()
  if value == 0.0: return newJInt(0)
  if value == floor(value) and value >= -9_223_372_036_854_775_808.0 and
      value < 9_223_372_036_854_775_808.0:
    return newJInt(int64(value))
  newJFloat(value)

proc stringOr*(n: JsonNode; fallback: string): string =
  if n.isNil or n.kind != JString: fallback else: n.getStr

proc boolOr*(n: JsonNode; fallback: bool): bool =
  if n.isNil or n.kind != JBool: fallback else: n.getBool

proc jsNumberString*(f: float): string =
  if f.classify == fcNan: return "NaN"
  if f == Inf: return "Infinity"
  if f == NegInf: return "-Infinity"
  if f == 0.0: return "0"

  let negative = f < 0.0
  let a = abs(f)
  var s: string

  if a >= 1e-6 and a < 1e21:
    s = $a
    let ePos = max(s.find('e'), s.find('E'))
    if ePos >= 0:
      let mantissa = s[0 ..< ePos]
      let exponent = parseInt(s[ePos + 1 ..^ 1])
      let digits = mantissa.replace(".", "")
      let dot = if mantissa.contains('.'): mantissa.find('.') else: mantissa.len
      let point = dot + exponent
      if point <= 0:
        s = "0." & repeat('0', -point) & digits
      elif point >= digits.len:
        s = digits & repeat('0', point - digits.len)
      else:
        s = digits[0 ..< point] & "." & digits[point ..^ 1]
    elif s.endsWith(".0"):
      s.setLen(s.len - 2)
  else:
    s = $a
    let ePos = max(s.find('e'), s.find('E'))
    if ePos >= 0:
      var mantissa = s[0 ..< ePos]
      let exponent = parseInt(s[ePos + 1 ..^ 1])
      if mantissa.endsWith(".0"):
        mantissa.setLen(mantissa.len - 2)
      s = mantissa & "e" & (if exponent >= 0: "+" else: "-") & $abs(exponent)

  if negative: "-" & s else: s

proc jsString*(n: JsonNode): string =
  if n.isNil: return "undefined"
  case n.kind
  of JString: n.getStr
  of JInt: $n.getInt
  of JFloat: jsNumberString(n.getFloat)
  of JBool: (if n.getBool: "true" else: "false")
  of JNull: "null"
  of JArray:
    var parts: seq[string]
    for item in n:
      parts.add(if item.isNil or item.kind == JNull: "" else: jsString(item))
    parts.join(",")
  of JObject: "[object Object]"

proc jsTruthy*(n: JsonNode): bool =
  if n.isNil: return false
  case n.kind
  of JNull: false
  of JBool: n.getBool
  of JInt: n.getInt != 0
  of JFloat:
    let f = n.getFloat
    f != 0.0 and f.classify != fcNan
  of JString: n.getStr.len > 0
  of JArray, JObject: true

proc jsRound*(x: float): float =
  if x.classify in {fcNan, fcInf, fcNegInf}: return x
  let whole = floor(x)
  if x - whole >= 0.5: whole + 1.0 else: whole

proc jsRoundInt*(x: float): int =
  int(jsRound(x))

proc copyNode*(n: JsonNode): JsonNode =
  if n.isNil: nil else: copy(n)

proc newPoint*(x, y: float): JsonNode =
  result = newJArray()
  result.add(%x)
  result.add(%y)

proc setDefault*(obj: JsonNode; key: string; value: JsonNode) =
  if not obj.hasKey(key):
    obj[key] = value
