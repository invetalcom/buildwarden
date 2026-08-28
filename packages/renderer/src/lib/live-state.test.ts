import type { AppSnapshot, ChatDetail, ChatEvent, ChatRecord, RunDetail, RunEvent, RunRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  applyLiveChatEventToDetail,
  applyLiveChatToSnapshot,
  applyLiveRunEventToDetail,
  applyLiveRunToSnapshot,
} from "./live-state";

const run = {
  id: "run-1",
  projectId: "project-1",
  kind: "standard",
  status: "running",
  listVisibility: "default",
  createdAt: "2026-08-28T10:00:00.000Z",
} as RunRecord;

const snapshot = {
  projects: [{
    project: { id: "project-1" },
    runs: [{ ...run, status: "queued" }],
    forLaterRuns: [],
    orchestratedRuns: [],
    activeRuns: [],
    recentRuns: [],
    tasks: [],
    insights: [],
    labThreads: [],
    loops: [],
  }],
  providerAccounts: [],
  models: [],
  selectedProjectId: null,
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
} as unknown as AppSnapshot;

describe("live remote state", () => {
  it("patches every derived run list from one authoritative row", () => {
    const next = applyLiveRunToSnapshot(snapshot, run).projects[0]!;
    expect(next.runs[0]).toBe(run);
    expect(next.activeRuns).toEqual([run]);
    expect(next.recentRuns).toEqual([run]);
  });

  it("prepends a newly observed standard run to the matching project", () => {
    const newRun = {
      ...run,
      id: "run-2",
      createdAt: "2026-08-28T10:01:00.000Z",
    };
    const next = applyLiveRunToSnapshot(snapshot, newRun).projects[0]!;
    expect(next.runs.map(({ id }) => id)).toEqual([newRun.id, run.id]);
    expect(next.activeRuns.map(({ id }) => id)).toEqual([newRun.id, run.id]);
    expect(next.recentRuns.map(({ id }) => id)).toEqual([newRun.id, run.id]);
  });

  it("upserts durable run steps instead of duplicating streaming replacements", () => {
    const originalStep = {
      id: "step-1", runId: run.id, eventType: "output", title: "Agent output", content: "a",
      metadataJson: "{}", createdAt: "2026-08-28T10:00:01.000Z",
    } as const;
    const replacement = { ...originalStep, content: "accumulated output" };
    const detail = { run, steps: [originalStep], notes: [], diff: "" } as RunDetail;
    const event = {
      runId: run.id, type: "output", title: "Agent output", content: replacement.content,
      createdAt: replacement.createdAt, run, step: replacement,
    } satisfies RunEvent;
    const next = applyLiveRunEventToDetail(detail, event);
    expect(next.steps).toEqual([replacement]);
    expect(next.run).toBe(run);
  });

  it("patches chat summaries and durable chat steps", () => {
    const chat = {
      id: "chat-1", runId: null, prompt: "Hello", status: "running", createdAt: run.createdAt,
    } as ChatRecord;
    const withChat = {
      ...snapshot,
      chats: [{ id: chat.id, prompt: chat.prompt, status: "queued" as const, createdAt: chat.createdAt }],
    };
    expect(applyLiveChatToSnapshot(withChat, chat).chats[0]?.status).toBe("running");

    const step = {
      id: "chat-step-1", chatId: chat.id, eventType: "output", title: "Agent output", content: "Hi",
      metadataJson: "{}", createdAt: "2026-08-28T10:00:01.000Z",
    } as const;
    const detail = { chat, steps: [] } as ChatDetail;
    const event = {
      runId: chat.id, chatId: chat.id, type: "output", title: step.title, content: step.content,
      createdAt: step.createdAt, chat, step,
    } satisfies ChatEvent;
    expect(applyLiveChatEventToDetail(detail, event).steps).toEqual([step]);
  });

  it("prepends absent standalone chats and excludes run-scoped chats", () => {
    const standaloneChat = {
      id: "chat-new", runId: null, prompt: "New chat", status: "preparing", createdAt: run.createdAt,
    } as ChatRecord;
    const withStandalone = applyLiveChatToSnapshot(snapshot, standaloneChat);
    expect(withStandalone.chats).toEqual([expect.objectContaining({ id: standaloneChat.id })]);

    const runChat = { ...standaloneChat, id: "chat-run", runId: run.id };
    expect(applyLiveChatToSnapshot(withStandalone, runChat)).toBe(withStandalone);
  });
});
