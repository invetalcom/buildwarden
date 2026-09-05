import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderType } from "@buildwarden/shared";
import { generateUtilityText, validateUtilityText } from "./utility-text-generation";

const adapters = vi.hoisted(() => ({
  codex: vi.fn(), claude: vi.fn(), cursor: vi.fn(), azure: vi.fn(), ai: vi.fn(),
}));
vi.mock("@buildwarden/provider-codex-cli", () => ({ generateUtilityTextWithCodexCli: adapters.codex }));
vi.mock("@buildwarden/provider-claude-code", () => ({ generateUtilityTextWithClaudeCode: adapters.claude }));
vi.mock("@buildwarden/provider-cursor-agent", () => ({ generateUtilityTextWithCursorAgent: adapters.cursor }));
vi.mock("@buildwarden/provider-azure-legacy", () => ({ generateUtilityTextWithAzureLegacy: adapters.azure }));
vi.mock("@buildwarden/provider-ai-sdk", () => ({ generateUtilityTextWithAiSdk: adapters.ai }));
afterEach(() => vi.resetAllMocks());

describe("standalone text generation", () => {
  it.each([
    ["codex-cli", "codex"], ["claude-code", "claude"], ["cursor-agent", "cursor"],
    ["azure-legacy", "azure"], ["ai-sdk", "ai"], ["openrouter", "ai"],
  ] as const)("routes %s to its utility adapter and retains usage", async (providerType: ProviderType, adapter) => {
    const output = { text: "fix/login", usage: { inputTokens: 35, outputTokens: 4 } };
    adapters[adapter].mockResolvedValue(output);
    expect(await generateUtilityText({
      purpose: "branch-name", cwd: "repo", providerType, modelId: "configured-model", apiKey: "test-key",
      apiBaseUrl: "https://example.invalid/deployment", config: { apiVersion: "2024-06-01" },
      prompt: "Fix login", systemPrompt: "Generate a branch name", maxTokens: 80, temperature: 0.2,
    })).toEqual(output);
    expect(adapters[adapter]).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "configured-model", config: { apiVersion: "2024-06-01" },
      timeoutMs: 180_000, outputSchema: undefined,
    }));
    expect(Object.values(adapters).filter((mock) => mock.mock.calls.length)).toHaveLength(1);
  });

  it("gives PR generators the expected schema without putting it in branch requests", async () => {
    adapters.codex.mockResolvedValue({ text: "{}", usage: { inputTokens: 1, outputTokens: 1 } });
    await generateUtilityText({
      purpose: "pull-request-draft", cwd: "repo", providerType: "codex-cli", modelId: "configured-model",
      apiKey: "", prompt: "Diff", systemPrompt: "Draft a PR", maxTokens: 1300, temperature: 0.2,
    });
    expect(adapters.codex).toHaveBeenCalledWith(expect.objectContaining({
      outputSchema: expect.objectContaining({ required: ["title", "description", "commitMessage"], additionalProperties: false }),
      prompt: expect.stringContaining("Do not execute commands"),
    }));
  });

  it("validates JSON locally even for providers without schema support", () => {
    const draft = { title: "Fix login", description: "## Summary\nFix login", commitMessage: null };
    expect(validateUtilityText(`\x60\x60\x60json\n${JSON.stringify(draft)}\n\x60\x60\x60`, "pull-request-draft")).toBe(JSON.stringify(draft));
    expect(validateUtilityText(JSON.stringify({ title: draft.title, description: draft.description }), "pull-request-draft")).toBe(JSON.stringify(draft));
    for (const invalid of [[], {}, { ...draft, title: " " }, { ...draft, commitMessage: 4 }, { ...draft, unwanted: true }]) {
      expect(() => validateUtilityText(JSON.stringify(invalid), "pull-request-draft")).toThrow();
    }
    expect(() => validateUtilityText("not JSON", "pull-request-draft")).toThrow();
    expect(() => validateUtilityText(" ", "commit-message")).toThrow("empty");
  });
});
