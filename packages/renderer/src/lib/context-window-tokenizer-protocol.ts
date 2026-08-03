export interface ContextWindowTokenRequest {
  type: "count";
  requestId: number;
  prompt: string;
  history: string;
}

export interface ContextWindowTokenResponse {
  type: "result";
  requestId: number;
  promptTokens: number;
  historyTokens: number;
}

export interface ContextWindowTokenError {
  type: "error";
  requestId: number;
}

export type ContextWindowTokenWorkerMessage = ContextWindowTokenResponse | ContextWindowTokenError;
