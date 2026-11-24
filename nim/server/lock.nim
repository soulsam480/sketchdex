import std/[os, sha1]

type
  LockBusyError* = object of CatchableError
  UnsupportedLockError* = object of CatchableError

  VaultLock* = object
    path*: string
    held*: bool
    file: File

when defined(posix):
  var errnoValue {.importc: "errno", header: "<errno.h>".}: cint
  let Ewouldblock {.importc: "EAGAIN", header: "<errno.h>".}: cint
  let Eagain {.importc: "EAGAIN", header: "<errno.h>".}: cint
  let Eacces {.importc: "EACCES", header: "<errno.h>".}: cint
  let LockExclusive {.importc: "LOCK_EX", header: "<sys/file.h>".}: cint
  let LockNonblocking {.importc: "LOCK_NB", header: "<sys/file.h>".}: cint
  let LockUnlock {.importc: "LOCK_UN", header: "<sys/file.h>".}: cint

  proc flock(descriptor: cint; operation: cint): cint {.
    importc: "flock", header: "<sys/file.h>".}
  proc realpath(path: cstring; resolved: pointer): cstring {.
    importc: "realpath", header: "<stdlib.h>".}
  proc releaseCAllocation(value: pointer) {.
    importc: "free", header: "<stdlib.h>".}
  proc strerror(errorNumber: cint): cstring {.
    importc: "strerror", header: "<string.h>".}
  proc getuid(): cint {.importc: "getuid", header: "<unistd.h>".}

proc normalizedAbsolute(path: string): string =
  result = absolutePath(path)
  normalizePath(result)

proc canonicalizeVaultPath*(path: string): string =
  when defined(posix):
    var current = normalizedAbsolute(path)
    var missing: seq[string]
    while not dirExists(current) and not fileExists(current):
      let parent = parentDir(current)
      if parent == current: break
      missing.add(lastPathPart(current))
      current = parent

    let resolved = realpath(current.cstring, nil)
    if resolved.isNil:
      raise newException(IOError, "cannot resolve vault path: " & current)
    result = $resolved
    releaseCAllocation(cast[pointer](resolved))
    for index in countdown(missing.high, 0):
      result = result / missing[index]
    normalizePath(result)
  else:
    normalizedAbsolute(path)

proc runtimeDir*(): string =
  when defined(posix):
    getTempDir() / ("sketchdex-" & $getuid())
  else:
    getTempDir() / "sketchdex-windows"

proc lockFilePath*(vaultPath: string): string =
  let canonical = canonicalizeVaultPath(vaultPath)
  runtimeDir() / ("vault-" & $secureHash(canonical) & ".lock")

proc acquireVaultLock*(vaultPath: string): VaultLock =
  when defined(windows):
    # Intended path: CreateFileW on a persistent runtime-directory handle, then
    # LockFileEx with LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY. Closing
    # the handle releases the OS lock, so PID metadata must never break it.
    raise newException(UnsupportedLockError,
      "vault lifetime locks are unsupported on Windows; LockFileEx is not implemented")
  elif defined(posix):
    let path = lockFilePath(vaultPath)
    createDir(runtimeDir())
    when defined(posix):
      setFilePermissions(runtimeDir(),
        {fpUserRead, fpUserWrite, fpUserExec})
    let file = open(path, fmReadWrite)
    let descriptor = cint(getFileHandle(file))
    if flock(descriptor, LockExclusive or LockNonblocking) != 0:
      let code = errnoValue
      file.close()
      if code == Ewouldblock or code == Eagain or code == Eacces:
        raise newException(LockBusyError, "vault is already locked: " & vaultPath)
      raise newException(IOError,
        "cannot lock vault: " & $strerror(code))
    VaultLock(path: path, held: true, file: file)
  else:
    raise newException(UnsupportedLockError,
      "vault lifetime locks require POSIX flock")

proc release*(lock: var VaultLock) =
  when defined(posix):
    if not lock.held: return
    let descriptor = cint(getFileHandle(lock.file))
    discard flock(descriptor, LockUnlock)
    lock.file.close()
    lock.held = false
  else:
    lock.held = false

template withVaultLock*(vaultPath: string; body: untyped): untyped =
  block:
    var guard = acquireVaultLock(vaultPath)
    defer: release(guard)
    body
