import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { HarnessToolContext, RunExecutionRequest } from "@buildwarden/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runAzureLegacyHarness } from "../../../../packages/provider-azure-legacy/src";

const openServers = new Set<ReturnType<typeof createServer>>();

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
};

const captureAzureLegacyRequest = async (isChat: boolean): Promise<Record<string, unknown>> => {
  let resolvePayload: (payload: Record<string, unknown>) => void;
  const payloadPromise = new Promise<Record<string, unknown>>((resolve) => {
    resolvePayload = resolve;
  });
  const server = createServer(async (request, response) => {
    resolvePayload(await readJsonBody(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-azure-characterization",
        object: "chat.completion.chunk",
        created: 0,
        model: "azure-deployment",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-azure-characterization",
        object: "chat.completion.chunk",
        created: 0,
        model: "azure-deployment",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  openServers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const input = {
    runId: "azure-payload-characterization",
    worktreePath: process.cwd(),
    mode: isChat ? "ask" : "code",
    prompt: "Return OK",
    providerType: "azure-legacy",
    modelId: "azure-deployment",
    apiKey: "test-key",
    apiBaseUrl: `http://127.0.0.1:${address.port}/openai/deployments/azure-deployment/`,
    isChat,
    providerOptions: {
      reasoningEffort: "high",
      anthropicEffort: "max",
      serviceTier: "fast",
      speed: "fast",
      thinkingLevel: "high",
    },
  } as unknown as RunExecutionRequest;
  const toolContext: HarnessToolContext = {
    tools: [],
    executeTool: async () => {
      throw new Error("Azure characterization request unexpectedly executed a tool.");
    },
  };

  try {
    await runAzureLegacyHarness(input, toolContext, () => undefined, new AbortController().signal);
    return await payloadPromise;
  } finally {
    server.close();
    openServers.delete(server);
  }
};

afterEach(async () => {
  await Promise.all(
    [...openServers].map(async (server) => {
      server.close();
      await once(server, "close");
    }),
  );
  openServers.clear();
});

describe("Azure Legacy request payload characterization", () => {
  it("keeps chat payloads free of cross-provider execution options", async () => {
    const payload = await captureAzureLegacyRequest(true);

    expect(Object.keys(payload).sort()).toEqual(["messages", "model", "stream", "stream_options", "temperature"]);
    expect(payload).toMatchObject({
      model: "azure-deployment",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
    });
  });

  it("keeps agent payloads free of cross-provider execution options", async () => {
    const payload = await captureAzureLegacyRequest(false);

    expect(Object.keys(payload).sort()).toEqual([
      "messages",
      "model",
      "stream",
      "stream_options",
      "temperature",
      "tool_choice",
      "tools",
    ]);
    expect(payload).toMatchObject({
      model: "azure-deployment",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      tool_choice: "auto",
      tools: [],
    });
  });
});
