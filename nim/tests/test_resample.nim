import std/[json, unittest]
import ../core/resample
import ./test_helpers

proc point(x, y: float): JsonNode =
  result = newJArray()
  result.add(newJFloat(x))
  result.add(newJFloat(y))

proc openRun(length: float): JsonNode =
  result = newJArray()
  for i in 0 ..< int(length / 10.0):
    result.add(point(i.float * 10.0, 0.0))
  result.add(point(length, 0.0))

proc closedSquare(side: float): JsonNode =
  result = newJArray()
  for i in 0 .. int(side / 10.0):
    result.add(point(i.float * 10.0, 0.0))
  for i in 1 .. int(side / 10.0):
    result.add(point(side, i.float * 10.0))
  for i in countdown(int(side / 10.0) - 1, 0):
    result.add(point(i.float * 10.0, side))
  for i in countdown(int(side / 10.0) - 1, 0):
    result.add(point(0.0, i.float * 10.0))

suite "resample":
  test "fewer than three points are returned unchanged":
    checkJson resample(newJArray()), "[]"
    checkJson resample(%*[point(1.25, -2.5)]), """[[1.25,-2.5]]"""
    checkJson resample(%*[point(0.0, 0.0), point(10.0, 0.0)]), """[[0.0,0.0],[10.0,0.0]]"""

  test "all non-finite points are filtered out":
    let input = %*[point(NaN, 0.0), point(1.0, NaN), point(NaN, NaN)]
    checkJson resample(input), "[]"

  test "one NaN is dropped before resampling":
    let input = %*[point(0.0, 0.0), point(NaN, 1.0), point(10.0, 0.0), point(20.0, 0.0), point(30.0, 0.0)]
    checkJson resample(input), """[[0.0,0.0],[15.0,0.0],[30.0,0.0]]"""

  test "an open run is re-spaced at the default step":
    let input = openRun(90.0)
    let output = resample(input)
    checkJson output, """[[0.0,0.0],[18.0,0.0],[36.0,0.0],[54.0,0.0],[72.0,0.0],[90.0,0.0]]"""
    check output[0] == input[0]
    check output[^1] == input[^1]

  test "a closed run keeps at least six anchors and exact closure":
    let input = closedSquare(90.0)
    let output = resample(input)
    checkJson output, """[[0.0,0.0],[18.0,0.0],[36.0,0.0],[54.0,0.0],[72.0,0.0],[90.0,0.0],[90.0,18.0],[90.0,36.0],[90.0,54.0],[90.0,72.0],[90.0,90.0],[72.0,90.0],[54.0,90.0],[36.0,90.0],[18.0,90.0],[0.0,90.0],[0.0,72.0],[0.0,54.0],[0.0,36.0],[0.0,18.0],[0.0,0.0]]"""
    check output[0] == output[^1]
    check output[0] == input[0]
    check output[^1] == input[^1]

  test "a zero-length run is returned unchanged":
    let input = %*[point(2.0, 2.0), point(2.0, 2.0), point(2.0, 2.0), point(2.0, 2.0)]
    checkJson resample(input), """[[2.0,2.0],[2.0,2.0],[2.0,2.0],[2.0,2.0]]"""

  test "an already coarse run is returned unchanged":
    let input = %*[point(0.0, 0.0), point(100.0, 0.0), point(100.0, 100.0)]
    checkJson resample(input), """[[0.0,0.0],[100.0,0.0],[100.0,100.0]]"""

  test "the step argument controls anchor spacing":
    let input = openRun(100.0)
    checkJson resample(input, 25.0), """[[0.0,0.0],[25.0,0.0],[50.0,0.0],[75.0,0.0],[100.0,0.0]]"""
    checkJson resample(openRun(80.0), 40.0), """[[0.0,0.0],[40.0,0.0],[80.0,0.0]]"""

  test "duplicate points do not break interpolation":
    let input = %*[
      point(0.0, 0.0), point(0.0, 0.0),
      point(10.0, 0.0), point(10.0, 0.0),
      point(20.0, 0.0), point(20.0, 0.0),
      point(30.0, 0.0), point(30.0, 0.0),
    ]
    checkJson resample(input), """[[0.0,0.0],[15.0,0.0],[30.0,0.0]]"""

  test "large coordinates keep their exact endpoints":
    var input = newJArray()
    for i in 0 .. 9:
      input.add(point(1e9 + i.float * 10.0, -1e9))
    let output = resample(input)
    checkJson output, """[[1000000000.0,-1000000000.0],[1000000018.0,-1000000000.0],[1000000036.0,-1000000000.0],[1000000054.0,-1000000000.0],[1000000072.0,-1000000000.0],[1000000090.0,-1000000000.0]]"""
    check output[0] == input[0]
    check output[^1] == input[^1]

  test "fractional first and last points are preserved exactly":
    var input = newJArray()
    for i in 0 .. 9:
      input.add(point(0.125 + i.float * 10.0, -0.25))
    let output = resample(input)
    checkJson output, """[[0.125,-0.25],[18.125,-0.25],[36.125,-0.25],[54.125,-0.25],[72.125,-0.25],[90.125,-0.25]]"""
    check output[0] == input[0]
    check output[^1] == input[^1]
