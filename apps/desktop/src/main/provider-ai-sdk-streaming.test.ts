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

describe("web search sources", () => {
  const citedCompletion = (content: string, citations: Array<{ url: string; title?: string }>) => {
    const frame = (delta: Record<string, unknown>, finishReason: string | null = null) => `data: ${JSON.stringify({
      id: "response-1", object: "chat.completion.chunk", created: 0, model: "test",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}`;
    return new Response([
      frame({ content, annotations: citations.map(({ url, title }) => ({ type: "url_citation", url_citation: { url, title, start_index: 0, end_index: 1 } })) }),
      frame({}, "stop"), "data: [DONE]", "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  };
  const run = async (isChat: boolean) => {
    const chunks: HarnessRunChunk[] = [];
    const result = await new AiSdkHarnessAdapter().run({
      runId: "cited", worktreePath: process.cwd(), mode: "ask", prompt: "Capital?", isChat,
      providerType: "openrouter", modelId: "test:online", apiKey: "test", apiBaseUrl: "https://model.example.invalid/v1",
      config: { providerFamily: "openai-compatible" },
    }, { tools: [], executeTool: vi.fn() }, (chunk) => { chunks.push(chunk); }, new AbortController().signal);
    const output = chunks.filter((chunk) => chunk.type === "message" && chunk.title === "Agent output");
    return { result, output };
  };

  it.each([false, true])("lists cited sources under the answer in citation order (chat: %s)", async (isChat) => {
    vi.stubGlobal("fetch", vi.fn(async () => citedCompletion("Paris [1][2].", [
      { url: "https://example.com/paris", title: "Paris [guide]" },
      { url: "https://www.wiki.example/France" },
      { url: "https://example.com/paris", title: "Duplicate" },
    ])));
    const { result, output } = await run(isChat);
    const expected = "Paris [1][2].\n\n**Sources**\n\n1. [Paris \\[guide\\]](<https://example.com/paris>)\n2. [wiki.example](<https://www.wiki.example/France>)";
    expect(output.at(-1)?.value).toBe(expected);
    expect(new Set(output.map((chunk) => chunk.metadata?.streamId)).size).toBe(1);
    expect(result.summary).toBe(expected);
  });

  it("adds the sources to the answer row when the last tool round writes no text", async () => {
    const frame = (round: number, delta: Record<string, unknown>, finishReason: string | null = null) => `data: ${JSON.stringify({
      id: `response-${String(round)}`, object: "chat.completion.chunk", created: 0, model: "test",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}`;
    const stream = (frames: string[]) => new Response([...frames, "data: [DONE]", ""].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(async () => stream([
        frame(1, { content: "Paris [1].", annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/paris", title: "Guide", start_index: 0, end_index: 1 } }] }),
        frame(1, { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] }),
        frame(1, {}, "tool_calls"),
      ]))
      .mockImplementationOnce(async () => stream([frame(2, {}, "stop")])));
    const chunks: HarnessRunChunk[] = [];
    await new AiSdkHarnessAdapter().run({
      runId: "cited-tools", worktreePath: process.cwd(), mode: "ask", prompt: "Capital?",
      providerType: "openrouter", modelId: "test:online", apiKey: "test", apiBaseUrl: "https://model.example.invalid/v1",
      config: { providerFamily: "openai-compatible" },
    }, {
      tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      executeTool: vi.fn(async (call) => ({ toolCallId: call.id, name: call.name, ok: true, content: "File contents" })),
    }, (chunk) => { chunks.push(chunk); }, new AbortController().signal);
    const output = chunks.filter((chunk) => chunk.type === "message" && chunk.title === "Agent output");
    expect(new Set(output.map((chunk) => chunk.metadata?.streamId)).size).toBe(1);
    expect(output.at(-1)?.value).toBe("Paris [1].\n\n**Sources**\n\n1. [Guide](<https://example.com/paris>)");
  });

  it("adds nothing when the answer already links every source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => citedCompletion("Paris ([guide](https://example.com/paris)).", [{ url: "https://example.com/paris", title: "Guide" }])));
    const { output } = await run(false);
    expect(output.at(-1)?.value).toBe("Paris ([guide](https://example.com/paris)).");
  });

  it.each([
    ["a Markdown link", "Paris ([guide](https://example.com/paris-guide))."],
    ["an autolink", "Paris <https://example.com/paris-guide>."],
    ["a bare URL", "Paris: https://example.com/paris/2024 and more."],
  ])("still lists a source when the answer only links a longer URL as %s", async (_name, answer) => {
    vi.stubGlobal("fetch", vi.fn(async () => citedCompletion(answer, [{ url: "https://example.com/paris", title: "Guide" }])));
    const { output } = await run(false);
    expect(output.at(-1)?.value).toBe(`${answer}\n\n**Sources**\n\n1. [Guide](<https://example.com/paris>)`);
  });

  it.each(["Paris <https://example.com/paris>.", "Paris: https://example.com/paris."])("treats %s as linking the source", async (answer) => {
    vi.stubGlobal("fetch", vi.fn(async () => citedCompletion(answer, [{ url: "https://example.com/paris", title: "Guide" }])));
    const { output } = await run(false);
    expect(output.at(-1)?.value).toBe(answer);
  });
});

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
