import std/[random, times, os]

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"

var idRng: Rand

proc seedRng(seed: int64) =
  idRng = initRand(seed)

proc seedFromEntropy() =
  let micros = int64(epochTime() * 1_000_000.0)
  let pid = int64(getCurrentProcessId())
  seedRng(micros xor (pid shl 32) xor cast[int64](addr idRng))

proc newId*(): string =
  result = newStringOfCap(21)
  for _ in 0 ..< 21:
    result.add(ID_ALPHABET[rand(idRng, 0 .. 63)])

proc nonce*(): int =
  rand(idRng, 0 .. 2_147_483_647)

proc nowMs*(): int64 =
  int64(epochTime() * 1000.0)

seedFromEntropy()
