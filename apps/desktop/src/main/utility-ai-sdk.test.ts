import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUtilityTextWithAiSdk } from "@buildwarden/provider-ai-sdk";

afterEach(() => vi.unstubAllGlobals());

describe("AI SDK utility generation", () => {
  it("uses a single direct model request with supplied context and records usage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "test-response", object: "chat.completion", created: 0, model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Fix login" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateUtilityTextWithAiSdk({
      apiBaseUrl: "https://model.example.invalid/v1", apiKey: "test-key", modelId: "test-model",
      config: { providerFamily: "openai-compatible" }, systemPrompt: "Write a commit message", prompt: "Diff context",
      maxTokens: 500,
    });
    expect(result).toMatchObject({ text: "Fix login", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo, RequestInit];
    const body = JSON.parse(String(call[1].body));
    expect(body.messages).toEqual([{ role: "system", content: "Write a commit message" }, { role: "user", content: "Diff context" }]);
    expect(body).not.toHaveProperty("tools");
  });
});
