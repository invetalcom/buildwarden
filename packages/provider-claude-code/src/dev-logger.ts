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
  if (directory) mkdirSync(directory, { recursive: true });
  const filePath = directory ? join(directory, fileName) : null;
  return {
    log: (event: string, data: unknown) => {
      if (!filePath) return;
      appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), event, data }) + "\n", "utf8");
    },
  };
};
