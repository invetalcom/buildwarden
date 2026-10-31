import { describe, expect, it } from "vitest";
import type { AppSnapshot, BookmarkRecord, ChatBookmarkRecord, ProjectSnapshot, RunListItem } from "@buildwarden/shared";
import { resolveBookmarkOriginal } from "./bookmark-original";

const run = (id: string) => ({ id }) as RunListItem;
const project = (id: string, lists: Partial<Pick<ProjectSnapshot, "runs" | "forLaterRuns" | "orchestratedRuns">>) =>
  ({ project: { id }, runs: [], forLaterRuns: [], orchestratedRuns: [], ...lists }) as unknown as ProjectSnapshot;

const snapshot: Pick<AppSnapshot, "projects" | "chats"> = {
  projects: [
    project("p1", { runs: [run("r-visible")], forLaterRuns: [run("r-later")], orchestratedRuns: [run("r-child")] }),
    project("p2", { runs: [run("r-other")] }),
  ],
  chats: [{ id: "c1", prompt: "", status: "completed", createdAt: "" }],
};

const runBookmark = (originalRunId: string, projectId: string | null) => ({ originalRunId, projectId }) as BookmarkRecord;
const chatBookmark = (originalChatId: string) => ({ originalChatId }) as ChatBookmarkRecord;

describe("resolveBookmarkOriginal", () => {
  it("finds a live chat and reports deleted chats as null", () => {
    expect(resolveBookmarkOriginal(snapshot, chatBookmark("c1"))).toEqual({ kind: "chat", chatId: "c1" });
    expect(resolveBookmarkOriginal(snapshot, chatBookmark("gone"))).toBeNull();
  });

  it("finds runs across visible, for-later, and orchestrated lists", () => {
    for (const runId of ["r-visible", "r-later", "r-child"]) {
      expect(resolveBookmarkOriginal(snapshot, runBookmark(runId, "p1"))).toEqual({ kind: "run", projectId: "p1", runId });
    }
  });

  it("returns null for deleted runs, deleted projects, runs in another project, and legacy bookmarks without a project", () => {
    expect(resolveBookmarkOriginal(snapshot, runBookmark("gone", "p1"))).toBeNull();
    expect(resolveBookmarkOriginal(snapshot, runBookmark("r-visible", "deleted-project"))).toBeNull();
    expect(resolveBookmarkOriginal(snapshot, runBookmark("r-other", "p1"))).toBeNull();
    expect(resolveBookmarkOriginal(snapshot, runBookmark("r-visible", null))).toBeNull();
  });
});
