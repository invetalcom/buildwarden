import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSdkHarnessAdapter } from "@buildwarden/provider-ai-sdk";
import type { HarnessRunChunk, HarnessToolContext, RunExecutionRequest } from "@buildwarden/shared";

afterEach(() => { vi.unstubAllGlobals(); });

const completion = (parts: string[], round: number, toolCall: boolean) => {
  const frame = (delta: Record<string, unknown>, finishReason: string | null = null) => `data: ${JSON.stringify({
    id: `response-${round}`, object: "chat.completion.chunk", created: 0, model: "test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}`;
  const frames = parts.map((content) => frame({ content }));
  if (toolCall) frames.push(frame({ tool_calls: [{ index: 0, id: `call-${round}`, type: "function",
    function: { name: "read_file", arguments: '{"path":"file.ts"}' } }] }));
  frames.push(frame({}, toolCall ? "tool_calls" : "stop"), "data: [DONE]", "");
  return new Response(frames.join("\n\n"), { headers: { "content-type": "text/event-stream" } });
};

describe.each(["ai-sdk", "openrouter"] as const)("%s assistant output segments", (providerType) => {
  it.each([false, true])("keeps a single response intact (chat: %s)", async (isChat) => {
    vi.stubGlobal("fetch", vi.fn(async () => completion(["Hello ", "world."], 1, false)));
    const chunks: HarnessRunChunk[] = [];
    const result = await new AiSdkHarnessAdapter().run({
      runId: "single-response", worktreePath: process.cwd(), mode: "ask", prompt: "Hi", isChat,
      providerType, modelId: "test", apiKey: "test", apiBaseUrl: "https://model.example.invalid/v1",
      config: { providerFamily: "openai-compatible" },
    }, { tools: [], executeTool: vi.fn() }, (chunk) => { chunks.push(chunk); }, new AbortController().signal);
    const output = chunks.filter((chunk) => chunk.type === "message" && chunk.title === "Agent output");
    expect(output.map((chunk) => chunk.value)).toEqual(["Hello ", "Hello world."]);
    expect(new Set(output.map((chunk) => chunk.metadata?.streamId)).size).toBe(1);
    expect(result.summary).toBe("Hello world.");
  });

  it("replaces text within a message without repeating earlier tool rounds", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => completion(["Inspect ", "files."], 1, true))
      .mockImplementationOnce(async () => completion(["Check ", "changes."], 2, true))
      .mockImplementationOnce(async () => completion(["All ", "done."], 3, false));
    vi.stubGlobal("fetch", fetchMock);
    const input: RunExecutionRequest = {
      runId: "stream-test", worktreePath: process.cwd(), mode: "code", prompt: "Inspect the files",
      providerType, modelId: "test", apiKey: "test", apiBaseUrl: "https://model.example.invalid/v1",
      config: { providerFamily: "openai-compatible" },
    };
    const executeTool: HarnessToolContext["executeTool"] = vi.fn(async (call) => ({
      toolCallId: call.id, name: call.name, ok: true, content: "File contents",
    }));
    const chunks: HarnessRunChunk[] = [];
    const result = await new AiSdkHarnessAdapter().run(input, {
      tools: [{ name: "read_file", description: "Read a file", inputSchema: {
        type: "object", properties: { path: { type: "string" } }, required: ["path"],
      } }], executeTool,
    }, (chunk) => { chunks.push(chunk); }, new AbortController().signal);

    const output = chunks.filter((chunk) => chunk.type === "message" && chunk.title === "Agent output");
    expect(output.map((chunk) => chunk.value)).toEqual([
      "Inspect ", "Inspect files.", "Check ", "Check changes.", "All ", "All done.",
    ]);
    const messages = new Map<unknown, string>();
    for (const chunk of output) {
      expect(chunk.metadata?.replace).toBe(true);
      expect(chunk.metadata?.streamId).toEqual(expect.any(String));
      messages.set(chunk.metadata?.streamId, chunk.value);
    }
    expect([...messages.values()]).toEqual(["Inspect files.", "Check changes.", "All done."]);
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Keep the full transcript for summary/checkpoint consumers, independently of UI segments.
    for (const text of messages.values()) expect(result.summary).toContain(text);
  });
});
