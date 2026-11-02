/** @vitest-environment happy-dom */

import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appendChatAttachmentFiles, type DesktopApi } from "@buildwarden/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { PastedTextAttachmentThresholdProvider } from "../../lib/pasted-text-attachment-settings";
import { ChatAttachmentPicker } from "./ChatAttachmentPicker";
import { RunComposer } from "./RunComposer";

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

const pasteEvent = (text: string): Event => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      getData: (type: string) => type === "text/plain" ? text : "",
    } satisfies Partial<DataTransfer>,
  });
  return event;
};

describe("RunComposer IME shortcuts", () => {
  it("leaves composition keys to the IME before command selection or submission", async () => {
    const onSubmit = vi.fn();
    const onPromptKeyDown = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const client = createElectronBuildWardenClient({} as DesktopApi);
    await act(() => root?.render(<BuildWardenClientProvider client={client}><RunComposer
      prompt="日本語" onPromptChange={vi.fn()} selectedMode="ask" onModeChange={vi.fn()}
      selectedModelId="model" onModelChange={vi.fn()} modelOptions={[{ value: "model", label: "Model" }]}
      busy={false} onSubmit={onSubmit} onPromptKeyDown={onPromptKeyDown} submitShortcut="enter" showContextBadge={false}
    /></BuildWardenClientProvider>));
    const textarea = container.querySelector("textarea")!;
    for (const init of [
      { key: "Enter", isComposing: true },
      { key: "ArrowDown", isComposing: true },
      { key: "Enter", isComposing: false, keyCode: 229 },
    ]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      await act(() => textarea.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onPromptKeyDown).not.toHaveBeenCalled();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(() => textarea.dispatchEvent(enter));
    expect(onPromptKeyDown).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(enter.defaultPrevented).toBe(true);
  });
});

describe("RunComposer pasted text attachments", () => {
  it("turns a long paste into an attachment that can be restored to the prompt", async () => {
    const addedFiles = vi.fn<(files: File[]) => void>();
    const promptChanges = vi.fn<(value: string) => void>();
    const client = createElectronBuildWardenClient({} as DesktopApi);

    const Harness = () => {
      const [prompt, setPrompt] = useState("");
      const [files, setFiles] = useState<File[]>([]);
      return (
        <PastedTextAttachmentThresholdProvider threshold={40}>
          <BuildWardenClientProvider client={client}>
            <RunComposer
              variant="chat"
              attachments={<ChatAttachmentPicker variant="footer" files={files} onChange={setFiles} />}
              prompt={prompt}
              onPromptChange={(value) => {
                promptChanges(value);
                setPrompt(value);
              }}
              selectedMode="ask"
              onModeChange={vi.fn()}
              selectedModelId="model-1"
              modelOptions={[{ value: "model-1", label: "GPT-5" }]}
              onModelChange={vi.fn()}
              busy={false}
              onSubmit={vi.fn()}
              onAddAttachmentFiles={(incoming) => {
                addedFiles(incoming);
                setFiles((current) => appendChatAttachmentFiles(current, incoming));
              }}
              submitDisabled={!prompt.trim() && files.length === 0}
              showContextBadge={false}
              sticky={false}
            />
          </BuildWardenClientProvider>
        </PastedTextAttachmentThresholdProvider>
      );
    };

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Harness />));

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    const shortPaste = pasteEvent("A normal pasted sentence.");
    await act(async () => textarea?.dispatchEvent(shortPaste));
    expect(shortPaste.defaultPrevented).toBe(false);
    expect(addedFiles).not.toHaveBeenCalled();

    const longText = "Run pnpm audit --fix\ndependency output dependency output";
    const longPaste = pasteEvent(longText);
    await act(async () => textarea?.dispatchEvent(longPaste));

    expect(longPaste.defaultPrevented).toBe(true);
    expect(addedFiles).toHaveBeenCalledTimes(1);
    const file = addedFiles.mock.calls[0]?.[0][0];
    expect(file?.name).toBe("Run pnpm audit --fix.txt");
    expect(file && await file.text()).toBe(longText);
    expect(container.textContent).toContain("Run pnpm audit --fix");
    expect(container.textContent).toContain("Pasted text");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(false);

    const restoreButton = container.querySelector<HTMLButtonElement>(`button[aria-label="Paste ${file?.name ?? ""} back into prompt"]`);
    if (!file || !restoreButton) {
      throw new Error("Expected the pasted-text attachment and its restore button.");
    }
    let resolveFileText: ((value: string) => void) | undefined;
    const pendingFileText = new Promise<string>((resolve) => {
      resolveFileText = resolve;
    });
    const fileText = vi.spyOn(file, "text").mockReturnValue(pendingFileText);
    await act(async () => {
      restoreButton.click();
      restoreButton.click();
      await Promise.resolve();
    });

    expect(fileText).toHaveBeenCalledOnce();
    expect(promptChanges).not.toHaveBeenCalled();
    await act(async () => {
      resolveFileText?.(longText);
      await pendingFileText;
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Pasted text");
    expect(promptChanges).toHaveBeenCalledOnce();
    expect(promptChanges).toHaveBeenCalledWith(longText);
    expect(textarea?.value).toBe(longText);
    expect(document.activeElement).toBe(textarea);
    expect(textarea?.selectionStart).toBe(longText.length);
    expect(textarea?.selectionEnd).toBe(longText.length);
  });
});
