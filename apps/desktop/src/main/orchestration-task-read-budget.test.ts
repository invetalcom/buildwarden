import { describe, expect, it } from "vitest";
import type { OrchestrationTaskMessageRecord, OrchestrationTaskRecord, OrchestrationTaskResultRecord } from "@buildwarden/shared";
import { buildOrchestrationTaskRead, ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS } from "./orchestration-task-read";

const task = {
  id: "task-1", orchestrationId: "o", waveId: "w", clientTaskId: "c", title: "Task", prompt: "p".repeat(10_000),
  roleId: "r", modelId: "m", intent: "inspect", status: "waiting-input", childRunId: "run", retryOfTaskId: null,
  summary: "s".repeat(50_000), errorMessage: null, attentionReason: null, adoptionStatus: "none", deferredUntil: null,
  inputTokens: 0, outputTokens: 0, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null,
} as OrchestrationTaskRecord;

const question = (index: number) => ({
  id: `q${String(index)}`, header: "h".repeat(500), question: "?".repeat(5_000),
  options: Array.from({ length: 30 }, (_, option) => ({ label: `${String(option)}${"l".repeat(1_000)}`, description: "d".repeat(1_000) })),
});

describe("task read budget", () => {
  it.each([120_000, 5_000, 700])("pages summary text without gaps at budget %i", (budget) => {
    const summary = Array.from({ length: 8_000 }, (_, index) => String(index % 10)).join("");
    const pendingQuestions = Array.from({ length: 3 }, (_, index) => ({
      inputRequestId: String(index), questions: Array.from({ length: 5 }, (_, q) => question(q)),
    }));
    for (const published of [false, true]) {
      let offset: number | null = 500;
      let received = "";
      for (let page = 0; offset !== null && page < 100; page++) {
        const { response, size } = buildOrchestrationTaskRead({
          task: { ...task, summary }, args: { summaryOffset: offset, ...(published ? { resultId: "result-1" } : {}) },
          results: published ? [{ id: "result-1", summary } as OrchestrationTaskResultRecord] : [],
          pendingQuestions, events: [], messages: { messages: [], total: 0 }, childRun: null,
          maxSummaryChars: 32_000, maxPromptChars: 4_000, maxResponseChars: budget,
        });
        const returned = (published ? response.publishedResult : response.task) as { summary: string; nextSummaryOffset: number | null };
        expect(returned.summary.length).toBeGreaterThan(0);
        expect(returned.summary).toBe(summary.slice(offset, offset + returned.summary.length));
        received += returned.summary;
        const end = offset + returned.summary.length;
        expect(returned.nextSummaryOffset ?? null).toBe(end < summary.length ? end : null);
        expect(size).toBe(JSON.stringify(response).length);
        expect(size).toBeLessThanOrEqual(budget);
        offset = returned.nextSummaryOffset ?? null;
      }
      expect(offset).toBeNull();
      expect(received).toBe(summary.slice(500));
    }
  });

  it.each([45_000, 6_000, 4_000])("pages every message without skipping under a %i character budget", (budget) => {
    const messages: OrchestrationTaskMessageRecord[] = Array.from({ length: 10 }, (_, index) => ({
      id: `message-${String(index)}`, taskId: task.id, orchestrationId: task.orchestrationId, source: "coordinator", status: "queued",
      content: "m".repeat(2_000), createdAt: "", deliveredAt: null,
    }));
    const seen: string[] = [];
    let offset: number | null = 2;
    for (let page = 0; offset !== null && page < 10; page++) {
      const { response, size } = buildOrchestrationTaskRead({
        task, args: { messagesOffset: offset }, results: [], events: [], childRun: null,
        // Force the last-resort response at the smaller budget.
        pendingQuestions: budget === 4_000 ? [{ inputRequestId: "r".repeat(100_000), questions: [question(0)] }] : [],
        messages: { messages: messages.slice(offset), total: messages.length },
        maxSummaryChars: 32_000, maxPromptChars: 4_000, maxResponseChars: budget,
      });
      const returned = response.messages as Array<{ id: string; content: string }>;
      expect(returned.length).toBeGreaterThan(0);
      if (page === 0) expect(returned).toHaveLength(budget === 45_000 ? 3 : 1);
      expect(returned.every((message) => message.content === "m".repeat(2_000))).toBe(true);
      seen.push(...returned.map((message) => message.id));
      const end = offset + returned.length;
      expect(response.nextMessagesOffset).toBe(end < messages.length ? end : null);
      expect(size).toBe(JSON.stringify(response).length);
      expect(size).toBeLessThanOrEqual(budget);
      offset = response.nextMessagesOffset as number | null;
    }
    expect(offset).toBeNull();
    expect(seen).toEqual(messages.slice(2).map((message) => message.id));
  });

  it("stays within its budget even when every pending question is at its limits", () => {
    const pendingQuestions = Array.from({ length: 8 }, (_, request) => ({
      inputRequestId: `request-${String(request)}`,
      questions: Array.from({ length: 12 }, (_, index) => question(index)),
    }));
    const { response, size } = buildOrchestrationTaskRead({
      task, args: {}, results: [], pendingQuestions, events: [], messages: { messages: [], total: 0 },
      childRun: { id: "run", status: "running", recentSteps: [], diff: "+".repeat(60_000) },
      maxSummaryChars: 32_000, maxPromptChars: 4_000,
    });

    expect(size).toBeLessThanOrEqual(ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS);
    expect(JSON.stringify(response).length).toBe(size);
    expect(response.responseTruncated).toEqual(expect.any(String));
    // The coordinator can still answer: the first request keeps its id and every option label.
    const kept = response.pendingQuestions as Array<{ inputRequestId: string; questions: Array<{ options: Array<{ label: string }> }> }>;
    expect(kept[0]?.inputRequestId).toBe("request-0");
    expect(kept[0]?.questions[0]?.options).toHaveLength(12);
  });

  it("keeps the last-resort answer bounded even with an absurd title", () => {
    const { response, size } = buildOrchestrationTaskRead({
      task: { ...task, title: "t".repeat(200_000) }, args: {}, results: [], pendingQuestions: [], events: [],
      messages: { messages: [], total: 0 }, childRun: null, maxSummaryChars: 32_000, maxPromptChars: 4_000,
    });
    expect(size).toBeLessThanOrEqual(ORCHESTRATION_TASK_READ_MAX_RESPONSE_CHARS);
    expect(((response.task as { title: string }).title).length).toBeLessThan(300);
  });

  it("falls back to a minimal, bounded answer when nothing else fits", () => {
    // A tiny budget forces every reducer and then the last-resort answer.
    const budget = 700;
    const { response, size } = buildOrchestrationTaskRead({
      task: { ...task, title: "t".repeat(200_000) }, args: {}, results: [],
      pendingQuestions: [{ inputRequestId: "request-0", questions: [question(0)] }],
      events: [], messages: { messages: [], total: 0 }, childRun: { id: "run", status: "running", recentSteps: [] },
      maxSummaryChars: 32_000, maxPromptChars: 4_000, maxResponseChars: budget,
    });
    expect(Object.keys(response).sort()).toEqual(["responseTruncated", "task"]);
    expect(response.task).toMatchObject({ id: "task-1", status: "waiting-input" });
    expect(size).toBe(JSON.stringify(response).length);
    expect(size).toBeLessThanOrEqual(budget);
  });
});
