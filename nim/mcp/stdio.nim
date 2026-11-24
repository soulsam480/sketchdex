import std/strutils

import rpc

proc serveStdio*(dispatcher: ToolDispatcher = defaultToolDispatcher) =
  var line: string
  while stdin.readLine(line):
    if line.strip().len == 0:
      continue
    let response = handleMcpRequest(line, dispatcher)
    if response.len == 0:
      continue
    try:
      stdout.writeLine(response)
      stdout.flushFile()
    except IOError:
      return

when isMainModule:
  import std/[json, os]
  import ../server/agent

  let api = newAgentApi(getEnv("SKETCHDEX_VAULT"))
  let dispatcher: ToolDispatcher = proc(name: string; args: JsonNode): JsonNode =
    dispatchAgent(api, name, args, api.vault.root)
  serveStdio(dispatcher)
