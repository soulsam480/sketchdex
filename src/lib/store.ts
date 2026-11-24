import type { SceneMeta, ScenePayload } from "./types";

/**
 * Scenes live as real .excalidraw files in the vault folder on disk, served by
 * the dev/preview server (see server/store.js). The browser holds no source of
 * truth: clearing site data costs nothing but the open tab.
 */

type StatusListener = (down: boolean) => void;
const listeners = new Set<StatusListener>();
let storageDown = false;

const setStorageDown = (value: boolean) => {
  if (value === storageDown) return;
  storageDown = value;
  for (const listener of listeners) listener(value);
};

export const onStorageStatus = (listener: StatusListener) => {
  listeners.add(listener);
  listener(storageDown);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Identifies this tab on writes. The server tags each change with whoever made
 * it and echoes that back over /api/events, which is how a tab tells its own
 * save apart from an edit that arrived from somewhere else.
 */
export const clientId = Math.random().toString(36).slice(2, 10);

/**
 * Every non-2xx answer is thrown as one of these. `status` is what callers
 * branch on: 404 for a scene that is gone, 409 for a conflict, 5xx for a vault
 * that is actually failing.
 */
export type ApiError = Error & { status: number; body: any };

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Sketchdex-Client": clientId,
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    // fetch only rejects when no answer came back at all: the server is not
    // running or the network is gone. That is the one case that is an outage.
    setStorageDown(true);
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error: ApiError = Object.assign(
      new Error(`${res.status} ${res.statusText}`),
      { status: res.status, body },
    );
    // a 4xx (missing scene, bad request, conflict) is a real answer from a
    // healthy vault and must not raise the outage banner; 5xx means the vault
    // itself is broken
    setStorageDown(res.status >= 500);
    throw error;
  }
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch (err) {
    // a 2xx that is not JSON means something other than the API answered
    // (the dev server without its middleware, a proxy page): treat as down
    setStorageDown(true);
    throw err;
  }
  setStorageDown(false);
  return data;
};

/**
 * Only a handful of appState fields are worth persisting. The rest is
 * transient UI state, and some of it (collaborators) is not plain data.
 */
const PERSISTED_APP_STATE = [
  "viewBackgroundColor",
  "gridSize",
  "gridModeEnabled",
  "scrollX",
  "scrollY",
  "zoom",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemStrokeStyle",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemStartArrowhead",
  "currentItemEndArrowhead",
  "currentItemRoundness",
] as const;

export const slimAppState = (appState: Record<string, any>) => {
  const out: Record<string, any> = {};
  for (const key of PERSISTED_APP_STATE) {
    if (appState[key] !== undefined) {
      out[key] = appState[key];
    }
  }
  return out;
};

export const loadIndex = () => api<SceneMeta[]>("/scenes");

export const createScene = (name = "Untitled") =>
  api<SceneMeta>("/scenes", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const loadScene = (id: string) =>
  api<ScenePayload>(`/scenes/${id}`).catch(() => null);

/**
 * Browsers let a keepalive request outlive its page, but cap the body at 64 KB
 * (shared across every keepalive request in flight) and reject bigger ones
 * outright. Stay a little under it so the save is never refused for size.
 */
const KEEPALIVE_LIMIT = 60 * 1024;

/**
 * `ifRev` makes the save conditional on the file still being the revision the
 * tab last saw. If something else (an agent, another tab) wrote in between the
 * server answers 409 instead of letting this write land on top; the error
 * carries `status: 409` and `body.rev`. Omit it for an unconditional write.
 *
 * `keepalive` is for the save fired as the tab hides or closes: the request
 * keeps going after the page is gone, as long as the body is small enough.
 * A scene over the limit goes the normal way and takes its chances.
 */
export const saveScene = (
  id: string,
  payload: ScenePayload,
  {
    touch = true,
    ifRev,
    keepalive = false,
  }: { touch?: boolean; ifRev?: string | null; keepalive?: boolean } = {},
) => {
  const { rev: _rev, ...body } = payload;
  const json = JSON.stringify({ payload: body, touch, ifRev: ifRev ?? undefined });
  return api<{ scenes: SceneMeta[]; rev: string | null }>(`/scenes/${id}`, {
    method: "PUT",
    body: json,
    keepalive: keepalive && new Blob([json]).size < KEEPALIVE_LIMIT,
  });
};

export const isConflict = (err: unknown) => (err as any)?.status === 409;

export const renameScene = (id: string, name: string) =>
  api<SceneMeta[]>(`/scenes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const toggleStar = async (id: string) => {
  const list = await loadIndex();
  const current = list.find((meta) => meta.id === id)?.starred ?? false;
  return api<SceneMeta[]>(`/scenes/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ starred: !current }),
  });
};

export const deleteScene = (id: string) =>
  api<SceneMeta[]>(`/scenes/${id}`, { method: "DELETE" });

export const duplicateScene = (id: string) =>
  api<SceneMeta | null>(`/scenes/${id}/duplicate`, { method: "POST" });

export const importScene = async (name: string, payload: ScenePayload) => {
  const meta = await createScene(name);
  await saveScene(meta.id, payload);
  return meta;
};

export const loadThumb = (id: string) =>
  api<{ svg: string }>(`/scenes/${id}/thumb`)
    .then((r) => r.svg || undefined)
    .catch(() => undefined);

export const saveThumb = (id: string, svg: string) =>
  api<{ ok: true }>(`/scenes/${id}/thumb`, {
    method: "PUT",
    body: JSON.stringify({ svg }),
  });

/* ---- history ---------------------------------------------------- */

export type Snapshot = {
  id: string;
  at: number;
  label: string;
  origin: string;
  elementCount: number;
  bytes: number;
};

export const loadHistory = (sceneId: string) =>
  api<{ entries: Snapshot[]; bytes: number }>(`/scenes/${sceneId}/history`).catch(
    () => ({ entries: [], bytes: 0 }),
  );

export const readSnapshot = (sceneId: string, snapId: string) =>
  api<{ elements: readonly any[]; appState: Record<string, any> }>(
    `/scenes/${sceneId}/history/${snapId}`,
  );

export const restoreSnapshot = (sceneId: string, snapId: string) =>
  api<unknown>(`/scenes/${sceneId}/history/${snapId}/restore`, {
    method: "POST",
  });

export const discardSnapshot = (sceneId: string, snapId: string) =>
  api<{ entries: Snapshot[] }>(`/scenes/${sceneId}/history/${snapId}`, {
    method: "DELETE",
  });

/** Accepting the current state: there is nothing left to decide. */
export const clearHistory = (sceneId: string) =>
  api<{ entries: Snapshot[] }>(`/scenes/${sceneId}/history`, {
    method: "DELETE",
  });

/* ---- comments ---------------------------------------------------- */

/**
 * Comments are stored on the element they are about, under
 * `customData.sketchdex.comments`, so they are part of the scene file rather
 * than a second document with its own revision. Every write goes through the
 * agent surface (`/api/agent/comment-*`), never through a canvas save: a
 * comment cannot overwrite a concurrent geometry edit, and a geometry save
 * reconciles to the version carrying the comment.
 */
export type Comment = {
  id: string;
  body: string;
  author: { kind: "human" | "agent"; name: string };
  createdAt: number;
  status: "open" | "resolved";
  resolvedAt?: number;
  elementId: string;
  elementType?: string;
  elementText?: string;
};

export type CommentList = {
  sceneId: string;
  name: string;
  total: number;
  open: number;
  resolved: number;
  truncated: boolean;
  comments: Comment[];
};

const commentLabel = (verb: string, body: string) => {
  const text = body.replace(/\s+/g, " ").trim();
  return `${verb}: ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`;
};

export const loadComments = (sceneId: string) =>
  api<CommentList>("/agent/comment-list", {
    method: "POST",
    body: JSON.stringify({ scene: sceneId, limit: 500 }),
  });

export const addComment = (sceneId: string, elementId: string, body: string) =>
  api<{ comment: Comment; open: number; resolved: number }>("/agent/comment-add", {
    method: "POST",
    body: JSON.stringify({
      scene: sceneId,
      elementId,
      body,
      author: "You",
      authorKind: "human",
      label: commentLabel("comment", body),
    }),
  });

export const updateComment = (
  sceneId: string,
  elementId: string,
  commentId: string,
  action: "resolve" | "reopen" | "delete",
  body: string,
) =>
  api<{ changed: boolean; status: string }>("/agent/comment-update", {
    method: "POST",
    body: JSON.stringify({
      scene: sceneId,
      elementId,
      commentId,
      action,
      label: commentLabel(action, body),
    }),
  });

/* ---- live changes ----------------------------------------------- */

export type VaultEvent =
  | { type: "scene"; id: string; by: string; at: number }
  | { type: "history"; id: string }
  /** The scene file is gone from the vault (deleted or moved away). */
  | { type: "removed"; id: string; at: number };

/**
 * Changes made outside this tab. An agent writing to the vault does not go
 * through the app at all, so without this the editor would hold a stale scene
 * in memory and overwrite the agent's work on its next save.
 */
export const onVaultEvent = (listener: (event: VaultEvent) => void) => {
  let source: EventSource | null = null;
  try {
    source = new EventSource("/api/events");
  } catch {
    return () => {};
  }
  const handle = (event: MessageEvent) => {
    try {
      listener(JSON.parse(event.data));
    } catch {
      // a malformed frame is not worth taking the stream down for
    }
  };
  source.addEventListener("message", handle);
  return () => {
    source?.removeEventListener("message", handle);
    source?.close();
  };
};

/** Used only by the one-time IndexedDB migration. */
export const importLegacyScene = (input: {
  meta: SceneMeta;
  payload: ScenePayload | null;
  thumb?: string;
}) =>
  api<SceneMeta>("/scenes", {
    method: "POST",
    body: JSON.stringify({ import: input }),
  });
