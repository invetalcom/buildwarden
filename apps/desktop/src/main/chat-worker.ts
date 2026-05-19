import { parentPort, workerData } from "node:worker_threads";
import type { HarnessRunChunk, HarnessToolContext, RunExecutionRequest } from "@easycode/shared";
import { createHarnessAdapter } from "./harness-adapters";
import { logError, logInfo } from "./logger";

interface ChatWorkerInput {
  request: RunExecutionRequest;
}

const port = parentPort;

if (!port) {
  throw new Error("chat-worker requires a parent port.");
}

const { request } = workerData as ChatWorkerInput;
const controller = new AbortController();

port.on("message", (message: { type: "cancel" }) => {
  if (message.type === "cancel") {
    controller.abort();
  }
});

const postChunk = (chunk: HarnessRunChunk) => {
  port.postMessage({
    type: "chunk",
    chunk,
  });
};

const emptyToolContext: HarnessToolContext = {
  tools: [],
  executeTool: async () => {
    throw new Error("Chat mode has no tools.");
  },
};

const run = async () => {
  try {
    logInfo("Chat worker started.", {
      runId: request.runId,
      providerType: request.providerType,
    });
    const harness = createHarnessAdapter(request.providerType);
    const result = await harness.run(
      {
        ...request,
        isChat: true,
      },
      emptyToolContext,
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
