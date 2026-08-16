export type SceneMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  elementCount: number;
  starred?: boolean;
  /** When the card preview was last drawn; older than updatedAt means stale. */
  thumbAt?: number;
};

export type ScenePayload = {
  elements: readonly any[];
  appState: Record<string, any>;
  files: Record<string, any> | null;
  /** Revision of the file this came from (mtime + size); null when unknown. */
  rev?: string | null;
};
