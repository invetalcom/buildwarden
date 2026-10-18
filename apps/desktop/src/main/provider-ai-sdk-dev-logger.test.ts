import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDevLogger } from "../../../../packages/provider-ai-sdk/src/dev-logger";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["chat", "run"] as const)("AI SDK %s dev logging", (sessionType) => {
  it.each([
    ["google/gemini-3.1-flash-image", "google%2Fgemini-3.1-flash-image"],
    ["google/gemini-3.1-flash-image:free", "google%2Fgemini-3.1-flash-image%3Afree"],
    ["vendor\\model", "vendor%5Cmodel"],
    ['model<>:"|?*\u0000', "model%3C%3E%3A%22%7C%3F%2A%00"],
    ["google%2Fgemini-3.1-flash-image", "google%252Fgemini-3.1-flash-image"],
    ["gpt-5.5", "gpt-5.5"],
  ])("writes model %s directly into the log directory", (modelId, encodedModelId) => {
    const root = mkdtempSync(join(tmpdir(), "buildwarden-ai-sdk-logs-"));
    roots.push(root);
    const logDirPath = join(root, "logs");
    const logger = createDevLogger({ logDirPath, runId: "session-1", providerType: "openrouter", modelId, sessionType });

    logger.log("session.start", { modelId });
    logger.log("session.end", { modelId });

    const files = readdirSync(logDirPath, { withFileTypes: true });
    expect(files).toHaveLength(1);
    expect(files[0].isFile()).toBe(true);
    expect(files[0].name).toBe(`${sessionType}-session-1-openrouter-${encodedModelId}.jsonl`);
    const entries = readFileSync(join(logDirPath, files[0].name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toEqual([
      { ts: expect.any(String), event: "session.start", data: { modelId } },
      { ts: expect.any(String), event: "session.end", data: { modelId } },
    ]);
  });
});
