import { flushCompileCacheSafely } from "./compile-cache";
import { runWorkspaceSetup } from "./workspace-setup";
import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  type ChatAttachmentPayload,
  type HarnessAdapter,
  type HarnessRunChunk,
  type HarnessToolContext,
  type RunExecutionRequest,
  type RunToolCall,
  type RunToolResult,
  type RunToolName,
  type RunUserInputAnswers,
  type RunUserInputRequest,
  type ShellApprovalDecision,
  isSteerOutcomeUnknownError,
  getHarnessCapabilities,
  runShellActivityStreamId,
} from "@buildwarden/shared";
import { createHarnessAdapter } from "./harness-adapters";
import { createResponseImageEmbedder } from "./response-images";
import { createResponseChunkStream } from "./response-chunk-stream";
import { buildInitialRepoContext } from "./initial-repo-context";
import { logError, logInfo } from "./logger";
import { PendingHostToolRequests } from "./pending-host-tool-requests";
import { createRunToolContext } from "./run-tools";
import { buildOrchestrationAwarePrompt, ORCHESTRATION_COORDINATOR_PROMPT } from "./orchestration-tools";
import { BROWSER_TOOL, BROWSER_PROMPT } from "./browser-tools";
import { createSkillRuntime, SKILL_TOOL_NAMES } from "./skill-runtime";
import { bridgeProjectMcpServers } from "./bridged-mcp-tools";

interface WorkerInput {
  request: RunExecutionRequest;
  acknowledgeChunks?: boolean;
}

const port = parentPort;

if (!port) {
  throw new Error("run-worker requires a parent port.");
}

const { request, acknowledgeChunks } = workerData as WorkerInput;
const controller = new AbortController();
const chunks = createResponseChunkStream(createResponseImageEmbedder(request.worktreePath), (chunk, deliveryId) => {
  port.postMessage({ type: "chunk", chunk, deliveryId });
  // A development rebuild can start a new worker from an older, still-open host.
  if (!acknowledgeChunks) queueMicrotask(() => chunks.acknowledge(deliveryId));
});
const pendingShellApprovals = new Map<string, (decision: ShellApprovalDecision) => void>();
const pendingUserInputs = new Map<string, { resolve: (answers: RunUserInputAnswers) => void; reject: (error: Error) => void }>();
const approvedShellCommands = new Set<string>();
const activeShellCommands = new Map<string, { cancel: (reason?: unknown) => void }>();
const pendingHostTools = new PendingHostToolRequests<RunToolResult>();
let activeHarness: HarnessAdapter | null = null;

const steerActiveTurn = (requestId: string, prompt: string, attachments: ChatAttachmentPayload[] | undefined) => {
  const steer = activeHarness?.steer?.bind(activeHarness);
  const pending = steer
    ? steer({ prompt, ...(attachments?.length ? { attachments } : {}) })
    : Promise.reject(new Error("This provider cannot take messages during a turn."));
  void pending.then(
    () => port.postMessage({ type: "steer-result", requestId }),
    (error: unknown) => port.postMessage({
      type: "steer-result",
      requestId,
      error: error instanceof Error ? error.message : "The running turn could not take the message.",
      outcomeUnknown: isSteerOutcomeUnknownError(error),
    }),
  );
};

port.on(
  "message",
  (
    message:
      | { type: "chunk-ack"; deliveryId: number }
      | { type: "cancel" }
      | { type: "cancel-shell"; callId: string }
      | { type: "shell-approval-response"; requestId: string; decision: ShellApprovalDecision }
      | { type: "user-input-response"; requestId: string; answers: RunUserInputAnswers }
      | { type: "host-tool-response"; callId: string; result?: RunToolResult; error?: string }
      | { type: "steer"; requestId: string; prompt: string; attachments?: ChatAttachmentPayload[] },
  ) => {
    if (message.type === "chunk-ack") {
      chunks.acknowledge(message.deliveryId);
      return;
    }
    if (message.type === "steer") {
      steerActiveTurn(message.requestId, message.prompt, message.attachments);
      return;
    }
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
      pendingHostTools.rejectAll(new Error("Run cancelled."));
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
      if (message.result) {
        pendingHostTools.resolve(message.callId, message.result);
      } else {
        pendingHostTools.reject(message.callId, new Error(message.error || "The BuildWarden host tool failed."));
      }
    }
  },
);

const postChunk = (chunk: HarnessRunChunk) => chunks.post(chunk);

const requestShellApproval = async (command: string, options?: { approvalKey?: string }): Promise<ShellApprovalDecision> => {
  // A tool approval is remembered by its identity, never by the text shown to the user.
  const memoryKey = options?.approvalKey ?? command;
  if (approvedShellCommands.has(memoryKey)) {
    return "allow-for-run";
  }

  await chunks.drain();
  controller.signal.throwIfAborted();
  const requestId = randomUUID();
  port.postMessage({
    type: "shell-approval-request",
    requestId,
    command,
    ...(options?.approvalKey ? { approvalKey: options.approvalKey } : {}),
  });

  const decision = await new Promise<ShellApprovalDecision>((resolve) => {
    pendingShellApprovals.set(requestId, resolve);
  });

  if (decision === "allow-for-run" || decision === "allow-always") {
    approvedShellCommands.add(memoryKey);
  }

  return decision;
};

const requestUserInput = async (request: RunUserInputRequest): Promise<RunUserInputAnswers> => {
  await chunks.drain();
  controller.signal.throwIfAborted();
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
    if (request.workspaceSetup) {
      await runWorkspaceSetup({ ...request.workspaceSetup, workspacePath: request.worktreePath,
        git: request.workspaceVcs !== "folder", signal: controller.signal, onChunk: postChunk });
    }
    controller.signal.throwIfAborted();
    const harness = await createHarnessAdapter(request.providerType, { requestShellApproval, requestUserInput });
    activeHarness = harness;
    flushCompileCacheSafely();
    controller.signal.throwIfAborted();
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
    const skillRuntime = await createSkillRuntime(request.skills, postChunk);
    const orchestrationTools = request.orchestrationTools ?? [];
    const hostTools = [...orchestrationTools, ...(request.browserToolsEnabled ? [BROWSER_TOOL] : [])];
    const hostToolNames = new Set(hostTools.map((tool) => tool.name));
    const toolContext: HarnessToolContext = {
      tools: [...runToolContext.tools, ...hostTools, ...skillRuntime.tools.tools],
      executeTool: async (call: RunToolCall): Promise<RunToolResult> => {
        if (SKILL_TOOL_NAMES.some((name) => name === call.name)) return skillRuntime.tools.executeTool(call);
        if (!hostToolNames.has(call.name)) {
          return runToolContext.executeTool(call);
        }
        await chunks.drain();
        controller.signal.throwIfAborted();
        const response = pendingHostTools.create(call.id);
        port.postMessage({
          type: "host-tool-request",
          callId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        });
        return response;
      },
    };
    // Everything that can fail runs before the MCP bridge opens, and the bridge always closes.
    const prompt = buildOrchestrationAwarePrompt(request.prompt, orchestrationTools.length > 0 && getHarnessCapabilities(request.providerType).instructionChannel === "prompt", request.isOrchestrationUpdate === true);
    const repoContext = [skillRuntime.context, request.browserToolsEnabled ? BROWSER_PROMPT : "", request.repoContext ?? [
      request.skillContext?.trim(),
      await buildInitialRepoContext(request.worktreePath, {
        mode: request.mode,
        modelId: request.modelId,
        prompt: request.prompt,
        workspaceVcs: request.workspaceVcs,
      }),
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n\n")].filter(Boolean).join("\n\n");
    const bridgedMcp = getHarnessCapabilities(request.providerType).projectMcp === "bridged" && request.mcpServers?.length
      ? await bridgeProjectMcpServers(request.mcpServers, toolContext, {
        mode: request.mode,
        yoloMode: request.yoloMode === true,
        requestApproval: requestShellApproval,
        alwaysAllowed: request.toolApprovalAllowlist ?? [],
        onChunk: postChunk,
        signal: controller.signal,
      })
      : null;
    let result: Awaited<ReturnType<typeof harness.run>>;
    try {
      result = await harness.run(
        {
          ...request,
          prompt,
          instructions: orchestrationTools.length > 0 ? ORCHESTRATION_COORDINATOR_PROMPT : undefined,
          repoContext,
        },
        bridgedMcp?.toolContext ?? toolContext,
        postChunk,
        controller.signal,
      );
    } finally {
      await bridgedMcp?.close();
    }
    await chunks.drain();
    flushCompileCacheSafely();
    port.postMessage({ type: "done", result });
  } catch (error) {
    await chunks.drain();
    logError("Run worker failed.", {
      runId: request.runId,
      providerType: request.providerType,
      error,
    });
    flushCompileCacheSafely();
    port.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown worker error",
    });
  }
};

void run();
