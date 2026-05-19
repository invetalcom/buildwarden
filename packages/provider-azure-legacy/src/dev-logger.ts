import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type DevLoggerInput = {
  logDirPath?: string;
  runId: string;
  providerType: string;
  modelId: string;
  sessionType: "run" | "chat";
};

const MAX_LOG_BODY_CHARS = 200_000;

const truncateForLog = (value: string) =>
  value.length > MAX_LOG_BODY_CHARS ? `${value.slice(0, MAX_LOG_BODY_CHARS)}\n... truncated ...` : value;

const toJsonLine = (event: string, data: unknown) =>
  JSON.stringify({
    ts: new Date().toISOString(),
    event,
    data,
  }) + "\n";

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const headersToObject = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) {
    return {};
  }
  return Object.fromEntries(new Headers(headers).entries());
};

const bodyToString = (body: BodyInit | null | undefined): string | undefined => {
  if (typeof body === "string") {
    return truncateForLog(body);
  }
  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }
  if (body instanceof Blob) {
    return `[blob ${body.type || "application/octet-stream"} ${String(body.size)} bytes]`;
  }
  if (body instanceof ArrayBuffer) {
    return `[arrayBuffer ${String(body.byteLength)} bytes]`;
  }
  if (ArrayBuffer.isView(body)) {
    return `[typedArray ${String(body.byteLength)} bytes]`;
  }
  if (body instanceof FormData) {
    return "[formData]";
  }
  return undefined;
};

export const createDevLogger = ({ logDirPath, runId, providerType, modelId, sessionType }: DevLoggerInput) => {
  const enabled = Boolean(logDirPath?.trim());
  const filePath = enabled ? join(logDirPath!.trim(), `${sessionType}-${runId}-${providerType}-${modelId}.jsonl`) : "";

  if (enabled) {
    mkdirSync(logDirPath!.trim(), { recursive: true });
  }

  const log = (event: string, data: unknown) => {
    if (!enabled) {
      return;
    }
    appendFileSync(filePath, toJsonLine(event, data), "utf8");
  };

  return {
    enabled,
    log,
    createLoggedFetch: (baseFetch: typeof fetch = fetch): typeof fetch => {
      if (!enabled) {
        return baseFetch;
      }
      return async (input, init) => {
        const url = getRequestUrl(input);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const requestHeaders = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const requestBody =
          bodyToString(init?.body) ?? (input instanceof Request && !input.bodyUsed ? truncateForLog(await input.clone().text()) : undefined);

        log("http.request", {
          url,
          method,
          headers: requestHeaders,
          ...(requestBody !== undefined ? { body: requestBody } : {}),
        });

        const startedAt = Date.now();
        try {
          const response = await baseFetch(input, init);
          const responseHeaders = headersToObject(response.headers);
          void response
            .clone()
            .text()
            .then((body) => {
              log("http.response", {
                url,
                method,
                status: response.status,
                headers: responseHeaders,
                body: truncateForLog(body),
                durationMs: Date.now() - startedAt,
              });
            })
            .catch((error) => {
              log("http.response", {
                url,
                method,
                status: response.status,
                headers: responseHeaders,
                body: `[unavailable: ${error instanceof Error ? error.message : String(error)}]`,
                durationMs: Date.now() - startedAt,
              });
            });
          return response;
        } catch (error) {
          log("http.error", {
            url,
            method,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      };
    },
  };
};
