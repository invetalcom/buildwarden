import { afterEach, expect, it, vi } from "vitest";
import { AiSdkHarnessAdapter, supportsOptionalChatTools } from "@buildwarden/provider-ai-sdk";
import type { RunExecutionRequest } from "@buildwarden/shared";

afterEach(() => vi.unstubAllGlobals());

it("honors discovered capability metadata and leaves unknown custom/routed models tool-free", () => {
  for (const providerType of ["ai-sdk", "openrouter"] as const) {
    const base = { providerType, config: { providerFamily: "openai-compatible" } };
    expect(supportsOptionalChatTools(base)).toBe(false);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true } })).toBe(true);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true }, modelConfig: { supportsTools: false } })).toBe(false);
  }
  expect(supportsOptionalChatTools({ providerType: "ai-sdk", config: { providerFamily: "openai" }, modelCapabilities: { supportsTools: false } })).toBe(false);
});

it.each([false, true])("sends optional tools only when the chat model supports them (%s)", async (supportsTools) => {
  const fetchMock = vi.fn(async () => new Response([
    'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
    'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]', "",
  ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetchMock);
  const input: RunExecutionRequest = { runId: "chat", worktreePath: ".", mode: "ask", prompt: "Hi", providerType: "ai-sdk", modelId: "test", apiKey: "test", apiBaseUrl: "https://model.example.invalid/v1", config: { providerFamily: "openai-compatible" }, isChat: true, modelCapabilities: { supportsTools } };
  const adapter = new AiSdkHarnessAdapter(async () => ({}));
  const result = await adapter.run(input, { tools: [], executeTool: vi.fn() }, vi.fn(), new AbortController().signal);
  expect(result.summary).toBe("Hello");
  const call = fetchMock.mock.calls[0] as unknown as [RequestInfo, RequestInit];
  const body = JSON.parse(String(call[1].body));
  if (supportsTools) expect(body.tools[0].function.name).toBe("request_user_input");
  else expect(body).not.toHaveProperty("tools");
});
