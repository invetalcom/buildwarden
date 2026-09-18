import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateUtilityTextWithCodexCli } from "@buildwarden/provider-codex-cli";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), run: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), rm: mocks.remove,
}));
vi.mock("@buildwarden/agent-runtime", () => ({
  resolveTextGenerationProcessLaunch: (command: string, args: string[]) => ({ command, args }),
  runTextGenerationProcess: mocks.run,
}));

beforeEach(() => {
  mocks.remove.mockRejectedValue(new Error("EPERM: schema is still locked"));
});
afterEach(() => {
  for (const [directory] of mocks.remove.mock.calls as [string][]) {
    const ownedPath = relative(tmpdir(), directory);
    if (isAbsolute(ownedPath) || !/^buildwarden-codex-schema-[^/\\]+$/.test(ownedPath)) {
      throw new Error("Unsafe fixture cleanup path.");
    }
    rmSync(directory, { recursive: true, force: true });
  }
  vi.resetAllMocks();
});

describe("Codex schema cleanup failures", () => {
  const input = { cwd: process.cwd(), modelId: "test-model", prompt: "Write text", outputSchema: { type: "object" } };

  it("preserves a successful generation when removing its schema fails", async () => {
    mocks.run.mockResolvedValue([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fix login" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
    ].join("\n"));
    await expect(generateUtilityTextWithCodexCli(input)).resolves.toMatchObject({ text: "Fix login" });
    expect(mocks.remove).toHaveBeenCalledWith(expect.any(String), {
      recursive: true, force: true, maxRetries: 3, retryDelay: 100,
    });
  });

  it("preserves the original generation error when removing its schema fails", async () => {
    const error = new Error("Text generation timed out.");
    mocks.run.mockRejectedValue(error);
    await expect(generateUtilityTextWithCodexCli(input)).rejects.toBe(error);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });
});
