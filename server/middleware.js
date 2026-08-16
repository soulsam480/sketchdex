import { createAgentApi } from "./agent.js";
import { createWatcher } from "./watch.js";

/**
 * The MCP endpoint is loaded on demand: it pulls in the SDK and the render
 * pipeline, and most sessions never touch it. A failed import (SDK not
 * installed) leaves /mcp 404ing rather than taking the dev server down.
 */
let mcpHandler = null;
const getMcpHandler = async (api) => {
  if (mcpHandler !== null) return mcpHandler;
  try {
    const [{ StreamableHTTPServerTransport }, { createSketchdexServer }] =
      await Promise.all([
        import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
        import("../mcp/tools.js"),
      ]);
    mcpHandler = async (req, res, body) => {
      // stateless: one transport per request, so there is no session to lose
      // when the dev server restarts on a file change
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close());
      await createSketchdexServer(api).connect(transport);
      await transport.handleRequest(req, res, body);
    };
  } catch (err) {
    console.error("[sketchdex] /mcp unavailable:", err?.message ?? err);
    mcpHandler = false;
  }
  return mcpHandler;
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body ?? null));
};

/**
 * Connect-style middleware backing the client store with real files.
 * Mounted on both the dev server and the preview server.
 *
 * Three groups of routes:
 *   /api/scenes/*   the app's own CRUD, whole-scene at a time
 *   /api/agent/:op  the higher-level surface an agent uses (see agent.js);
 *                   also what a non-MCP caller like a shell script would hit
 *   /api/events     server-sent events, so an open tab notices agent writes
 */
export function createStoreMiddleware(vaultPath) {
  const api = createAgentApi(vaultPath);
  const store = api.store;
  const watcher = createWatcher(store.vault, {
    onExternal: (sceneId) => api.noteExternalChange(sceneId),
    revOf: (sceneId) => store.rev(sceneId),
  });

  const agentOps = {
    list: () => api.listScenes(),
    describe: (body) => api.describeScene(body.scene, body),
    read: (body) => api.readScene(body.scene, body),
    elements: (body) => api.readElements(body.scene, body),
    path: (body) => api.scenePath(body.scene),
    create: (body) => api.createScene(body),
    add: (body) => api.addElements(body.scene, body.elements, body),
    update: (body) => api.updateElements(body.scene, body.elements, body),
    delete: (body) => api.deleteElements(body.scene, body.ids, body),
    move: (body) => api.moveElements(body.scene, body),
    replace: (body) => api.replaceElements(body.scene, body.elements, body),
    write: (body) => api.writeScene(body.scene, body),
    background: (body) => api.setBackground(body.scene, body.color, body),
    snapshot: (body) => api.snapshot(body.scene, body.label),
    svg: (body) => api.importSvg(body.scene, body.svg, body),
    check: (body) => api.checkScene(body.scene, body),
    history: (body) => api.listHistory(body.scene),
    restore: (body) => api.restoreSnapshot(body.scene, body.snapshot),
    discard: (body) => api.discardSnapshot(body.scene, body.snapshot),
    clear: (body) => api.clearHistory(body.scene),
  };

  return async function sketchdexStoreMiddleware(req, res, next) {
    const url = new URL(req.url, "http://localhost");

    /**
     * The same tools the stdio MCP server exposes, over HTTP on this port, for
     * clients that can only be pointed at a URL.
     */
    if (url.pathname === "/mcp") {
      const handler = await getMcpHandler(api);
      if (!handler) return send(res, 501, { error: "MCP transport unavailable" });
      const body = req.method === "POST" ? await readBody(req) : undefined;
      return handler(req, res, body);
    }

    if (!url.pathname.startsWith("/api/")) return next();

    const parts = url.pathname.split("/").filter(Boolean);
    const [, resource, id, sub, subId, action] = parts;
    const client = req.headers["x-sketchdex-client"];

    try {
      if (resource === "vault" && req.method === "GET") {
        return send(res, 200, { vault: store.vault });
      }

      if (resource === "events") {
        return watcher.subscribe(req, res);
      }

      /* ---- agent surface ------------------------------------------ */
      if (resource === "agent") {
        if (req.method !== "POST") {
          // a plain GET is how someone discovers what is here
          return send(res, 200, { ops: Object.keys(agentOps) });
        }
        const op = agentOps[id];
        if (!op) return send(res, 404, { error: `unknown op "${id}"` });
        const result = await op(await readBody(req));
        if (result?.sceneId) watcher.noteWrite(result.sceneId, "agent");
        return send(res, 200, result);
      }

      if (resource !== "scenes") return next();

      // /api/scenes
      if (!id) {
        if (req.method === "GET") return send(res, 200, await store.list());
        if (req.method === "POST") {
          const body = await readBody(req);
          if (body.import) {
            return send(res, 200, await store.importScene(body.import));
          }
          return send(res, 200, await store.create(body));
        }
        return send(res, 405, { error: "method not allowed" });
      }

      /* ---- history ------------------------------------------------ */
      if (sub === "history") {
        // /api/scenes/:id/history
        if (!subId) {
          if (req.method === "GET") {
            return send(res, 200, await api.history.list(id));
          }
          // clearing the whole list is what "keep this, I am happy" does
          if (req.method === "DELETE") {
            await api.history.clear(id);
            watcher.push({ type: "history", id });
            return send(res, 200, { entries: [] });
          }
          return send(res, 405, { error: "method not allowed" });
        }

        // /api/scenes/:id/history/:snapId/restore
        if (action === "restore" && req.method === "POST") {
          const result = await api.restoreSnapshot(id, subId);
          watcher.noteWrite(id, "agent");
          watcher.push({ type: "history", id });
          return send(res, 200, result);
        }

        // /api/scenes/:id/history/:snapId
        if (req.method === "GET") {
          return send(res, 200, await api.history.read(id, subId));
        }
        if (req.method === "DELETE") {
          const entries = await api.history.discard(id, subId);
          watcher.push({ type: "history", id });
          return send(res, 200, { entries });
        }
        return send(res, 405, { error: "method not allowed" });
      }

      // /api/scenes/:id/thumb
      if (sub === "thumb") {
        if (req.method === "GET") {
          return send(res, 200, { svg: await store.readThumb(id) });
        }
        if (req.method === "PUT") {
          const { svg } = await readBody(req);
          await store.writeThumb(id, svg ?? "");
          return send(res, 200, { ok: true });
        }
        return send(res, 405, { error: "method not allowed" });
      }

      // /api/scenes/:id/duplicate
      if (sub === "duplicate" && req.method === "POST") {
        return send(res, 200, await store.duplicate(id));
      }

      // /api/scenes/:id
      if (req.method === "GET") {
        const payload = await store.read(id);
        api.observe(id, payload);
        return send(res, 200, payload);
      }
      if (req.method === "PUT") {
        const { payload, touch, ifRev } = await readBody(req);
        // tag the write before it lands (in case the watcher fires first), then
        // again with the exact revision it produced, so the echo is unmistakable
        watcher.noteWrite(id, client);
        let scenes;
        try {
          scenes = await store.save(id, payload, { touch, ifRev });
        } catch (err) {
          if (err?.status === 409) {
            // not ours after all: the file moved on under this tab
            watcher.noteWrite(id, "external");
            return send(res, 409, { error: err.message, code: "conflict", rev: err.rev });
          }
          throw err;
        }
        const rev = await store.rev(id);
        watcher.noteWrite(id, client, rev);
        api.observe(id, payload);
        return send(res, 200, { scenes, rev });
      }
      if (req.method === "PATCH") {
        watcher.noteWrite(id, client);
        const scenes = await store.patch(id, await readBody(req));
        watcher.noteWrite(id, client, await store.rev(id));
        return send(res, 200, scenes);
      }
      if (req.method === "DELETE") {
        await api.history.clear(id).catch(() => {});
        return send(res, 200, await store.remove(id));
      }
      return send(res, 405, { error: "method not allowed" });
    } catch (err) {
      console.error("[sketchdex] store error:", err);
      return send(res, 500, { error: String(err?.message ?? err) });
    }
  };
}

export function sketchdexStore(vaultPath) {
  const middleware = createStoreMiddleware(vaultPath);
  return {
    name: "sketchdex-store",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
