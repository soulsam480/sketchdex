import { createAgentApi } from "../server/agent.js";
import { INSTRUCTIONS, TOOLS, VERSION, dispatch } from "./tools.js";

/**
 * Where the tools actually run.
 *
 * A separate process purely so it can be thrown away. An ES module graph cannot
 * be un-imported, so the only honest way to pick up an edit is a fresh process -
 * and putting the fresh process *here*, behind the supervisor, means the client
 * on the other end of the stdio pipe never notices. See server.js.
 *
 * Holds no state between calls: everything is read from and written to the vault
 * per request, so being restarted mid-session costs nothing.
 */

const api = createAgentApi(process.env.SKETCHDEX_VAULT);

/**
 * Die with the supervisor.
 *
 * A forked child outlives its parent on POSIX - it is reparented to init and
 * keeps running. So stopping a Sketchdex server from the Processes page (which
 * lists supervisors, since they are the ones holding the client connection)
 * would leave this behind as an invisible orphan doing nothing forever. The IPC
 * channel closing is the signal that the parent is gone.
 */
process.on("disconnect", () => process.exit(0));

process.on("message", async (message) => {
  if (message?.type !== "call") return;
  try {
    const result = await dispatch(api, message.name, message.args ?? {});
    process.send({ type: "result", id: message.id, result });
  } catch (err) {
    process.send({
      type: "result",
      id: message.id,
      result: {
        isError: true,
        content: [{ type: "text", text: String(err?.message ?? err) }],
      },
    });
  }
});

process.send({ type: "ready", tools: TOOLS, version: VERSION, vault: api.vault, instructions: INSTRUCTIONS });
