import { flushCompileCacheSafely } from "./compile-cache";
import { parentPort, workerData } from "node:worker_threads";
import type { HarnessRunChunk, HarnessToolContext, RunExecutionRequest, RunUserInputAnswers, RunUserInputRequest } from "@buildwarden/shared";
import { randomUUID } from "node:crypto";
import { parseUserInputQuestions, USER_INPUT_TOOL_SCHEMA } from "@buildwarden/shared";
import { createHarnessAdapter } from "./harness-adapters";
import { logError, logInfo } from "./logger";
import { createResponseImageEmbedder } from "./response-images";
import { createResponseChunkStream } from "./response-chunk-stream";
import { prepareChatWorkspaceSession } from "./chat-session-migration";

interface ChatWorkerInput {
  request: RunExecutionRequest;
  acknowledgeChunks?: boolean;
}

const port = parentPort;

if (!port) {
  throw new Error("chat-worker requires a parent port.");
}

const { request, acknowledgeChunks } = workerData as ChatWorkerInput;
const controller = new AbortController();
const chunks = createResponseChunkStream(createResponseImageEmbedder(request.worktreePath), (chunk, deliveryId) => {
  port.postMessage({ type: "chunk", chunk, deliveryId });
  // A development rebuild can start a new worker from an older, still-open host.
  if (!acknowledgeChunks) queueMicrotask(() => chunks.acknowledge(deliveryId));
});
const pendingInputs = new Map<string, { resolve: (answers: RunUserInputAnswers) => void; reject: (error: Error) => void }>();

port.on("message", (message: { type: "chunk-ack"; deliveryId: number } | { type: "cancel" } | { type: "user-input-response"; requestId: string; answers: RunUserInputAnswers }) => {
  if (message.type === "chunk-ack") {
    chunks.acknowledge(message.deliveryId);
  } else if (message.type === "cancel") {
    controller.abort();
    for (const pending of pendingInputs.values()) pending.reject(new Error("Chat cancelled."));
    pendingInputs.clear();
  } else {
    const pending = pendingInputs.get(message.requestId);
    pendingInputs.delete(message.requestId);
    pending?.resolve(message.answers);
  }
});

const requestUserInput = async (request: RunUserInputRequest): Promise<RunUserInputAnswers> => {
  await chunks.drain();
  controller.signal.throwIfAborted();
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingInputs.set(requestId, { resolve, reject });
    port.postMessage({ ...request, type: "user-input-request", requestId });
  });
};

const postChunk = (chunk: HarnessRunChunk) => chunks.post(chunk);

const chatToolContext: HarnessToolContext = {
  tools: [{ name: "buildwarden_ask_user", description: "Ask one to three questions with clickable choices or free text, and wait for the user's answers.", inputSchema: USER_INPUT_TOOL_SCHEMA }],
  executeTool: async (call) => {
    if (call.name !== "buildwarden_ask_user") throw new Error("This tool is not available in chat.");
    const questions = parseUserInputQuestions(call.arguments.questions);
    const answers = await requestUserInput({ questions, title: "Question" });
    return { toolCallId: call.id, name: call.name, ok: true, content: JSON.stringify({ answers }) };
  },
};

const run = async () => {
  try {
    logInfo("Chat worker started.", {
      runId: request.runId,
      providerType: request.providerType,
    });
    const harness = await createHarnessAdapter(request.providerType, { requestUserInput });
    flushCompileCacheSafely();
    controller.signal.throwIfAborted();
    const result = await harness.run(
      {
        ...prepareChatWorkspaceSession(request),
        isChat: true,
      },
      chatToolContext,
      postChunk,
      controller.signal,
    );
    await chunks.drain();
    flushCompileCacheSafely();
    port.postMessage({ type: "done", result });
  } catch (error) {
    await chunks.drain();
    logError("Chat worker failed.", {
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
