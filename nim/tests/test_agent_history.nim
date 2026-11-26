import std/[json, os, tempfiles, unittest]

import ../server/agent
import ../server/history
import ../server/vault

suite "external edit snapshots":
  var api: AgentApi
  var sceneId: string

  setup:
    let vault = createTempDir("sketchdex-history-", "", getTempDir())
    api = newAgentApi(vault)
    let created = api.createScene("External", %*[
      %*{"type": "rectangle", "x": 0, "y": 0, "width": 120, "height": 60,
         "label": "Before"}
    ])
    sceneId = created["sceneId"].getStr
    api.observe(sceneId, api.vault.read(sceneId))

  teardown:
    removeDir(api.vault.root)

  test "the snapshot keeps the exact elements and appState seen before the edit":
    let before = api.vault.read(sceneId)
    discard api.vault.save(sceneId, %*{
      "elements": [%*{"type": "rectangle", "id": "after", "width": 90, "height": 30}],
      "appState": %*{"viewBackgroundColor": "#ffffff"}
    })

    let entry = api.noteExternalChange(sceneId)
    check entry.kind != JNull
    let snapshot = api.history.read(sceneId, entry["id"].getStr)
    check snapshot["elements"] == before["elements"]
    check snapshot["appState"] == before["appState"]
