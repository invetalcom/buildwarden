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

describe("RunComposer pasted text attachments", () => {
  it("turns a long paste into an attachment that can be restored to the prompt", async () => {
    const addedFiles = vi.fn<(files: File[]) => void>();
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
              onPromptChange={setPrompt}
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
    await act(async () => {
      restoreButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Pasted text");
    expect(textarea?.value).toBe(longText);
    expect(document.activeElement).toBe(textarea);
    expect(textarea?.selectionStart).toBe(longText.length);
    expect(textarea?.selectionEnd).toBe(longText.length);
  });
});
