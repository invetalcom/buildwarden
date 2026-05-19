import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type DevLoggerInput = {
  logDirPath?: string;
  runId: string;
  providerType: string;
  modelId: string;
  sessionType: "run" | "chat";
};

const toJsonLine = (event: string, data: unknown) =>
  JSON.stringify({
    ts: new Date().toISOString(),
    event,
    data,
  }) + "\n";

export const createDevLogger = ({ logDirPath, runId, providerType, modelId, sessionType }: DevLoggerInput) => {
  const enabled = Boolean(logDirPath?.trim());
  const filePath = enabled ? join(logDirPath!.trim(), `${sessionType}-${runId}-${providerType}-${modelId}.jsonl`) : "";

  if (enabled) {
    mkdirSync(logDirPath!.trim(), { recursive: true });
  }

  return {
    enabled,
    log: (event: string, data: unknown) => {
      if (!enabled) {
        return;
      }
      appendFileSync(filePath, toJsonLine(event, data), "utf8");
    },
  };
};
