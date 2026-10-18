/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatTranscript } from "./ChatTranscript";

let root: Root;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

describe("chat prompt copying", () => {
  it.each(["initial", "follow-up"])("copies the %s prompt and shows confirmation", async (commandType) => {
    const copy = vi.fn();
    const content = "Please explain **this code**.\n\nKeep the original formatting.";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const client = createElectronBuildWardenClient({} as DesktopApi);
    await act(() => root.render(
      <BuildWardenClientProvider client={client}>
        <ChatTranscript emptyMessage="Empty" onCopyOutput={copy} items={[{
          id: "prompt-1", eventType: "log", title: "User prompt", content,
          metadataJson: JSON.stringify({ source: "user", commandType }), createdAt: "2026-10-18T10:00:00Z",
        }]} />
      </BuildWardenClientProvider>,
    ));
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Copy prompt"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(copy).toHaveBeenCalledWith(content, "prompt-1");
    expect(button?.getAttribute("aria-label")).toBe("Copied");
  });
});
