import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const createDevLogger = (input: {
  logDirPath?: string;
  runId: string;
  modelId: string;
  sessionType: "run" | "chat";
}) => {
  const directory = input.logDirPath?.trim();
  const fileName = [input.sessionType, input.runId, "claude-code", input.modelId]
    .map((part) => encodeURIComponent(part).replace(/\*/g, "%2A"))
    .join("-") + ".jsonl";
  let filePath = directory ? join(directory, fileName) : null;
  try {
    if (directory) mkdirSync(directory, { recursive: true });
  } catch {
    // An unavailable diagnostics directory must not prevent the SDK from starting.
    filePath = null;
  }
  return {
    log: (event: string, data: unknown) => {
      if (!filePath) return;
      try {
        appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), event, data }) + "\n", "utf8");
      } catch {
        // Diagnostic logging must not interrupt a turn or mask its original error.
      }
    },
  };
};
