/** @vitest-environment happy-dom */

import type { ChatDetail, ChatEvent, ChatRecord, ChatStepRecord, KeyboardShortcutId } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { act, forwardRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { RunChatPanel } from "./RunChatPanel";

vi.mock("./ChatAttachmentPicker", () => ({ ChatAttachmentPicker: () => null }));
vi.mock("./RunComposer", () => ({ RunComposer: () => null }));
vi.mock("./ChatTranscript", () => ({
  ChatTranscript: forwardRef<HTMLDivElement, { items: ChatStepRecord[] }>(({ items }, ref) => (
    <div ref={ref}>{items.map(({ id }) => id).join(",")}</div>
  )),
}));

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => { resolve = next; });
  return { promise, resolve };
};

const chat = {
  id: "chat-1",
  runId: "run-1",
  prompt: "What changed?",
  status: "running",
  createdAt: "2026-08-29T06:00:00.000Z",
} as ChatRecord;

const step = (id: string): ChatStepRecord => ({
  id,
  chatId: chat.id,
  eventType: "output",
  title: "Agent output",
  content: id,
  metadataJson: "{}",
  createdAt: `2026-08-29T06:00:0${id === "step-1" ? "1" : "2"}.000Z`,
});

const detail = (steps: ChatStepRecord[]): ChatDetail => ({ chat, steps });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("RunChatPanel", () => {
  it("reloads when a buffered event reveals a chat created during the initial request", async () => {
    const initialLoad = deferred<ChatDetail | null>();
    let publishChatEvent: ((event: ChatEvent) => void) | undefined;
    const getRunChat = vi.fn()
      .mockImplementationOnce(() => initialLoad.promise)
      .mockResolvedValueOnce(detail([step("step-1")]));
    const client = {
      getRunChat,
      onChatEvent: vi.fn((listener: (event: ChatEvent) => void) => {
        publishChatEvent = listener;
        return vi.fn();
      }),
    } as unknown as BuildWardenClient;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(
      <BuildWardenClientProvider client={client}>
        <RunChatPanel
          runId="run-1"
          defaultModelId="model-1"
          modelOptions={[{
            id: "model-1",
            label: "GPT",
            modelId: "gpt",
            providerType: "ai-sdk",
            providerFamily: "openai",
          }]}
          keyboardShortcuts={{} as Record<KeyboardShortcutId, string>}
        />
      </BuildWardenClientProvider>,
    ));

    await act(async () => publishChatEvent?.({
      runId: chat.id,
      chatId: chat.id,
      type: "log",
      title: "Chat started",
      content: "",
      createdAt: chat.createdAt,
      chat,
    }));
    await act(async () => {
      initialLoad.resolve(null);
      await initialLoad.promise;
    });

    expect(getRunChat).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("step-1");

    const laterStep = step("step-2");
    await act(async () => publishChatEvent?.({
      runId: chat.id,
      chatId: chat.id,
      type: "output",
      title: laterStep.title,
      content: laterStep.content,
      createdAt: laterStep.createdAt,
      step: laterStep,
    }));
    expect(container.textContent).toContain("step-1,step-2");
  });
});
