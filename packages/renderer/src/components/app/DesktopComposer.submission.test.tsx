/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { KeyboardShortcutId } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatPage } from "./ChatPage";
import { RunChatPanel } from "./RunChatPanel";
import type { RunComposer } from "./RunComposer";
let composer: ComponentProps<typeof RunComposer>;
vi.mock("./RunComposer", () => ({ RunComposer: (props: ComponentProps<typeof RunComposer>) => { composer = props; return null; } }));
vi.mock("./ChatHistory", () => ({ ChatHistory: () => null }));
vi.mock("./ChatTranscript", () => ({ ChatTranscript: () => null }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const models = [{ id: "model", modelId: "gpt", label: "GPT", providerType: "ai-sdk" as const, providerFamily: "openai" as const }];
describe.each(["chat", "run-chat"] as const)("%s submission ownership", (kind) => {
  it.each([true, false])("survives remount and releases after success=%s", async (success) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const send = vi.fn(async () => { await pending; return { id: "chat" }; });
    const client = { draftScopeId: crypto.randomUUID(), capabilities: { chatMutations: true },
      listChatsWithSteps: async () => [], getRunChat: async () => null, onChatEvent: () => () => {}, createRunChat: send,
    } as unknown as BuildWardenClient;
    vi.stubGlobal("alert", vi.fn());
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = () => root.render(<BuildWardenClientProvider client={client}>
      {kind === "chat" ? <ChatPage modelOptions={models} defaultModelId="model" submitShortcut="Enter" onSelectChat={() => {}} onCreateChat={async () => { await send(); }} reasoningEffort="auto" anthropicEffort="auto" onReasoningEffortChange={() => {}} onAnthropicEffortChange={() => {}} onDeleteChat={async () => {}} />
        : <RunChatPanel projectId="project-1" runId="run" defaultModelId="model" modelOptions={models} keyboardShortcuts={{} as Record<KeyboardShortcutId, string>} />}
    </BuildWardenClientProvider>);
    try {
      await act(render);
      await act(() => composer.onPromptChange("Draft"));
      await act(() => { void composer.onSubmit(); });
      await act(() => root.render(null));
      await act(render);
      expect(composer.busy).toBe(true);
      await act(() => { void composer.onSubmit(); });
      expect(send).toHaveBeenCalledTimes(1);
      await act(() => { if (success) resolve(); else reject(new Error("Offline")); });
      expect(composer.busy).toBe(false);
      expect(composer.prompt).toBe(success ? "" : "Draft");
    } finally { await act(() => root.unmount()); vi.unstubAllGlobals(); }
  });
});
