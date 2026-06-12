import type { RendererLogPayload } from "@buildwarden/shared";

const toMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
};

const toStack = (error: unknown) => {
  return error instanceof Error ? error.stack : undefined;
};

export const reportRendererLog = (payload: RendererLogPayload) => {
  void window.buildwarden?.reportRendererLog(payload).catch(() => {
    // Avoid recursive renderer logging failures.
  });
};

export const reportRendererError = (source: string, error: unknown, metadata?: Record<string, unknown>) => {
  reportRendererLog({
    level: "error",
    source,
    message: toMessage(error, "Unknown renderer error"),
    stack: toStack(error),
    metadata,
  });
};

export const reportRendererWarning = (source: string, warning: unknown, metadata?: Record<string, unknown>) => {
  reportRendererLog({
    level: "warn",
    source,
    message: toMessage(warning, "Unknown renderer warning"),
    stack: toStack(warning),
    metadata,
  });
};
