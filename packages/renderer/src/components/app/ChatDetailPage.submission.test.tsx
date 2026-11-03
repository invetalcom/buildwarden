/** @vitest-environment happy-dom */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { ChatDetail, DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { readFilesAsChatPayloads } from "../../lib/read-chat-attachments";
import { ChatDetailPage } from "./ChatDetailPage";
import type { RunComposer } from "./RunComposer";

let composer: ComponentProps<typeof RunComposer>;
vi.mock("./RunComposer", () => ({ RunComposer: (props: ComponentProps<typeof RunComposer>) => { composer = props; return null; } }));
vi.mock("../../lib/read-chat-attachments", () => ({ readFilesAsChatPayloads: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
let renderCurrent: () => void;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.resetAllMocks(); });

async function render(onFollowUp: ComponentProps<typeof ChatDetailPage>["onFollowUp"]) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = { ...createElectronBuildWardenClient({} as DesktopApi), draftScopeId: crypto.randomUUID() };
  const props: ComponentProps<typeof ChatDetailPage> = {
    chatDetail: { chat: { id: "chat", modelId: "model", prompt: "Chat", status: "completed", inputTokens: 0, outputTokens: 0, updatedAt: "2026-01-01" } as ChatDetail["chat"], steps: [] },
    modelOptions: [{ id: "model", label: "Model", modelId: "gpt-5", providerType: "codex-cli", providerFamily: null }],
    models: [], keyboardShortcuts: {} as ComponentProps<typeof ChatDetailPage>["keyboardShortcuts"],
    busy: false, isBookmarked: false, onBack: vi.fn(), onFollowUp, onCancel: vi.fn(),
    onAddBookmark: vi.fn(), onRemoveBookmark: vi.fn(), onLoadEarlierHistory: vi.fn(),
  };
  renderCurrent = () => root.render(<BuildWardenClientProvider client={client}><ChatDetailPage {...props} /></BuildWardenClientProvider>);
  await act(renderCurrent);
  const file = new File(["hello"], "context.txt", { type: "text/plain" });
  vi.mocked(readFilesAsChatPayloads).mockResolvedValue([{ fileName: file.name, mimeType: file.type, dataBase64: "aGVsbG8=" }]);
  await act(() => { composer.onPromptChange("  draft prompt  "); composer.onAddAttachmentFiles?.([file]); });
  return file;
}

it("keeps the prompt and attachments on failure and clears them after a successful retry", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(undefined);
  const file = await render(send);
  await act(() => composer.onSubmit());
  expect(container.textContent).toContain("Connection lost");
  expect(composer.prompt).toBe("  draft prompt  ");
  expect(composer.contextAttachmentFiles).toEqual([file]);
  expect(composer.busy).toBe(false);
  await act(() => composer.onSubmit());
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "draft prompt", attachments: [expect.objectContaining({ fileName: "context.txt" })] }));
  expect(composer.prompt).toBe("");
  expect(composer.contextAttachmentFiles).toEqual([]);
  expect(container.textContent).not.toContain("Connection lost");
});

it("prevents duplicate sends during attachment reads and preserves subsequent draft edits", async () => {
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  await render(send);
  await act(() => { composer.onSubmit(); composer.onSubmit(); });
  expect(send).toHaveBeenCalledOnce();
  expect(composer.busy).toBe(true);
  const nextFile = new File(["next"], "next.txt");
  await act(() => { composer.onPromptChange("next draft"); composer.onAddAttachmentFiles?.([nextFile]); });
  await act(() => finish());
  expect(composer.prompt).toBe("next draft");
  expect(composer.contextAttachmentFiles).toEqual([nextFile]);
});

it("retains unreadable attachments and the prompt without sending", async () => {
  const send = vi.fn();
  const file = await render(send);
  vi.mocked(readFilesAsChatPayloads).mockRejectedValueOnce(new Error("Could not read context.txt"));
  await act(() => composer.onSubmit());
  expect(send).not.toHaveBeenCalled();
  expect(composer.prompt).toBe("  draft prompt  ");
  expect(composer.contextAttachmentFiles).toEqual([file]);
  expect(container.textContent).toContain("Could not read context.txt");
});

it.each([true, false])("shows a pending chat submission after remount and releases on success=%s", async (success) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const send = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
  const file = await render(send);
  await act(() => { composer.onSubmit(); });
  await act(() => root.render(null));
  await act(renderCurrent);
  expect(composer.busy).toBe(true);
  expect(composer.submitDisabled).toBe(true);
  await act(() => { composer.onSubmit(); });
  expect(send).toHaveBeenCalledOnce();
  await act(() => { if (success) resolve(); else reject(new Error("Disconnected")); });
  expect(composer.busy).toBe(false);
  expect(composer.prompt).toBe(success ? "" : "  draft prompt  ");
  expect(composer.contextAttachmentFiles).toEqual(success ? [] : [file]);
});
