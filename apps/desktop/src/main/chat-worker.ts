import { parentPort, workerData } from "node:worker_threads";
import type { HarnessRunChunk, HarnessToolContext, RunExecutionRequest, RunUserInputAnswers, RunUserInputRequest } from "@buildwarden/shared";
import { randomUUID } from "node:crypto";
import { parseUserInputQuestions, USER_INPUT_TOOL_SCHEMA } from "@buildwarden/shared";
import { createHarnessAdapter } from "./harness-adapters";
import { logError, logInfo } from "./logger";
import { createResponseImageEmbedder } from "./response-images";

interface ChatWorkerInput {
  request: RunExecutionRequest;
}

const port = parentPort;

if (!port) {
  throw new Error("chat-worker requires a parent port.");
}

const { request } = workerData as ChatWorkerInput;
const controller = new AbortController();
const embedImages = createResponseImageEmbedder(request.worktreePath);
const pendingInputs = new Map<string, { resolve: (answers: RunUserInputAnswers) => void; reject: (error: Error) => void }>();

port.on("message", (message: { type: "cancel" } | { type: "user-input-response"; requestId: string; answers: RunUserInputAnswers }) => {
  if (message.type === "cancel") {
    controller.abort();
    for (const pending of pendingInputs.values()) pending.reject(new Error("Chat cancelled."));
    pendingInputs.clear();
  } else {
    const pending = pendingInputs.get(message.requestId);
    pendingInputs.delete(message.requestId);
    pending?.resolve(message.answers);
  }
});

const requestUserInput = (request: RunUserInputRequest): Promise<RunUserInputAnswers> => {
  controller.signal.throwIfAborted();
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    pendingInputs.set(requestId, { resolve, reject });
    port.postMessage({ ...request, type: "user-input-request", requestId });
  });
};

const postChunk = (chunk: HarnessRunChunk) => {
  const value = chunk.type === "message" ? embedImages(chunk.value) : chunk.value;
  port.postMessage({
    type: "chunk",
    chunk: value === chunk.value ? chunk : { ...chunk, value, metadata: { ...chunk.metadata, responseSourceText: chunk.value } },
  });
};

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
    const harness = createHarnessAdapter(request.providerType, { requestUserInput });
    const result = await harness.run(
      {
        ...request,
        isChat: true,
      },
      chatToolContext,
      postChunk,
      controller.signal,
    );
    port.postMessage({ type: "done", result });
  } catch (error) {
    logError("Chat worker failed.", {
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
