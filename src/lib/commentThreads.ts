import { capitalise } from "./format";
import type { Comment } from "./store";

export type ThreadFilter = "all" | "open" | "resolved";

export type Thread = {
  elementId: string;
  elementType: string;
  name: string;
  count: number;
  openCount: number;
  resolvedCount: number;
  status: "open" | "resolved";
  latest: Comment;
  snippet: string;
  authorName: string;
  authorKind: "human" | "agent";
  createdAt: number;
};

export const collapseSnippet = (body: string, max = 140): string => {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
};

const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const buildThreads = (
  comments: readonly Comment[],
  elements: readonly any[],
  nameOf: (elements: readonly any[], element: any) => string | undefined,
): Thread[] => {
  const grouped = new Map<string, Comment[]>();
  for (const comment of comments) {
    const bucket = grouped.get(comment.elementId);
    if (bucket) bucket.push(comment);
    else grouped.set(comment.elementId, [comment]);
  }

  const byId = new Map<string, any>();
  for (const element of elements) {
    if (!element?.id) continue;
    if (!element.isDeleted || !byId.has(element.id)) byId.set(element.id, element);
  }

  const threads: Thread[] = [];
  for (const [elementId, list] of grouped) {
    let latest = list[0];
    for (const comment of list) {
      if (
        comment.createdAt > latest.createdAt ||
        (comment.createdAt === latest.createdAt &&
          compareId(comment.id, latest.id) > 0)
      ) {
        latest = comment;
      }
    }

    const openCount = list.filter((comment) => comment.status === "open").length;
    const elementType = latest.elementType || "element";
    const element =
      byId.get(elementId) ?? { id: elementId, type: elementType };
    const named = nameOf(elements, element);
    const fromComment =
      typeof latest.elementText === "string" ? latest.elementText.trim() : "";

    threads.push({
      elementId,
      elementType,
      name: named || fromComment || capitalise(elementType),
      count: list.length,
      openCount,
      resolvedCount: list.length - openCount,
      status: openCount > 0 ? "open" : "resolved",
      latest,
      snippet: collapseSnippet(latest.body),
      authorName: latest.author.name,
      authorKind: latest.author.kind,
      createdAt: latest.createdAt,
    });
  }

  return threads.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return compareId(a.elementId, b.elementId);
  });
};

export const filterThreads = (
  threads: readonly Thread[],
  filter: ThreadFilter,
  query: string,
): Thread[] => {
  const needle = query.trim().toLowerCase();
  return threads.filter((thread) => {
    if (filter !== "all" && thread.status !== filter) return false;
    if (!needle) return true;
    return (
      thread.latest.body.toLowerCase().includes(needle) ||
      thread.name.toLowerCase().includes(needle)
    );
  });
};

export const threadCounts = (
  threads: readonly Thread[],
): Record<ThreadFilter, number> => {
  let open = 0;
  for (const thread of threads) if (thread.status === "open") open += 1;
  return { all: threads.length, open, resolved: threads.length - open };
};
