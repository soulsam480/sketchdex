# Nim element core

This directory holds the native element builder used by Sketchdex. Phase 1 ports the geometry, text, paper, and binding work from JavaScript. Node still owns the vault. Set `SKETCHDEX_CORE=nim` to send `buildElements` calls to the Nim worker.

The code favors JavaScript parity over idiomatic shortcuts. Read `jsvalue.nim` before the geometry modules. It defines how JSON values follow the JavaScript contract.

## Module map

Start with these files in order:

- `core/jsvalue.nim` provides safe field access, JavaScript number formatting, truthiness, rounding, and node copies.
- `core/paper.nim` computes luminance and chooses default ink for dark or light paper.
- `core/resample.nim` spaces freehand points at roughly 18 pixel intervals.
- `core/textmetrics.nim` loads `server/font-metrics.json`, measures labels, wraps text, and computes container growth.
- `core/geometry.nim` expands shapes, paths, repeats, mirrors, and bounds into Excalidraw elements.
- `core/elements.nim` completes specs, adds labels, resolves arrow bindings, and patches existing elements. `buildElements` is the main entry point.
- `cmd/sketchdex_core.nim` implements the CLI, JSON-lines protocol, validation, dispatch, benchmark, and worker loop.

`core/random_ids.nim` supplies ids and nonces. Tests live in `tests/`. The Node adapter lives in `server/core-worker.js`.

## JSON-lines protocol

The worker reads one JSON object per stdin line and writes one per stdout line. A request has a positive integer `id`, a string `op`, and an object `args`. Success returns the same `id`, `ok: true`, and `result`. Failure returns `ok: false` and `error` with `kind` and `message`.

A build request carries `specs`, `existing`, and `ink`. Its result contains `elements`, `warnings`, and `updated`. Other operations are `ping`, `patch`, `grow`, `measure`, `wrap`, `resample`, `ink`, and `luminance`.

```text
sketchdex_core.nim [1]
└── serve: read one JSON line [1a]
    ├── parseRequest with std/json [1a1]
    ├── dispatch [1a2]
    │   └── buildElements [1a2a]
    │       ├── geometry and resample [1a2a1]
    │       ├── textmetrics [1a2a2]
    │       └── AssociationStore [1a2a3]
    └── writeResponse and flush [1a3]
```

Stdout is reserved for responses. Diagnostics go to stderr. Lines are limited to 64 MiB and 128 JSON containers. The persistent worker does not cache the scene, so every phase 1 build receives the full `existing` array.

## Why the boundary uses `JsonNode`

`std/json` gives the core a mutable tree for input and output. `JsonNode` handles missing fields, mixed arrays, and values that JavaScript coerces. Rigid Nim objects would duplicate validation and still need a JSON-shaped result.

The cost appears at the edges. Parsing allocates the tree. Builders allocate result nodes. Writing traverses and serializes it. On the measured 2.86 MB request, `std/json` parsing took 42.8 ms while the fixed core build took 4.85 ms. The warm round trip took 62.6 ms.

Phase 2 keeps the parsed scene inside a Nim vault owner. Commands then carry small arguments, and the owner returns results. Do not tune arithmetic while the full scene crosses the process boundary on every mutation.

## Two performance lessons

### A table lookup can copy a table

`FontTable` contains an `advance` field of type `Table[string, float]`. This lookup returns the whole object by value:

```nim
let copied = METRICS[family]
```

Under ARC or ORC, that assignment deep-copies the table. Doing it for every glyph made the 100-label workload take 150 ms. The current code borrows the entry instead:

```nim
let table = addr METRICS[family]
let advance = table[].advance[glyph]
```

The `{.byaddr.}` pragma creates a variable binding to the same location. This module uses `addr`. `byaddr` is the alternative. Read-only hot paths should not copy a `Table`.

### A sequence scan per insert is quadratic

The old association store scanned a `seq` to find or replace each key. Inserting 5,000 entries therefore did quadratic work. The large-scene build took 472 ms.

`AssociationStore` in `elements.nim` now keeps two structures. Its `ordered` sequence preserves output order. Its `stringIndexes` table maps each string key to a position in that sequence. Lookup, replacement, and append become average O(1) for string keys. Non-string keys still use the sequence path because their equality follows JavaScript rules. The same build fell to 4.85 ms.

Choose the structure from the access pattern. Here the code needs both stable order and repeated lookup by id.

## Memory management and build flags

Nim 2.2.14 uses ORC by default. ARC is automatic reference counting with destructors and move semantics. ORC adds cycle collection for graphs that ARC cannot free. This matters for `JsonNode`, a reference type, and for containers with owned sequences.

The build script passes `-d:release --opt:speed`. Release mode removes debug runtime overhead. The speed option favors execution time over binary size. The script does not force `--mm:arc`, so the compiler default remains.

The full server imports `core/elements.nim` directly. There is no child process and no JSON bridge for element work.

## Build and test

Run these commands from the repository root. The build script uses `nim` from `PATH`, then falls back to `mise exec -- nim`. Set `SKETCHDEX_NIM` to choose another compiler.

```sh
npm run build:server
npm run test:server
```

`build:server` creates `nim/bin/sketchdex` and copies it to `bin/sketchdex` for npm. `test:server` rebuilds, runs every Nim test in `nim/tests`, and runs the full server e2e against a scratch vault and `dist/`.

The render test and the packaged e2e need `SKETCHDEX_BROWSER` set to a Chromium binary. There is no browser discovery.

## Further reading

- [Nim forum thread on `std/json` performance](https://forum.nim-lang.org/t/8074) covers tree allocation and parser costs.
- [nim-yyjson README](https://github.com/zystem/nim-yyjson/blob/main/README.md) documents its DOM and ownership model.
- [yyjson benchmarks](https://github.com/ibireme/yyjson_benchmark) compares JSON libraries and datasets.
- [Nim ARC and ORC manual](https://nim-lang.org/docs/mm.html) explains reference counting, cycles, and memory modes.
