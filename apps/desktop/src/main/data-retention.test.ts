import type { ChatRecord, ProjectLabThreadRecord, ProjectLoopRecord, RunRecord } from "@buildwarden/shared";
import { DEFAULT_DATA_RETENTION_CLEANUP_DAYS, parseDataRetentionCleanupDaysSetting } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { buildDataRetentionCleanupPlan } from "./data-retention";

const OLD = "2020-01-01T00:00:00.000Z";
const NEW = "2030-01-01T00:00:00.000Z";
const CUTOFF = "2026-01-01T00:00:00.000Z";

const runRecord = (id: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id,
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "codex-app-server",
  mode: "code",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: id,
  goalText: null,
  status: "completed",
  branchName: `feat/${id}`,
  worktreePath: `C:/repo/${id}`,
  summary: null,
  errorMessage: null,
  lastProviderResponseId: null,
  inputTokens: 0,
  outputTokens: 0,
  listVisibility: "default",
  kind: "standard",
  labThreadId: null,
  parentRunId: null,
  rootRunId: null,
  lineageTitle: null,
  projectTaskId: null,
  delegationEnabled: false,
  createdAt: OLD,
  updatedAt: OLD,
  startedAt: OLD,
  finishedAt: OLD,
  ...overrides,
});

const chatRecord = (id: string, runId: string | null = null, overrides: Partial<ChatRecord> = {}): ChatRecord => ({
  id,
  providerAccountId: "provider-1",
  modelId: "model-1",
  runId,
  prompt: id,
  status: "completed",
  lastProviderResponseId: null,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: OLD,
  updatedAt: OLD,
  startedAt: OLD,
  finishedAt: OLD,
  ...overrides,
});

const labThread = (id: string, implementationRunId: string | null): ProjectLabThreadRecord => ({
  id,
  projectId: "project-1",
  kind: "implementation",
  mode: "new-feature",
  status: "completed",
  origin: "manual",
  title: id,
  summary: id,
  outcome: null,
  seedPrompt: null,
  implementationPrompt: null,
  implementationRunId,
  implementationModelId: "model-1",
  reviewModelId: null,
  baseBranch: "main",
  createdAt: OLD,
  updatedAt: OLD,
});

const loopRecord = (id: string): ProjectLoopRecord => ({
  id,
  projectId: "project-1",
  name: id,
  prompt: id,
  runnerModelId: "model-1",
  reviewModelId: null,
  mergePolicy: "wait-for-approval",
  uiChangePolicy: "auto",
  prReviewPolicy: "none",
  uiReviewInstructions: null,
  baseBranch: "main",
  status: "completed",
  planSummary: null,
  errorMessage: null,
  createdAt: OLD,
  updatedAt: OLD,
  startedAt: OLD,
  finishedAt: OLD,
});

const plan = (overrides: Partial<Parameters<typeof buildDataRetentionCleanupPlan>[0]> = {}) =>
  buildDataRetentionCleanupPlan({
    dayCount: 30,
    cutoffAt: CUTOFF,
    runs: [],
    chats: [],
    bookmarks: [],
    chatBookmarks: [],
    projectLabThreads: [],
    projectLoops: [],
    rootRunIdByRunId: new Map(),
    ...overrides,
  });

describe("data-retention cleanup planning", () => {
  it("never selects bookmarked or For later runs and preserves their run chats", () => {
    const ordinary = runRecord("ordinary");
    const bookmarked = runRecord("bookmarked");
    const forLater = runRecord("for-later", { listVisibility: "for-later" });
    const result = plan({
      runs: [ordinary, bookmarked, forLater],
      chats: [
        chatRecord("ordinary-chat", ordinary.id),
        chatRecord("bookmarked-run-chat", bookmarked.id),
        chatRecord("for-later-run-chat", forLater.id),
      ],
      bookmarks: [{ id: "bookmark-1", originalRunId: bookmarked.id }],
    });

    expect(result.runIds).toEqual([ordinary.id]);
    expect(result.chatIds).toEqual(["ordinary-chat"]);
    expect(result.deletionRootRunIds).toEqual([ordinary.id]);
  });

  it("never selects a bookmarked chat or its owning run cascade", () => {
    const run = runRecord("run-with-favorite-chat");
    const result = plan({
      runs: [run],
      chats: [chatRecord("favorite-chat", run.id), chatRecord("other-old-chat", run.id)],
      chatBookmarks: [{ id: "chat-bookmark-1", originalChatId: "favorite-chat" }],
    });

    expect(result.runIds).toEqual([]);
    expect(result.deletionRootRunIds).toEqual([]);
    expect(result.chatIds).toEqual(["other-old-chat"]);
  });

  it("blocks an entire orchestration when any child is newer than the threshold", () => {
    const coordinator = runRecord("coordinator");
    const child = runRecord("child", { kind: "orchestration-task", updatedAt: NEW });
    const rootRunIdByRunId = new Map([[coordinator.id, coordinator.id], [child.id, coordinator.id]]);
    const result = plan({ runs: [coordinator, child], rootRunIdByRunId });

    expect(result.runIds).toEqual([]);
    expect(result.deletionRootRunIds).toEqual([]);
  });

  it("preserves every run chat in an orchestration when one run is protected", () => {
    const coordinator = runRecord("coordinator", { listVisibility: "for-later" });
    const child = runRecord("child", { kind: "orchestration-task" });
    const rootRunIdByRunId = new Map([[coordinator.id, coordinator.id], [child.id, coordinator.id]]);
    const result = plan({
      runs: [coordinator, child],
      chats: [chatRecord("child-chat", child.id)],
      rootRunIdByRunId,
    });

    expect(result.runIds).toEqual([]);
    expect(result.chatIds).toEqual([]);
  });

  it("protects old Project Lab and loop records when their implementation run is protected", () => {
    const labRun = runRecord("lab-run");
    const loopRun = runRecord("loop-run", { listVisibility: "for-later" });
    const result = plan({
      runs: [labRun, loopRun],
      bookmarks: [{ id: "bookmark-lab", originalRunId: labRun.id }],
      projectLabThreads: [labThread("lab-1", labRun.id)],
      projectLoops: [{ loop: loopRecord("loop-1"), runIds: [loopRun.id] }],
    });

    expect(result.projectLabThreadIds).toEqual([]);
    expect(result.projectLoopIds).toEqual([]);
    expect(result.runIds).toEqual([]);
  });

  it("selects an old owner and its eligible implementation runs as one cleanup group", () => {
    const labRun = runRecord("lab-run");
    const result = plan({
      runs: [labRun],
      chats: [chatRecord("lab-chat", labRun.id)],
      projectLabThreads: [labThread("lab-1", labRun.id)],
    });

    expect(result.projectLabThreadIds).toEqual(["lab-1"]);
    expect(result.runIds).toEqual([labRun.id]);
    expect(result.chatIds).toEqual(["lab-chat"]);
    expect(result.deletionRootRunIds).toEqual([]);
  });
});

describe("data-retention day parsing", () => {
  it("uses the default for missing and blank settings", () => {
    expect(parseDataRetentionCleanupDaysSetting(null)).toBe(DEFAULT_DATA_RETENTION_CLEANUP_DAYS);
    expect(parseDataRetentionCleanupDaysSetting(undefined)).toBe(DEFAULT_DATA_RETENTION_CLEANUP_DAYS);
    expect(parseDataRetentionCleanupDaysSetting("")).toBe(DEFAULT_DATA_RETENTION_CLEANUP_DAYS);
    expect(parseDataRetentionCleanupDaysSetting("   ")).toBe(DEFAULT_DATA_RETENTION_CLEANUP_DAYS);
  });
});
