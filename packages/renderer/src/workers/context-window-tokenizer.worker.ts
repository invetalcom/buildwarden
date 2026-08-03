/// <reference lib="webworker" />

import { countTokens } from "gpt-tokenizer";
import type {
  ContextWindowTokenError,
  ContextWindowTokenRequest,
  ContextWindowTokenResponse,
} from "../lib/context-window-tokenizer-protocol";

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<ContextWindowTokenRequest>) => {
  if (event.data.type !== "count") {
    return;
  }

  const { requestId, prompt, history } = event.data;
  try {
    const response: ContextWindowTokenResponse = {
      type: "result",
      requestId,
      promptTokens: prompt.trim() ? countTokens(prompt.trim()) : 0,
      historyTokens: history.trim() ? countTokens(history.trim()) : 0,
    };
    workerScope.postMessage(response);
  } catch {
    const response: ContextWindowTokenError = { type: "error", requestId };
    workerScope.postMessage(response);
  }
});
