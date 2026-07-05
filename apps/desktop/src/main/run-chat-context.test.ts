import { describe, expect, it } from "vitest";
import {
  buildPriorChatCompletionMessagesFromSteps,
  RUN_CHAT_CONTEXT_SOURCE,
  type ChatStepRecord,
  type RunRecord,
  type RunStepRecord,
} from "@buildwarden/shared";
import {
  buildRunChatContext,
  buildRunChatFirstTurnPrompt,
  buildRunChatUpdateTurnPrompt,
  providerReplaysChatHistory,
} from "./run-chat-context";

const makeRun = (overrides: Partial<RunRecord> = {}): RunRecord =>
  ({
    id: "run-1",
    projectId: "project-1",
    providerAccountId: "provider-1",
    modelId: "model-1",
    harnessType: "ai-sdk",
    mode: "code",
    workspaceType: "worktree",
    workspaceVcs: "git",
    prompt: "Implement the feature",
    goalText: null,
    status: "completed",
    branchName: "buildwarden/run-1",
    worktreePath: "C:\\repo\\.worktrees\\run-1",
    summary: null,
    errorMessage: null,
    lastProviderResponseId: null,
    inputTokens: 0,
    outputTokens: 0,
    listVisibility: "visible",
    kind: "standard",
    labThreadId: null,
    parentRunId: null,
    rootRunId: null,
    lineageTitle: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T11:00:00.000Z",
    startedAt: "2026-07-01T10:00:05.000Z",
    finishedAt: "2026-07-01T10:30:00.000Z",
    ...overrides,
  }) as RunRecord;

const makeStep = (overrides: Partial<RunStepRecord>): RunStepRecord => ({
  id: `step-${Math.random().toString(36).slice(2)}`,
  runId: "run-1",
  eventType: "log",
  title: "",
  content: "",
  metadataJson: "{}",
  createdAt: "2026-07-01T10:05:00.000Z",
  ...overrides,
});

describe("buildRunChatContext", () => {
  it("includes run info, user prompts, agent output, and the diff", () => {
    const context = buildRunChatContext({
      run: makeRun(),
      steps: [
        makeStep({ eventType: "log", content: "Implement the feature", metadataJson: JSON.stringify({ source: "user" }) }),
        makeStep({ eventType: "output", content: "Deep thoughts", title: "Reasoning", metadataJson: JSON.stringify({ assistantKind: "reasoning" }) }),
        makeStep({ eventType: "output", content: "I implemented the feature in foo.ts." }),
        makeStep({ eventType: "output", content: "subagent detail", metadataJson: JSON.stringify({ subagentId: "sub-1" }) }),
      ],
      projectName: "Repo",
      diff: "diff --git a/foo.ts b/foo.ts\n+added line",
    });

    expect(context).toContain("Project: Repo");
    expect(context).toContain("Branch: buildwarden/run-1");
    expect(context).toContain("Implement the feature");
    expect(context).toContain("I implemented the feature in foo.ts.");
    expect(context).toContain("diff --git a/foo.ts b/foo.ts");
    expect(context).not.toContain("Deep thoughts");
    expect(context).not.toContain("subagent detail");
  });

  it("explains a missing diff instead of leaving the section empty", () => {
    const context = buildRunChatContext({
      run: makeRun(),
      steps: [],
      projectName: "Repo",
      diff: "",
      diffUnavailableReason: "The Git workspace is no longer available.",
    });

    expect(context).toContain("No diff is available (The Git workspace is no longer available.)");
  });

  it("truncates oversized diffs per file and reports omitted files", () => {
    const bigFile = `diff --git a/big.ts b/big.ts\n${"+x".repeat(40_000)}`;
    const files = Array.from({ length: 10 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n${"+line\n".repeat(2_000)}`);
    const context = buildRunChatContext({
      run: makeRun(),
      steps: [],
      projectName: "Repo",
      diff: [bigFile, ...files].join("\n"),
    });

    expect(context.length).toBeLessThan(120_000);
    expect(context).toContain("[... truncated ...]");
    expect(context).toMatch(/file diffs? omitted to stay within the context budget/);
  });

  it("keeps the most recent assistant outputs when over budget", () => {
    const context = buildRunChatContext({
      run: makeRun(),
      steps: [
        makeStep({ eventType: "output", content: `OLD ${"a".repeat(30_000)}` }),
        makeStep({ eventType: "output", content: "FINAL summary of the run" }),
      ],
      projectName: "Repo",
      diff: "",
    });

    expect(context).toContain("FINAL summary of the run");
    expect(context).toContain("[... earlier entries omitted ...]");
  });
});

describe("run chat turn prompts", () => {
  it("packs context and question into the first session-provider turn", () => {
    const prompt = buildRunChatFirstTurnPrompt("THE CONTEXT", "What changed?");
    expect(prompt).toContain("THE CONTEXT");
    expect(prompt).toContain("<question>\nWhat changed?\n</question>");
  });

  it("marks refreshed context as replacing earlier versions on update turns", () => {
    const prompt = buildRunChatUpdateTurnPrompt("NEW CONTEXT", "And now?");
    expect(prompt).toContain("replaces every earlier version");
    expect(prompt).toContain("NEW CONTEXT");
    expect(prompt).toContain("<question>\nAnd now?\n</question>");
  });

  it("falls back to an attachment hint when the question is empty", () => {
    expect(buildRunChatFirstTurnPrompt("CTX", "")).toContain("See the attached files.");
    expect(buildRunChatUpdateTurnPrompt("CTX", "")).toContain("See the attached files.");
  });

  it("classifies providers by how they carry conversation history", () => {
    expect(providerReplaysChatHistory("ai-sdk")).toBe(true);
    expect(providerReplaysChatHistory("azure-legacy")).toBe(true);
    expect(providerReplaysChatHistory("claude-code")).toBe(false);
    expect(providerReplaysChatHistory("codex-cli")).toBe(false);
    expect(providerReplaysChatHistory("cursor-agent")).toBe(false);
  });
});

describe("run chat prior-message history", () => {
  it("replays the hidden run-context step as a user turn", () => {
    const steps: ChatStepRecord[] = [
      {
        id: "s1",
        chatId: "chat-1",
        eventType: "log",
        title: "Run context",
        content: "the run context block",
        metadataJson: JSON.stringify({ source: RUN_CHAT_CONTEXT_SOURCE, hidden: true }),
        createdAt: "2026-07-01T10:00:00.000Z",
      },
      {
        id: "s2",
        chatId: "chat-1",
        eventType: "log",
        title: "Initial message",
        content: "What changed?",
        metadataJson: JSON.stringify({ source: "user" }),
        createdAt: "2026-07-01T10:00:01.000Z",
      },
      {
        id: "s3",
        chatId: "chat-1",
        eventType: "output",
        title: "Agent output",
        content: "The run changed foo.ts.",
        metadataJson: "{}",
        createdAt: "2026-07-01T10:00:02.000Z",
      },
    ];

    expect(buildPriorChatCompletionMessagesFromSteps(steps)).toEqual([
      { role: "user", content: "the run context block" },
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "The run changed foo.ts." },
    ]);
  });
});
