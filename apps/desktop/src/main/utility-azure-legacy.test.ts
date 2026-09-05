import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUtilityTextWithAzureLegacy } from "@buildwarden/provider-azure-legacy";

afterEach(() => vi.unstubAllGlobals());

const input = {
  apiBaseUrl: "https://azure.example.invalid/openai/deployments/custom/",
  apiKey: "test-key", config: { azureApiVersion: "2024-02-15-preview" }, modelId: "custom-deployment",
  systemPrompt: "Write a commit message", prompt: "The supplied diff", maxTokens: 500, temperature: 0.3,
};
const completion = (content: string | null, finishReason = "stop") => ({
  id: "completion", object: "chat.completion", created: 0, model: "custom-deployment",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
});

describe("Azure Legacy utility generation", () => {
  it("keeps legacy endpoints, headers and API versions and sends no tool or schema fields", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(completion("Fix login")), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateUtilityTextWithAzureLegacy({ ...input, outputSchema: { type: "object" } });
    expect(result).toEqual({ text: "Fix login", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, totalTokens: 120 } });
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo, RequestInit];
    expect(String(call[0])).toBe(`${input.apiBaseUrl}chat/completions?api-version=2024-02-15-preview`);
    const headers = new Headers(call[1].headers);
    expect(headers.get("api-key")).toBe("test-key");
    expect(headers.get("authorization")).toBeNull();
    const body = JSON.parse(String(call[1].body));
    expect(body).toEqual({
      model: input.modelId,
      messages: [{ role: "system", content: input.systemPrompt }, { role: "user", content: input.prompt }],
      max_completion_tokens: 500, temperature: 0.3,
    });
  });

  it("reserves completion tokens for reasoning and omits unsupported temperature", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(completion("Fix login")), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await generateUtilityTextWithAzureLegacy({ ...input, modelId: "gpt-5" });
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body.max_completion_tokens).toBe(24_000);
    expect(body).not.toHaveProperty("temperature");
  });

  it.each([["partial text", "length"], [null, "stop"], [null, "content_filter"]])("rejects unusable output (%s/%s)", async (content, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(completion(content, reason ?? "stop")), { headers: { "content-type": "application/json" } })));
    await expect(generateUtilityTextWithAzureLegacy(input)).rejects.toThrow();
  });

  it("honors cancellation before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateUtilityTextWithAzureLegacy({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
