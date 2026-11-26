import { Worker } from "node:worker_threads";
import type {
  OrchestrationToolName,
  ProviderSessionRuntimeInput,
  ProviderType,
  RunTokenUsage,
  RunUserInputQuestion,
  ThemeToolName,
  VISUAL_REPLY_TOOL_NAME,
} from "@buildwarden/shared";
import type { RunBudgetExhaustion } from "../run-autonomy-budget";
import { EMPTY_REPORTED_TOKEN_USAGE, startsFreshUsageBaseline, type UsageReportTracker } from "../token-usage-accounting";
import type { WorkerProcessSpawnedMessage } from "../worker-process-reporting";

export interface ActiveWorker {
  worker: Worker;
  cancelled: boolean;
  verificationAbortController?: AbortController;
  budgetExhaustion?: RunBudgetExhaustion;
  /** The prompt of this run-chat turn holds the latest run context. */
  carriesRunContext?: boolean;
  /** Lets provider CLI updates wait until no run or chat uses the CLI. */
  providerType?: ProviderType;
}

/** Reports when workers start or stop so provider CLI update status reflects which CLIs are busy. */
export class ActiveWorkerMap extends Map<string, ActiveWorker> {
  constructor(private readonly onMembershipChange: () => void) {
    super();
  }

  override set(key: string, value: ActiveWorker): this {
    const added = !this.has(key);
    super.set(key, value);
    if (added) this.onMembershipChange();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.onMembershipChange();
    return removed;
  }
}

export const resetUsageBaselineForFreshSession = (tracker: UsageReportTracker, metadata: Record<string, unknown> | undefined): void => {
  if (startsFreshUsageBaseline(metadata)) tracker.reportedUsage = { ...EMPTY_REPORTED_TOKEN_USAGE };
};

export type WorkerDoneResult = {
  summary: string;
  responseId: string | null;
  usage: RunTokenUsage;
  providerSessionRuntime?: Omit<
    ProviderSessionRuntimeInput,
    "ownerId" | "ownerKind" | "providerType" | "harnessType" | "status"
  > & {
    status?: ProviderSessionRuntimeInput["status"];
  };
};

export type ChatWorkerChunkPayload = {
  type: "chunk";
  deliveryId?: number;
  chunk: { type: string; value: string; title?: string; metadata?: Record<string, unknown> };
};

export type WorkerSteerResultPayload = { type: "steer-result"; requestId: string; error?: string; outcomeUnknown?: boolean };

export type ChatWorkerPayload =
  | ChatWorkerChunkPayload
  | Extract<RunWorkerPayload, { type: "user-input-request" }>
  | WorkerSteerResultPayload
  | WorkerProcessSpawnedMessage
  | { type: "done"; result: WorkerDoneResult }
  | { type: "error"; error: string };

export type RunWorkerPayload =
  | { type: "chunk"; deliveryId?: number; chunk: { type: string; value: string; title?: string; metadata?: Record<string, unknown> } }
  | { type: "done"; result: WorkerDoneResult }
  | { type: "shell-approval-request"; requestId: string; command: string; approvalKey?: string; onceOnly?: boolean }
  | {
      type: "user-input-request";
      requestId: string;
      title?: string;
      content?: string;
      questions?: RunUserInputQuestion[];
      metadata?: Record<string, unknown>;
    }
  | {
      type: "host-tool-request";
      callId: string;
      toolName: OrchestrationToolName | ThemeToolName | "buildwarden_browser" | typeof VISUAL_REPLY_TOOL_NAME;
      arguments: Record<string, unknown>;
    }
  | WorkerSteerResultPayload
  | WorkerProcessSpawnedMessage
  | { type: "error"; error: string };
