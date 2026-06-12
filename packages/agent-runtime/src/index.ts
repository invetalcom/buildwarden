import { EventEmitter } from "node:events";
import type { HarnessAdapter, HarnessToolContext, RunEvent, RunExecutionRequest, RunRecord, RunStatus, RunTokenUsage } from "@buildwarden/shared";

export interface RuntimeRunHandle {
  run: RunRecord;
  cancel: () => Promise<void>;
}

export interface RuntimePersistence {
  setStatus(runId: string, status: RunStatus, options?: { summary?: string | null; errorMessage?: string | null }): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
}

export interface RuntimeExecutor {
  execute(
    request: RunExecutionRequest,
    harness: HarnessAdapter,
    toolContext: HarnessToolContext,
    onEvent: (event: Omit<RunEvent, "runId" | "createdAt">) => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }>;
}

export class InMemoryRunRegistry {
  private readonly emitter = new EventEmitter();
  private readonly controllers = new Map<string, AbortController>();

  set(runId: string, controller: AbortController): void {
    this.controllers.set(runId, controller);
  }

  delete(runId: string): void {
    this.controllers.delete(runId);
  }

  get(runId: string): AbortController | undefined {
    return this.controllers.get(runId);
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    this.emitter.on("run-event", listener);
    return () => this.emitter.off("run-event", listener);
  }

  emit(event: RunEvent): void {
    this.emitter.emit("run-event", event);
  }
}

export class DefaultRuntimeExecutor implements RuntimeExecutor {
  async execute(
    request: RunExecutionRequest,
    harness: HarnessAdapter,
    toolContext: HarnessToolContext,
    onEvent: (event: Omit<RunEvent, "runId" | "createdAt">) => Promise<void>,
    signal: AbortSignal,
  ): Promise<{ summary: string; responseId: string | null; usage: RunTokenUsage }> {
    return harness.run(
      request,
      toolContext,
      async (chunk) => {
        const canonicalChunkTypes = new Set([
          "tool-call",
          "tool-result",
          "approval-requested",
          "approval-resolved",
          "user-input-requested",
          "plan-updated",
          "diff-updated",
          "tool-progress",
          "request",
          "plan",
        ]);
        const type =
          chunk.type === "message"
            ? "output"
            : canonicalChunkTypes.has(chunk.type)
              ? chunk.type
              : chunk.type === "error"
                ? "error"
                : "status";
        await onEvent({
          type,
          title:
            chunk.title ??
            (chunk.type === "message"
              ? "Agent Output"
              : chunk.type === "tool-call"
                ? "Tool Call"
                : chunk.type === "tool-result"
                  ? "Tool Result"
                  : chunk.type === "tool-progress"
                    ? "Tool Progress"
                    : chunk.type === "approval-requested"
                      ? "Approval Requested"
                      : chunk.type === "approval-resolved"
                        ? "Approval Resolved"
                        : chunk.type === "user-input-requested" || chunk.type === "request"
                          ? "User Input Requested"
                          : chunk.type === "plan-updated" || chunk.type === "plan"
                            ? "Plan Updated"
                            : chunk.type === "diff-updated"
                              ? "Diff Updated"
                              : "Run Status"),
          content: chunk.value,
          metadata: chunk.metadata,
        });
      },
      signal,
    );
  }
}
