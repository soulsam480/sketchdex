import std/[json, options, os, tempfiles, unittest]

import ../server/[library, vault]

proc catalogFixture(): JsonNode =
  %*[
    %*{
      "id": "icons",
      "name": "Icon Set",
      "description": "A pack of interface symbols",
      "authors": %*[%*{"name": "Ada"}],
      "source": "icons.excalidrawlib",
      "preview": "icons.png",
      "updated": 100,
      "itemNames": %*["home", "settings"]
    },
    %*{
      "id": "shapes",
      "name": "Icon Pack",
      "description": "Geometric building blocks",
      "authors": %*[%*{"name": "Grace"}],
      "source": "shapes.excalidrawlib",
      "preview": "shapes.png",
      "updated": 300,
      "itemNames": %*["circle", "square"]
    },
    %*{
      "id": "notes",
      "name": "Note Cards",
      "description": "Sticky notes for planning",
      "authors": %*[%*{"name": "Ada Lovelace"}],
      "source": "notes.excalidrawlib",
      "preview": "notes.png",
      "updated": 200,
      "itemNames": %*["card", "label"]
    }
  ]

suite "library file conversion":
  test "v1 entries get stable ids from their source":
    let raw = %*{
      "type": "excalidrawlib",
      "version": 1,
      "library": [
        %*[%*{"type": "rectangle", "width": 20}],
        %*[%*{"type": "ellipse", "width": 30}]
      ]
    }
    let converted = itemsFromLibraryFile(raw, 1764000000000, "https://example.test/icons.excalidrawlib")
    check converted.len == 2
    check converted[0]["id"].getStr.len > 0
    check converted[1]["id"].getStr.len > 0
    check converted[0]["id"].getStr != converted[1]["id"].getStr
    check converted[0]["elements"][0]["type"].getStr == "rectangle"
    check converted[0]["elements"][0]["width"].getInt == 20
    check converted[1]["elements"][0]["width"].getInt == 30
    check converted[0]["status"].getStr == "unpublished"
    check converted[0]["created"].getInt == 1764000000000
    let twice = itemsFromLibraryFile(raw, 1764000000000, "https://example.test/icons.excalidrawlib")
    check twice[0]["id"].getStr == converted[0]["id"].getStr
    check twice[1]["id"].getStr == converted[1]["id"].getStr
    let elsewhere = itemsFromLibraryFile(raw, 1764000000000, "https://example.test/other.excalidrawlib")
    check elsewhere[0]["id"].getStr != converted[0]["id"].getStr

  test "v2 items keep ids and names":
    let raw = %*{
      "type": "excalidrawlib",
      "version": 2,
      "libraryItems": [
        %*{
          "id": "keep-one", "status": "published", "created": 111,
          "name": "Shapes", "elements": %*[%*{"type": "rectangle"}]
        },
        %*{
          "id": "keep-two", "name": "Arrows",
          "elements": %*[%*{"type": "arrow"}]
        }
      ]
    }
    let converted = itemsFromLibraryFile(raw, 999)
    check converted.len == 2
    check converted[0]["id"].getStr == "keep-one"
    check converted[0]["name"].getStr == "Shapes"
    check converted[0]["status"].getStr == "published"
    check converted[0]["created"].getInt == 111
    check converted[0]["elements"][0]["type"].getStr == "rectangle"
    check converted[1]["id"].getStr == "keep-two"
    check converted[1]["name"].getStr == "Arrows"

  test "a file with the wrong type is refused":
    var status = 0
    try:
      discard itemsFromLibraryFile(%*{
        "type": "excalidraw", "library": %*[]
      }, 1)
    except library.LibraryError as error:
      status = error.status
    check status == 400

  test "a v2 item without elements is refused":
    var status = 0
    try:
      discard itemsFromLibraryFile(%*{
        "type": "excalidrawlib", "version": 2,
        "libraryItems": %*[%*{"id": "broken"}]
      }, 1)
    except library.LibraryError as error:
      status = error.status
    check status == 400

suite "library store":
  var store: LibraryStore
  var root: string

  setup:
    root = createTempDir("sketchdex-library-", "", getTempDir())
    store = newLibraryStore(newVault(root))

  teardown:
    removeDir(root)

  test "replace writes items and rev tracks the file":
    check store.readItems().len == 0
    check store.rev.isNone
    let saved = store.replace(%*[
      %*{"id": "a", "elements": %*[%*{"type": "rectangle"}]}
    ], none(string))
    check saved.len == 1
    check saved[0]["status"].getStr == "unpublished"
    check saved[0]["created"].getInt > 0
    check store.rev.isSome
    let before = store.rev.get
    discard store.replace(%*[%*{"id": "b", "elements": %*[]}], some(before))
    check store.readItems()[0]["id"].getStr == "b"
    check store.rev.get != before

  test "replace keeps one entry per id":
    let saved = store.replace(%*[
      %*{"id": "same", "name": "first", "elements": %*[]},
      %*{"id": "same", "name": "second", "elements": %*[]}
    ], none(string))
    check saved.len == 1
    check saved[0]["name"].getStr == "second"

  test "a stale revision is refused":
    discard store.replace(%*[%*{"id": "a", "elements": %*[]}], none(string))
    let stale = store.rev.get
    discard store.replace(%*[%*{"id": "b", "elements": %*[]}], some(stale))
    var status = 0
    try:
      discard store.replace(%*[%*{"id": "c", "elements": %*[]}], some(stale))
    except library.LibraryError as error:
      status = error.status
    check status == 409
    check store.readItems()[0]["id"].getStr == "b"

  test "replace refuses a non-array payload":
    var status = 0
    try:
      discard store.replace(%*{"id": "a"}, none(string))
    except library.LibraryError as error:
      status = error.status
    check status == 400

  test "replace refuses more than 1000 items":
    var many = newJArray()
    for index in 0 ..< 1001:
      many.add(%*{"id": "id-" & $index, "elements": %*[]})
    var status = 0
    try:
      discard store.replace(many, none(string))
    except library.LibraryError as error:
      status = error.status
    check status == 400

  test "append dedupes by id and a second append adds nothing":
    let incoming = %*[
      %*{"id": "one", "elements": %*[%*{"type": "rectangle"}]},
      %*{"id": "two", "elements": %*[%*{"type": "ellipse"}]},
      %*{"id": "one", "elements": %*[%*{"type": "line"}]}
    ]
    let first = store.append(incoming)
    check first.added == 2
    check first.skipped == 1
    check first.items.len == 2
    let second = store.append(incoming)
    check second.added == 0
    check second.skipped == 3
    check second.items.len == 2
    check store.readItems().len == 2

suite "catalog browsing":
  test "an exact name outranks other matches":
    let found = browseCatalog(catalogFixture(), "Icon Set")
    check found.len == 1
    check found[0]["id"].getStr == "icons"
    check found[0]["url"].getStr ==
      "https://libraries.excalidraw.com/libraries/icons.excalidrawlib"
    check found[0]["preview"].getStr ==
      "https://libraries.excalidraw.com/libraries/icons.png"
    check found[0]["items"].getInt == 2

  test "prefix ties are broken by name":
    let found = browseCatalog(catalogFixture(), "icon")
    check found.len == 2
    check found[0]["id"].getStr == "shapes"
    check found[1]["id"].getStr == "icons"

  test "tokens match across fields":
    check browseCatalog(catalogFixture(), "ada icon")[0]["id"].getStr == "icons"

  test "description authors and item names are searchable":
    check browseCatalog(catalogFixture(), "planning")[0]["id"].getStr == "notes"
    check browseCatalog(catalogFixture(), "lovelace")[0]["id"].getStr == "notes"
    let found = browseCatalog(catalogFixture(), "circle")
    check found[0]["id"].getStr == "shapes"
    check found[0]["items"].getInt == 2

  test "an empty query returns newest first":
    let found = browseCatalog(catalogFixture(), "")
    check found.len == 3
    check found[0]["id"].getStr == "shapes"
    check found[1]["id"].getStr == "notes"
    check found[2]["id"].getStr == "icons"

  test "limit caps results at 100":
    var many = newJArray()
    for index in 0 ..< 150:
      many.add(%*{
        "id": "id-" & $index,
        "name": "Library " & $index,
        "description": "",
        "authors": %*[],
        "source": "lib-" & $index & ".excalidrawlib",
        "preview": "",
        "updated": index
      })
    check browseCatalog(many, "", 500).len == 100
    check browseCatalog(many, "").len == 20

suite "catalog lookup":
  test "catalogEntry finds an entry by id":
    let entry = catalogEntry(catalogFixture(), "notes")
    check entry.isSome
    check entry.get["name"].getStr == "Note Cards"
    check catalogEntry(catalogFixture(), "missing").isNone

  test "catalogName resolves a source path":
    check catalogName(catalogFixture(), "notes.excalidrawlib") == "Note Cards"
    check catalogName(catalogFixture(), "unknown.excalidrawlib") == ""

  test "fetchText refuses non-http URLs":
    var status = 0
    try:
      discard fetchText("file:///etc/passwd")
    except library.LibraryError as error:
      status = error.status
    check status == 400
