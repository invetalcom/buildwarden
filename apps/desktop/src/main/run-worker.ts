import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  type HarnessRunChunk,
  type HarnessToolContext,
  type OrchestrationToolName,
  type RunExecutionRequest,
  type RunToolCall,
  type RunToolResult,
  type RunToolName,
  type RunUserInputAnswers,
  type RunUserInputRequest,
  type ShellApprovalDecision,
  runShellActivityStreamId,
} from "@buildwarden/shared";
import { createHarnessAdapter } from "./harness-adapters";
import { buildInitialRepoContext } from "./initial-repo-context";
import { logError, logInfo } from "./logger";
import { createRunToolContext } from "./run-tools";
import { isOrchestrationToolName } from "./orchestration-tools";

interface WorkerInput {
  request: RunExecutionRequest;
}

const port = parentPort;

if (!port) {
  throw new Error("run-worker requires a parent port.");
}

const { request } = workerData as WorkerInput;
const controller = new AbortController();
const pendingShellApprovals = new Map<string, (decision: ShellApprovalDecision) => void>();
const pendingUserInputs = new Map<string, { resolve: (answers: RunUserInputAnswers) => void; reject: (error: Error) => void }>();
const approvedShellCommands = new Set<string>();
const activeShellCommands = new Map<string, { cancel: (reason?: unknown) => void }>();
const pendingHostTools = new Map<string, {
  resolve: (result: RunToolResult) => void;
  reject: (error: Error) => void;
}>();

port.on(
  "message",
  (
    message:
      | { type: "cancel" }
      | { type: "cancel-shell"; callId: string }
      | { type: "shell-approval-response"; requestId: string; decision: ShellApprovalDecision }
      | { type: "user-input-response"; requestId: string; answers: RunUserInputAnswers }
      | { type: "host-tool-response"; callId: string; result?: RunToolResult; error?: string },
  ) => {
    if (message.type === "cancel") {
      for (const activeShell of activeShellCommands.values()) {
        activeShell.cancel("run-cancelled");
      }
      activeShellCommands.clear();
      controller.abort();
      for (const resolve of pendingShellApprovals.values()) {
        resolve("deny");
      }
      pendingShellApprovals.clear();
      for (const pending of pendingUserInputs.values()) {
        pending.reject(new Error("Run cancelled."));
      }
      pendingUserInputs.clear();
      for (const pending of pendingHostTools.values()) {
        pending.reject(new Error("Run cancelled."));
      }
      pendingHostTools.clear();
      return;
    }

    if (message.type === "cancel-shell") {
      activeShellCommands.get(message.callId)?.cancel("cancelled-by-user");
      return;
    }

    if (message.type === "shell-approval-response") {
      const resolve = pendingShellApprovals.get(message.requestId);
      if (resolve) {
        pendingShellApprovals.delete(message.requestId);
        resolve(message.decision);
      }
    }

    if (message.type === "user-input-response") {
      const pending = pendingUserInputs.get(message.requestId);
      if (pending) {
        pendingUserInputs.delete(message.requestId);
        pending.resolve(message.answers);
      }
      return;
    }

    if (message.type === "host-tool-response") {
      const pending = pendingHostTools.get(message.callId);
      if (!pending) return;
      pendingHostTools.delete(message.callId);
      if (message.result) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error || "The BuildWarden host tool failed."));
      }
    }
  },
);

const postChunk = (chunk: HarnessRunChunk) => {
  port.postMessage({
    type: "chunk",
    chunk,
  });
};

const requestShellApproval = async (command: string): Promise<ShellApprovalDecision> => {
  if (approvedShellCommands.has(command)) {
    return "allow-for-run";
  }

  const requestId = randomUUID();
  port.postMessage({
    type: "shell-approval-request",
    requestId,
    command,
  });

  const decision = await new Promise<ShellApprovalDecision>((resolve) => {
    pendingShellApprovals.set(requestId, resolve);
  });

  if (decision === "allow-for-run" || decision === "allow-always") {
    approvedShellCommands.add(command);
  }

  return decision;
};

const requestUserInput = async (request: RunUserInputRequest): Promise<RunUserInputAnswers> => {
  const requestId = request.requestId?.trim() || randomUUID();
  port.postMessage({
    type: "user-input-request",
    requestId,
    title: request.title,
    content: request.content,
    questions: request.questions,
    metadata: request.metadata,
  });

  return new Promise<RunUserInputAnswers>((resolve, reject) => {
    pendingUserInputs.set(requestId, { resolve, reject });
  });
};

const run = async () => {
  try {
    logInfo("Run worker started.", {
      runId: request.runId,
      providerType: request.providerType,
      mode: request.mode,
      worktreePath: request.worktreePath,
    });
    const harness = createHarnessAdapter(request.providerType, { requestShellApproval, requestUserInput });
    const azureLegacyToolOverride: readonly RunToolName[] | undefined =
      request.providerType === "azure-legacy"
        ? ["read_file", "write_file", "edit_file", "delete_file", "list_files", "search_repo", "run_shell"]
        : undefined;
    const runToolContext = createRunToolContext(
      request.worktreePath,
      request.mode,
      requestShellApproval,
      request.shellAllowlistExtra,
      {
        onShellStream: ({ callId, command, output }) => {
          postChunk({
            type: "tool-progress",
            title: "Tool progress: run_shell",
            value: output.trim() ? output : "(waiting for output…)",
            metadata: {
              toolName: "run_shell",
              callId,
              command,
              streamId: runShellActivityStreamId(callId),
              replace: true,
              shellStreaming: true,
            },
          });
        },
        onShellCommandStart: ({ callId, cancel }) => {
          activeShellCommands.set(callId, { cancel });
        },
        onShellCommandEnd: ({ callId }) => {
          activeShellCommands.delete(callId);
        },
        abortSignal: controller.signal,
      },
      azureLegacyToolOverride,
      { yoloMode: request.yoloMode === true },
    );
    const orchestrationTools = request.orchestrationTools ?? [];
    const orchestrationToolNames = new Set(orchestrationTools.map((tool) => tool.name));
    const toolContext: HarnessToolContext = {
      tools: [...runToolContext.tools, ...orchestrationTools],
      executeTool: async (call: RunToolCall): Promise<RunToolResult> => {
        if (!isOrchestrationToolName(call.name) || !orchestrationToolNames.has(call.name)) {
          return runToolContext.executeTool(call);
        }
        port.postMessage({
          type: "host-tool-request",
          callId: call.id,
          toolName: call.name satisfies OrchestrationToolName,
          arguments: call.arguments,
        });
        return new Promise<RunToolResult>((resolve, reject) => {
          pendingHostTools.set(call.id, { resolve, reject });
        });
      },
    };
    const result = await harness.run(
      {
        ...request,
        repoContext: request.repoContext ?? [
          request.skillContext?.trim(),
          await buildInitialRepoContext(request.worktreePath, {
            mode: request.mode,
            modelId: request.modelId,
            prompt: request.prompt,
            workspaceVcs: request.workspaceVcs,
          }),
        ]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join("\n\n"),
      },
      toolContext,
      postChunk,
      controller.signal,
    );
    port.postMessage({ type: "done", result });
  } catch (error) {
    logError("Run worker failed.", {
      runId: request.runId,
      providerType: request.providerType,
      error,
    });
    port.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown worker error",
    });
  }
};

void run();
