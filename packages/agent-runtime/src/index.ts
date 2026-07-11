import { EventEmitter } from "node:events";
import type {
  HarnessAdapter,
  HarnessToolContext,
  RunEvent,
  RunEventType,
  RunExecutionRequest,
  RunRecord,
  RunStatus,
  RunTokenUsage,
} from "@buildwarden/shared";

const CANONICAL_CHUNK_TYPES = new Set<RunEventType>([
  "tool-call",
  "tool-result",
  "approval-requested",
  "approval-resolved",
  "user-input-requested",
  "plan-updated",
  "plan-progress",
  "diff-updated",
  "tool-progress",
  "request",
  "plan",
]);

const DEFAULT_CHUNK_TITLES: Readonly<Record<string, string>> = {
  message: "Agent Output",
  "tool-call": "Tool Call",
  "tool-result": "Tool Result",
  "tool-progress": "Tool Progress",
  "approval-requested": "Approval Requested",
  "approval-resolved": "Approval Resolved",
  "user-input-requested": "User Input Requested",
  request: "User Input Requested",
  "plan-updated": "Plan Updated",
  plan: "Plan Updated",
  "plan-progress": "Plan Progress",
  "diff-updated": "Diff Updated",
};

const normalizeChunkType = (type: string): RunEventType => {
  if (type === "message") {
    return "output";
  }
  if (CANONICAL_CHUNK_TYPES.has(type as RunEventType)) {
    return type as RunEventType;
  }
  return type === "error" ? "error" : "status";
};

const resolveChunkTitle = (type: string, title: string | undefined) => title ?? DEFAULT_CHUNK_TITLES[type] ?? "Run Status";

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
        await onEvent({
          type: normalizeChunkType(chunk.type),
          title: resolveChunkTitle(chunk.type, chunk.title),
          content: chunk.value,
          metadata: chunk.metadata,
        });
      },
      signal,
    );
  }
}
