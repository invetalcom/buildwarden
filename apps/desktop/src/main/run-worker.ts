import { parentPort, workerData } from "node:worker_threads";
import {
  type HarnessRunChunk,
  type RunExecutionRequest,
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

port.on(
  "message",
  (
    message:
      | { type: "cancel" }
      | { type: "cancel-shell"; callId: string }
      | { type: "shell-approval-response"; requestId: string; decision: ShellApprovalDecision }
      | { type: "user-input-response"; requestId: string; answers: RunUserInputAnswers },
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

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
  const requestId = request.requestId?.trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    const toolContext = createRunToolContext(
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
