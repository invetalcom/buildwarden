/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatRecord, ChatSearchDetail, DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatPage } from "./ChatPage";

const chatRecord = (overrides: Partial<ChatRecord> = {}): ChatRecord => ({
  id: "chat-1", providerAccountId: "provider-1", modelId: "model-1", runId: null,
  prompt: "Explain Angular signals", status: "completed", lastProviderResponseId: null,
  inputTokens: 1200, outputTokens: 300, createdAt: "2026-10-28T10:00:00Z", updatedAt: "2026-10-28T10:01:00Z",
  startedAt: "2026-10-28T10:00:00Z", finishedAt: "2026-10-28T10:01:00Z", ...overrides,
});

let root: Root | null = null;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.restoreAllMocks();
});

const renderPage = async (chats: ChatSearchDetail[] = [], readOnly = false, overrides: Partial<ComponentProps<typeof ChatPage>> = {}) => {
  const listChatsWithSteps = vi.fn<DesktopApi["listChatsWithSteps"]>().mockResolvedValue(chats);
  const desktop = createElectronBuildWardenClient({ listChatsWithSteps } as unknown as DesktopApi);
  const client = { ...desktop, capabilities: { ...desktop.capabilities, chatMutations: !readOnly } };
  const props: ComponentProps<typeof ChatPage> = {
    modelOptions: [{ id: "model-1", label: "GPT", modelId: "gpt", providerType: "ai-sdk", providerFamily: "openai" }],
    defaultModelId: "model-1", submitShortcut: "ctrl+enter", reasoningEffort: "auto", anthropicEffort: "auto",
    onReasoningEffortChange: vi.fn(), onAnthropicEffortChange: vi.fn(), onCreateChat: vi.fn(), onSelectChat: vi.fn(), onDeleteChat: vi.fn(),
    ...overrides,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<BuildWardenClientProvider client={client}><ChatPage {...props} /></BuildWardenClientProvider>));
  return { props, listChatsWithSteps };
};

const enterText = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("chat landing page", () => {
  it("keeps newest-first history, searches replies, opens chats, and refreshes after deletion", async () => {
    const first = chatRecord();
    const newest = chatRecord({ id: "chat-2", prompt: "Review the design", updatedAt: "2026-10-29T10:00:00Z" });
    const { props, listChatsWithSteps } = await renderPage([
      { chat: first, steps: [{ title: "Reply", eventType: "output", content: "Signals use dependency tracking." }] },
      { chat: newest, steps: [] },
    ]);
    expect([...container.querySelectorAll("[data-chat-history-id]")].map((row) => row.getAttribute("data-chat-history-id"))).toEqual(["chat-2", "chat-1"]);
    expect(container.querySelector('[title="1,500 tokens"], [title="1.500 tokens"]')).not.toBeNull();
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!;
    await enterText(search, "dependency tracking");
    expect(container.querySelectorAll("[data-chat-history-id]")).toHaveLength(1);
    expect(container.textContent).toContain("1 matching of 2 chats");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-history-id="chat-1"] [title="Open chat"]')?.click());
    expect(props.onSelectChat).toHaveBeenCalledWith(first);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear chat search"]')?.click());
    expect(container.querySelectorAll("[data-chat-history-id]")).toHaveLength(2);
    listChatsWithSteps.mockResolvedValue([{ chat: first, steps: [] }]);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-chat-history-id="chat-2"] [title="Delete chat"]')?.click());
    expect(props.onDeleteChat).toHaveBeenCalledWith("chat-2");
    expect(listChatsWithSteps).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-chat-history-id="chat-2"]')).toBeNull();
    expect(props.onSelectChat).toHaveBeenCalledTimes(1);
  });

  it("submits through the chat-only launch composer using the shortcut and attachment-only messages", async () => {
    const onCreateChat = vi.fn<ComponentProps<typeof ChatPage>["onCreateChat"]>().mockResolvedValue(undefined);
    await renderPage([], false, { onCreateChat });
    const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="New chat prompt"]')!;
    const submit = container.querySelector<HTMLButtonElement>('[aria-label="Start chat"]')!;
    expect(submit.disabled).toBe(true);
    expect(container.querySelector(".lucide-sliders-horizontal")).toBeNull();
    await enterText(prompt, "Explain signals");
    await act(async () => prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
    expect(onCreateChat).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Explain signals", modelId: "model-1" }));
    expect(prompt.value).toBe("");
    onCreateChat.mockClear();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["Context"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
      await vi.waitFor(() => expect(onCreateChat).toHaveBeenCalled());
    });
    expect(onCreateChat).toHaveBeenCalledWith(expect.objectContaining({ prompt: "", modelId: "model-1",
      attachments: [{ fileName: "notes.txt", mimeType: "text/plain", dataBase64: "Q29udGV4dA==" }] }));
    expect(container.textContent).not.toContain("notes.txt");
  });

  it("keeps read-only history usable and gives attachment-only chats a visible title", async () => {
    const chat = chatRecord({ prompt: "" });
    const { props } = await renderPage([{ chat, steps: [] }], true);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector('[title="Delete chat"]')).toBeNull();
    expect(container.querySelector('[aria-label="Search chats"]')).not.toBeNull();
    expect(container.textContent).toContain("Chat with attachments");
    await act(async () => container.querySelector<HTMLButtonElement>('[title="Open chat"]')?.click());
    expect(props.onSelectChat).toHaveBeenCalledWith(chat);
  });

  it("keeps chat creation disabled when no compatible models are configured", async () => {
    await renderPage([], false, { modelOptions: [], defaultModelId: "" });
    await enterText(container.querySelector<HTMLTextAreaElement>("textarea")!, "A new question");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Start chat"]')?.disabled).toBe(true);
    expect(container.textContent).toContain("No chat-compatible models are configured");
  });
});
