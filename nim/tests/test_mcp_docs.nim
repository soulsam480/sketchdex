import std/[json, options, os, osproc, strutils, tempfiles, unittest]

import ../mcp/docs

const repoRoot = parentDir(parentDir(parentDir(currentSourcePath())))

const oracleScript = r"""
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.argv[2];
const load = (relative) => import(pathToFileURL(path.resolve(repo, relative)).href);
const { TOOLS, RESOURCES } = await load("mcp/tools.js");
const { TOPICS, TOPIC_NAMES, index, readTopic } = await load("mcp/docs.js");
const topicTexts = {};
for (const topic of TOPICS) topicTexts[topic.name] = await readTopic(topic.name, { tools: TOOLS });
const unknownErrors = {};
for (const name of ["missing", "TOOLS", "sketchdex://docs/install"]) {
  try {
    await readTopic(name, { tools: TOOLS });
  } catch (error) {
    unknownErrors[name] = error.message;
  }
}
process.stdout.write(JSON.stringify({
  topics: TOPICS,
  topicNames: TOPIC_NAMES,
  resources: RESOURCES,
  topicTexts,
  index: index(),
  all: await readTopic("all", { tools: TOOLS }),
  unknownErrors,
}));
"""

proc loadOracle(): JsonNode =
  let tempDir = createTempDir("sketchdex-mcp-docs-", "", "/tmp")
  let scriptPath = tempDir / "oracle.mjs"
  writeFile(scriptPath, oracleScript)
  try:
    let output = execProcess("node", args = [scriptPath, repoRoot], options = {poUsePath})
    parseJson(output)
  finally:
    removeDir(tempDir)

proc stringSeq(node: JsonNode): seq[string] =
  for value in node:
    result.add(value.getStr)

proc errorFor(name: string): string =
  try:
    discard getTopic(name)
  except ValueError as error:
    return error.msg
  ""

let oracle = loadOracle()

suite "MCP docs":
  test "all topic metadata matches Node in order":
    check TOPICS.len == 7
    check TOPICS.len == oracle["topics"].len
    for index, topic in TOPICS:
      let expected = oracle["topics"][index]
      check topic.name == expected["name"].getStr
      check topic.summary == expected["summary"].getStr
      if expected["file"].kind == JNull:
        check not topic.file.isSome
      else:
        check topic.file.isSome
        check topic.file.get == expected["file"].getStr
    check listTopics() == stringSeq(oracle["topicNames"])

  test "resource metadata and URIs match Node exactly":
    check RESOURCES == oracle["resources"]
    check RESOURCE_URIS.len == 7
    for index, topic in TOPICS:
      check RESOURCE_URIS[index] == oracle["resources"][index]["uri"].getStr
      check resourceUri(topic.name) == RESOURCE_URIS[index]
      check RESOURCES[index]["title"].getStr == "sketchdex docs: " & topic.name

  test "every topic text matches Node exactly":
    for topic in TOPICS:
      check getTopic(topic.name) == oracle["topicTexts"][topic.name].getStr
      if topic.file.isSome:
        check topic.content == oracle["topicTexts"][topic.name].getStr

  test "the generated tools topic uses the live tool definitions":
    check getTopic("tools") == oracle["topicTexts"]["tools"].getStr
    check getTopic("tools").startsWith("# Tools\n\n19 tools over stdio.")

  test "missing index and all match Node exactly":
    check getTopic("") == oracle["index"].getStr
    check getTopic("index") == oracle["index"].getStr
    check getTopic("all") == oracle["all"].getStr

  test "unknown topics use the Node error message":
    for name, expected in oracle["unknownErrors"]:
      check errorFor(name) == expected.getStr
