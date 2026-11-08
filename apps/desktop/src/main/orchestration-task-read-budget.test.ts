import { describe, expect, it } from "vitest";
import type { OrchestrationTaskRecord } from "@buildwarden/shared";
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
});
