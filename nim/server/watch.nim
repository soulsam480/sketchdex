import std/[atomics, locks, monotimes, options, os, sets, tables, times]

import ./[library, vault]

type
  WatchChangeKind* = enum
    changeScene
    changeRemoved
    changeLibrary

  WatchChange* = object
    kind*: WatchChangeKind
    sceneId*: string
    rev*: string

  WatchCallback* = proc(change: WatchChange) {.gcsafe.}

  WatcherState = ref object
    scenesDir: string
    libraryPath: string
    callback: WatchCallback
    mutex: Lock
    stopped: Atomic[bool]

  Watcher* = object
    state: WatcherState
    worker: Thread[WatcherState]
    started: bool

const
  SceneExtension = ".excalidraw"
  PollInterval = initDuration(milliseconds = 250)
  Debounce = initDuration(milliseconds = 120)

type
  PendingKind = enum
    pendingScene
    pendingRemoved

  PendingChange = object
    kind: PendingKind
    rev: string
    due: MonoTime

proc newWatcher*(vault: Vault; callback: WatchCallback): Watcher =
  Watcher(state: WatcherState(
    scenesDir: vault.scenesDir,
    libraryPath: vault.root / LibraryFileName,
    callback: callback
  ))

proc scan(state: WatcherState; seen: var Table[string, Option[string]];
    pending: var Table[string, PendingChange]; initialized: bool) =
  var current = initHashSet[string]()
  let now = getMonoTime()
  for path in walkFiles(state.scenesDir / ("*" & SceneExtension)):
    let fileName = lastPathPart(path)
    let sceneId = fileName[0 ..< fileName.len - SceneExtension.len]
    let revision = revisionForPath(path)
    current.incl(sceneId)
    if not seen.hasKey(sceneId):
      seen[sceneId] = revision
      if initialized:
        pending[sceneId] = PendingChange(
          kind: pendingScene,
          rev: if revision.isSome: revision.get else: "",
          due: now + Debounce
        )
    elif seen[sceneId] != revision:
      seen[sceneId] = revision
      pending[sceneId] = PendingChange(
        kind: pendingScene,
        rev: if revision.isSome: revision.get else: "",
        due: now + Debounce
      )

  var removed: seq[string]
  for sceneId in seen.keys:
    if sceneId notin current and seen[sceneId].isSome: removed.add(sceneId)
  for sceneId in removed:
    seen[sceneId] = none(string)
    pending[sceneId] = PendingChange(
      kind: pendingRemoved,
      rev: "",
      due: now + Debounce
    )

proc refreshPending(state: WatcherState; seen: var Table[string, Option[string]];
    pending: var Table[string, PendingChange]; now: MonoTime) =
  for sceneId, change in pending:
    let revision = revisionForPath(
      state.scenesDir / (sceneId & SceneExtension))
    if change.kind == pendingScene:
      let current = if revision.isSome: revision.get else: ""
      if current != change.rev:
        seen[sceneId] = revision
        pending[sceneId] = PendingChange(
          kind: if revision.isSome: pendingScene else: pendingRemoved,
          rev: current,
          due: now + Debounce
        )
    elif revision.isSome:
      seen[sceneId] = revision
      pending[sceneId] = PendingChange(
        kind: pendingScene,
        rev: revision.get,
        due: now + Debounce
      )

proc watchLoop(state: WatcherState) {.thread, gcsafe.} =
  var seen = initTable[string, Option[string]]()
  var pending = initTable[string, PendingChange]()
  var nextScan = getMonoTime()
  var initialized = false
  var libraryRev = none(string)
  var librarySeen = false

  while not state.stopped.load(moRelaxed):
    let now = getMonoTime()
    if now >= nextScan:
      try:
        scan(state, seen, pending, initialized)
        initialized = true
      except Exception:
        discard
      nextScan = getMonoTime() + PollInterval
      let current = revisionForPath(state.libraryPath)
      if not librarySeen:
        librarySeen = true
        libraryRev = current
      elif libraryRev != current:
        libraryRev = current
        try:
          state.callback(WatchChange(kind: changeLibrary, sceneId: "",
            rev: if current.isSome: current.get else: ""))
        except Exception:
          discard

    let refreshAt = getMonoTime()
    if pending.len > 0:
      try:
        refreshPending(state, seen, pending, refreshAt)
      except Exception:
        discard
    var ready: seq[string]
    let announceAt = getMonoTime()
    for sceneId, change in pending:
      if announceAt >= change.due: ready.add(sceneId)
    for sceneId in ready:
      let change = pending.getOrDefault(sceneId)
      pending.del(sceneId)
      let event = WatchChange(
        kind: if change.kind == pendingScene: changeScene else: changeRemoved,
        sceneId: sceneId,
        rev: change.rev
      )
      try:
        state.callback(event)
      except Exception:
        discard
    sleep(25)

proc start*(watcher: var Watcher) =
  if watcher.started: return
  watcher.state.stopped.store(false, moRelaxed)
  createThread(watcher.worker, watchLoop, watcher.state)
  watcher.started = true

proc stop*(watcher: var Watcher) =
  if not watcher.started: return
  watcher.state.stopped.store(true, moRelaxed)
  joinThread(watcher.worker)
  watcher.started = false

proc close*(watcher: var Watcher) =
  watcher.stop()
