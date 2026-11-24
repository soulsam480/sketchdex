import std/[json, re, strutils, tables]

import ../core/[jsvalue, random_ids]

## Comments ride on the element they are about, under
## `customData.sketchdex.comments`. Nothing else in the app owns that key, so
## the scene file stays the only source of truth and a comment travels through
## save, copy, duplicate, undo and history without a second revision to
## reconcile. Geometry is never touched; only the element's version moves, so a
## stale canvas save reconciles to the version carrying the comment.

const
  NamespaceKey = "sketchdex"
  CommentsKey = "comments"
  SchemaVersion* = 1
  BodyLimit* = 4000
  AuthorLimit* = 80

type
  CommentError* = object of CatchableError
    status*: int

  CommentAction* = enum
    caResolve, caReopen, caDelete

proc fail(message: string; status = 400) {.noreturn.} =
  let error = newException(CommentError, message)
  error.status = status
  raise error

proc parseAction*(value: string): CommentAction =
  case value.strip().toLowerAscii
  of "resolve", "resolved": caResolve
  of "reopen", "open", "unresolve": caReopen
  of "delete", "remove": caDelete
  else: fail("action must be resolve, reopen or delete")

proc storeOf*(element: JsonNode): JsonNode =
  let custom = element.field("customData")
  if not custom.isObj: return nil
  let namespace = custom.field(NamespaceKey)
  if not namespace.isObj: return nil
  let comments = namespace.field(CommentsKey)
  if not comments.isObj: return nil
  comments

proc itemsOf*(element: JsonNode): JsonNode =
  let store = storeOf(element)
  if store.isNil: return newJArray()
  let items = store.field("items")
  if items.isArr: items else: newJArray()

proc countsOf*(element: JsonNode): tuple[open, resolved: int] =
  for item in itemsOf(element):
    if item.field("status").stringOr("open") == "resolved":
      inc result.resolved
    else:
      inc result.open

proc stateOf*(element: JsonNode; commentId: string): string =
  for item in itemsOf(element):
    if item.field("id").stringOr("") == commentId:
      return item.field("status").stringOr("open")
  ""

proc commentOf*(element: JsonNode; commentId: string): JsonNode =
  for item in itemsOf(element):
    if item.field("id").stringOr("") == commentId:
      return item
  nil

proc removeKey(node: JsonNode; key: string) =
  if node.isObj and node.hasField(key): node.delete(key)

proc bump(element: JsonNode; now: int64): JsonNode =
  result = copyNode(element)
  let version = element.field("version")
  result["version"] = %(if version.isNumber: version.getInt + 1 else: 1)
  result["versionNonce"] = %nonce()
  result["updated"] = %now

proc withItems*(element: JsonNode; items: JsonNode; now: int64): JsonNode =
  result = bump(element, now)
  var custom =
    if element.field("customData").isObj: copyNode(element["customData"])
    else: newJObject()
  var namespace =
    if custom.field(NamespaceKey).isObj: copyNode(custom[NamespaceKey])
    else: newJObject()
  if items.len == 0:
    removeKey(namespace, CommentsKey)
  else:
    namespace[CommentsKey] = %*{"schemaVersion": SchemaVersion, "items": items}
  if namespace.len == 0:
    removeKey(custom, NamespaceKey)
  else:
    custom[NamespaceKey] = namespace
  if custom.len == 0:
    removeKey(result, "customData")
  else:
    result["customData"] = custom

proc cleanAuthor*(name, kind: string): tuple[name, kind: string] =
  var authorKind = kind.strip().toLowerAscii
  if authorKind notin ["human", "agent"]:
    authorKind = if name.strip().len > 0: "human" else: "agent"
  var authorName = name.strip()
  if authorName.len > AuthorLimit: authorName = authorName[0 ..< AuthorLimit]
  if authorName.len == 0:
    authorName = if authorKind == "agent": "Sketchdex agent" else: "You"
  (authorName, authorKind)

proc appendComment*(element: JsonNode; body, authorName, authorKind: string;
    now: int64): JsonNode =
  let text = body.strip()
  if text.len == 0:
    fail("body is required: say what the comment is about")
  if text.len > BodyLimit:
    fail("body is longer than " & $BodyLimit & " characters")
  let (name, kind) = cleanAuthor(authorName, authorKind)
  var items = copyNode(itemsOf(element))
  items.add(%*{
    "id": "cmt_" & newId(),
    "body": text,
    "author": {"kind": kind, "name": name},
    "createdAt": now,
    "status": "open"
  })
  withItems(element, items, now)

proc applyAction*(element: JsonNode; commentId: string; action: CommentAction;
    now: int64): tuple[element: JsonNode, changed: bool, status: string] =
  var items = copyNode(itemsOf(element))
  var found = false
  var status = "open"
  var kept = newJArray()
  for item in items:
    if item.field("id").stringOr("") != commentId:
      kept.add(item)
      continue
    found = true
    status = item.field("status").stringOr("open")
    case action
    of caResolve:
      if status != "resolved":
        var next = copyNode(item)
        next["status"] = %"resolved"
        next["resolvedAt"] = %now
        kept.add(next)
        status = "resolved"
        result.changed = true
      else:
        kept.add(item)
    of caReopen:
      if status != "open":
        var next = copyNode(item)
        next["status"] = %"open"
        removeKey(next, "resolvedAt")
        kept.add(next)
        status = "open"
        result.changed = true
      else:
        kept.add(item)
    of caDelete:
      status = "deleted"
      result.changed = true
  if not found:
    fail("no comment " & commentId & " on this element", 404)
  result.status = status
  if result.changed:
    result.element = withItems(element, kept, now)
  else:
    result.element = element

proc shapeComment*(element: JsonNode; item: JsonNode): JsonNode =
  result = copyNode(item)
  result["elementId"] = copyNode(element.field("id"))
  result["elementType"] = copyNode(element.field("type"))
  let text = element.field("text")
  if jsTruthy(text):
    let collapsed = jsString(text).replace(re"\s+", " ")
    result["elementText"] = %(if collapsed.len > 60: collapsed[0 ..< 60] else: collapsed)

proc adoptComments*(incoming, existing: JsonNode): JsonNode =
  ## A canvas save is never authoritative for comments. Whatever the browser
  ## held in memory is replaced by what the file already says, so a tab whose
  ## scene is a second behind cannot erase a comment written in between. Only
  ## the comments key is touched; the rest of customData is left as sent.
  var disk = initTable[string, JsonNode]()
  if existing.isArr:
    for element in existing:
      if element.isObj:
        disk[element.field("id").stringOr("")] = element
  if not incoming.isArr: return incoming
  result = newJArray()
  for element in incoming:
    var next = copyNode(element)
    let old = disk.getOrDefault(next.field("id").stringOr(""))
    if old.isNil:
      result.add(next)
      continue
    var custom =
      if next.field("customData").isObj: copyNode(next["customData"])
      else: newJObject()
    var namespace =
      if custom.field(NamespaceKey).isObj: copyNode(custom[NamespaceKey])
      else: newJObject()
    removeKey(namespace, CommentsKey)
    let store = storeOf(old)
    if not store.isNil: namespace[CommentsKey] = copyNode(store)
    if namespace.len == 0:
      removeKey(custom, NamespaceKey)
    else:
      custom[NamespaceKey] = namespace
    if custom.len == 0:
      removeKey(next, "customData")
    else:
      next["customData"] = custom
    result.add(next)
