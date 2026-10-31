import type { AppSnapshot, BookmarkRecord, ChatBookmarkRecord } from "@buildwarden/shared";

export type BookmarkOriginal =
  | { kind: "chat"; chatId: string }
  | { kind: "run"; projectId: string; runId: string };

/**
 * Locate the live run/chat a bookmark was copied from, or null when it has been deleted.
 * Run lookups include for-later and orchestrated runs, which still open in run detail.
 */
export const resolveBookmarkOriginal = (
  snapshot: Pick<AppSnapshot, "projects" | "chats">,
  bookmark: BookmarkRecord | ChatBookmarkRecord,
): BookmarkOriginal | null => {
  if ("originalChatId" in bookmark) {
    const chatId = bookmark.originalChatId;
    return snapshot.chats.some((chat) => chat.id === chatId) ? { kind: "chat", chatId } : null;
  }
  const { originalRunId: runId, projectId } = bookmark;
  if (!projectId) return null;
  const project = snapshot.projects.find((entry) => entry.project.id === projectId);
  if (!project) return null;
  const exists = [...project.runs, ...project.forLaterRuns, ...project.orchestratedRuns].some((run) => run.id === runId);
  return exists ? { kind: "run", projectId, runId } : null;
};
