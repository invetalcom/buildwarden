/** @vitest-environment happy-dom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BuildWardenClient } from "@buildwarden/renderer";
import type { AppSnapshot, ChatDetail, RunDetail, RunRecord } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MobileAppProvider, type MobileAppValue } from "../data/mobile-app-context";
import { RunDetailScreen } from "./RunDetailScreen";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const runRecord = (id: string): RunRecord => ({
  id,
  projectId: "project-1",
  providerAccountId: "provider-1",
  modelId: "model-1",
  harnessType: "ai-sdk",
  mode: "ask",
  workspaceType: "worktree",
  workspaceVcs: "git",
  prompt: `Prompt for ${id}`,
  goalText: null,
  status: "completed",
  branchName: id,
  worktreePath: `/repo/${id}`,
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
});

const firstRun = runRecord("run-1");
const secondRun = runRecord("run-2");
const runDetail = (run: RunRecord): RunDetail => ({ run, steps: [], notes: [], diff: "" });

const firstChat: ChatDetail = {
  chat: {
    id: "chat-1",
    providerAccountId: "provider-1",
    modelId: "model-1",
    runId: firstRun.id,
    prompt: "Question about run one",
    status: "completed",
    lastProviderResponseId: null,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
  },
  steps: [{
    id: "step-1",
    chatId: "chat-1",
    eventType: "output",
    title: "Agent output",
    content: "Response belonging only to run one",
    metadataJson: "{}",
    createdAt: "2026-01-01T00:00:30.000Z",
  }],
};

const snapshot = {
  projects: [{
    project: {
      id: "project-1",
      name: "Project",
      repoPath: "/repo",
      baseBranch: "main",
      kind: "git",
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: null,
    },
    runs: [firstRun, secondRun],
    forLaterRuns: [],
    orchestratedRuns: [],
    activeRuns: [],
    recentRuns: [firstRun, secondRun],
    tasks: [],
    insights: [],
    labThreads: [],
    loops: [],
  }],
  providerAccounts: [],
  models: [],
  selectedProjectId: "project-1",
  selectedRunId: firstRun.id,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
} satisfies AppSnapshot;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("RunDetailScreen run chat", () => {
  it("does not show the previous run's transcript while the next run chat loads", async () => {
    const pendingSecondChat = deferred<ChatDetail | null>();
    const getRunChat = vi.fn((runId: string) => runId === firstRun.id
      ? Promise.resolve(firstChat)
      : pendingSecondChat.promise);
    const client = {
      capabilities: {
        chatMutations: true,
        runMutations: true,
        bookmarkMutations: true,
        runListVisibilityMutations: true,
        gitMutations: true,
        orchestrationRead: false,
      },
      getRunDetail: vi.fn((runId: string) => Promise.resolve(runDetail(runId === firstRun.id ? firstRun : secondRun))),
      refreshRunForgeRequest: vi.fn(async () => null),
      onRunEvent: vi.fn(() => vi.fn()),
      onRunForgeRequestChanged: vi.fn(() => vi.fn()),
      getRunChat,
      getChatDetail: vi.fn(async () => firstChat),
      onChatEvent: vi.fn(() => vi.fn()),
    } as unknown as BuildWardenClient;
    const value = {
      client,
      snapshot,
      snapshotStore: { loaded: true, refresh: vi.fn(async () => undefined) },
      router: { back: vi.fn(), replace: vi.fn() },
    } as unknown as MobileAppValue;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <RunDetailScreen runId={firstRun.id} segment="chat" />
      </MobileAppProvider>,
    ));
    expect(container.textContent).toContain("Response belonging only to run one");

    await act(async () => root.render(
      <MobileAppProvider value={value}>
        <RunDetailScreen runId={secondRun.id} segment="chat" />
      </MobileAppProvider>,
    ));

    expect(getRunChat).toHaveBeenCalledWith(secondRun.id);
    expect(container.textContent).not.toContain("Response belonging only to run one");
    expect(container.textContent).toContain("No run chat yet");
  });
});
