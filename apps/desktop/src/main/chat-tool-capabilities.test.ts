import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { AiSdkHarnessAdapter, supportsOptionalChatTools } from "@buildwarden/provider-ai-sdk";
import type { ModelInput, RunExecutionRequest } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

const fixtures: { root: string; db: BuildWardenDatabase }[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const { root, db } of fixtures.splice(0)) {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("distinguishes model tool support from provider defaults and legacy flags", () => {
  for (const providerType of ["ai-sdk", "openrouter"] as const) {
    const base = { providerType, config: { providerFamily: "openai-compatible" } };
    expect(supportsOptionalChatTools(base)).toBe(false);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true } })).toBe(false);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true, supportsToolsSource: "provider-default" } })).toBe(false);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true, supportsToolsSource: "model" } })).toBe(true);
    expect(supportsOptionalChatTools({ ...base, modelCapabilities: { supportsTools: true, supportsToolsSource: "model" }, modelConfig: { supportsTools: false } })).toBe(false);
  }
  expect(supportsOptionalChatTools({ providerType: "ai-sdk", config: { providerFamily: "openai" } })).toBe(true);
  expect(supportsOptionalChatTools({ providerType: "ai-sdk", config: { providerFamily: "openai" }, modelCapabilities: { supportsTools: false } })).toBe(false);
});

const cases: { name: string; capabilities?: ModelInput["capabilities"]; config?: ModelInput["config"]; legacy?: boolean; expected: boolean }[] = [
  { name: "unknown model", expected: false },
  { name: "discovered tool support", capabilities: { supportsTools: true }, expected: true },
  { name: "discovered lack of tools", capabilities: { supportsTools: false }, expected: false },
  { name: "legacy default true", capabilities: { supportsTools: true }, legacy: true, expected: false },
  { name: "legacy false", capabilities: { supportsTools: false }, legacy: true, expected: false },
  { name: "explicit opt-in", config: { supportsTools: true }, expected: true },
  { name: "explicit opt-out", capabilities: { supportsTools: true }, config: { supportsTools: false }, expected: false },
];

for (const providerType of ["ai-sdk", "openrouter"] as const) {
  it.each(cases)(providerType + " persists $name and serializes the correct chat tools", async ({ capabilities, config, legacy, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "buildwarden-chat-tools-"));
    const db = new BuildWardenDatabase(join(root, "state.sqlite"));
    fixtures.push({ root, db });
    await db.init();
    const provider = db.addProviderAccount({ providerType, label: "Test", apiBaseUrl: "https://model.example.invalid/v1", apiKeyRef: "", configJson: JSON.stringify({ providerFamily: "openai-compatible" }) });
    const controller = new AppController(db, {
      readSecret: vi.fn(async () => null), saveSecret: vi.fn(async () => undefined), deleteSecret: vi.fn(async () => undefined),
    }, join(root, "logs"), {
      pickProjectDirectory: vi.fn(async () => null), pickIdeExecutable: vi.fn(async () => null),
      openPathInFileManager: vi.fn(async () => ({ ok: true })), openExternalUrl: vi.fn(async () => ({ ok: true })), launchIdeWithFolder: vi.fn(async () => undefined),
    }, { killForRunId: vi.fn() }, new HostEventBus());
    const modelInput: ModelInput = { providerAccountId: provider.id, modelId: "test", displayName: "Test", capabilities, config };
    const added = legacy ? db.addModel(modelInput) : await controller.addModel(modelInput);
    const saved = db.getModel(added.id);
    if (!legacy) expect(JSON.parse(saved.capabilitiesJson).supportsToolsSource).toBe(capabilities ? "model" : "provider-default");

    const fetchMock = vi.fn(async () => new Response([
      'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]', "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const input: RunExecutionRequest = {
      runId: "chat", worktreePath: root, mode: "ask", prompt: "Hi", providerType, modelId: saved.modelId,
      apiKey: "test", apiBaseUrl: provider.apiBaseUrl, config: JSON.parse(provider.configJson), isChat: true,
      modelConfig: JSON.parse(saved.configJson), modelCapabilities: JSON.parse(saved.capabilitiesJson),
    };
    const adapter = new AiSdkHarnessAdapter(async () => ({}));
    const result = await adapter.run(input, { tools: [], executeTool: vi.fn() }, vi.fn(), new AbortController().signal);
    expect(result.summary).toBe("Hello");
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo, RequestInit];
    const body = JSON.parse(String(call[1].body));
    if (expected) expect(body.tools[0].function.name).toBe("request_user_input");
    else expect(body).not.toHaveProperty("tools");
  });
}
