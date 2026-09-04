import { createAgentApi } from "./agent.js";
import { createWatcher } from "./watch.js";

/**
 * The MCP endpoint is loaded on demand: it pulls in the SDK and the render
 * pipeline, and most sessions never touch it. A failed import (SDK not
 * installed) leaves /mcp 501ing rather than taking the dev server down.
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

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * A JSON body, and only a JSON body. Requiring the content type is what keeps
 * a web page in the user's browser from writing to the vault: a cross-site
 * `fetch(..., {mode: "no-cors"})` can only send text/plain, which is refused
 * here before it is parsed.
 */
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      const type = String(req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) {
        return reject(httpError(415, "send the body as application/json"));
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body ?? null));
};

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(:\d+)?$/i;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The vault is private to this machine. Two checks keep it that way even
 * though the server answers on a plain localhost port:
 *
 * - Host must be a loopback name. A DNS-rebinding page (evil.example
 *   resolving to 127.0.0.1) arrives with its own hostname in Host and is
 *   refused, so it cannot read scenes.
 * - A mutating request that carries an Origin header must come from a
 *   loopback origin. Browsers add Origin to every cross-site POST, so a page
 *   on another site cannot write; curl and the app's own same-origin fetches
 *   pass untouched.
 */
const refuse = (req) => {
  const host = String(req.headers.host ?? "");
  if (!LOOPBACK.test(host)) return httpError(403, `refusing host "${host}": sketchdex only answers on localhost`);
  if (MUTATING.has(req.method) && req.headers.origin) {
    let origin = null;
    try {
      origin = new URL(req.headers.origin).host;
    } catch {
      // an unparseable Origin is not a browser we trust
    }
    if (!origin || !LOOPBACK.test(origin)) {
      return httpError(403, `refusing cross-site request from "${req.headers.origin}"`);
    }
  }
  return null;
};

/** What a caller can act on: not-found, bad input and conflicts are not 500s. */
const statusOf = (err) => {
  if (err?.status) return err.status;
  if (err?.code === "ENOENT" || /^no scene matching/.test(err?.message ?? "")) return 404;
  if (/matches \d+ scenes/.test(err?.message ?? "")) return 409;
  if (err instanceof SyntaxError || /^bad id$/.test(err?.message ?? "")) return 400;
  return 500;
};

/**
 * Connect-style middleware backing the client store with real files.
 * Mounted on the Vite dev and preview servers, and on the plain Node server
 * in serve.js.
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

  /** A write landed through this server: tag it by the exact bytes it made. */
  const noteAgentWrite = async (sceneId) => {
    if (sceneId) watcher.noteWrite(sceneId, "agent", await store.rev(sceneId));
  };

  const middleware = async function sketchdexStoreMiddleware(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    const isMcp = url.pathname === "/mcp";
    if (!isMcp && !url.pathname.startsWith("/api/")) return next();

    const parts = url.pathname.split("/").filter(Boolean);
    const [, resource, id, sub, subId, action] = parts;
    const client = req.headers["x-sketchdex-client"];

    try {
      const refused = refuse(req);
      if (refused) throw refused;

      /**
       * The same tools the stdio MCP server exposes, over HTTP on this port,
       * for clients that can only be pointed at a URL.
       */
      if (isMcp) {
        const handler = await getMcpHandler(api);
        if (!handler) return send(res, 501, { error: "MCP transport unavailable" });
        const body = req.method === "POST" ? await readBody(req) : undefined;
        return await handler(req, res, body);
      }

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
        await noteAgentWrite(result?.sceneId);
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
          await noteAgentWrite(id);
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
      const status = statusOf(err);
      if (status >= 500) console.error("[sketchdex] store error:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      return send(res, status, { error: String(err?.message ?? err) });
    }
  };

  /** Stop the folder watch and end every event stream, so a host can exit. */
  middleware.close = () => watcher.close();
  return middleware;
}

export function sketchdexStore(vaultPath) {
  const middleware = createStoreMiddleware(vaultPath);
  return {
    name: "sketchdex-store",
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => middleware.close());
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", () => middleware.close());
    },
  };
}
