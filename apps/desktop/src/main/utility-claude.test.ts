import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUtilityTextWithClaudeCode } from "@buildwarden/provider-claude-code";

const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("../../../../packages/provider-claude-code/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", () => ({
  query: sdk.query, createSdkMcpServer: vi.fn(), tool: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const respondWith = (event: Record<string, unknown>) => {
  sdk.query.mockReturnValue({
    close: sdk.close,
    async *[Symbol.asyncIterator]() { yield event; },
  });
};

describe("Claude utility generation", () => {
  it("uses a disposable SDK session without tools and reads structured output and usage", async () => {
    respondWith({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { title: "Fix login" }, usage: { input_tokens: 12, output_tokens: 3 } });
    const result = await generateUtilityTextWithClaudeCode({
      cwd: "repo", prompt: "Write a title", modelId: "sonnet", outputSchema: { type: "object" },
      config: { claudeLaunchArgs: "--resume existing-session --dangerously-skip-permissions" },
    });
    expect(result.text).toBe('{"title":"Fix login"}');
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
      persistSession: false, tools: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "dontAsk",
      outputFormat: { type: "json_schema", schema: { type: "object" } },
    }) }));
    expect(sdk.query.mock.calls[0]?.[0].options).not.toHaveProperty("resume");
    expect(sdk.query.mock.calls[0]?.[0].options.extraArgs).toEqual({});
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it("rejects a provider error instead of treating it as generated text", async () => {
    respondWith({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["generation failed"] });
    await expect(generateUtilityTextWithClaudeCode({ cwd: "repo", prompt: "Write text", modelId: "sonnet" })).rejects.toThrow("generation failed");
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});
