/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatTranscript, type ChatTranscriptItem } from "./ChatTranscript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("copies source Markdown instead of embedded display images", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const copy = vi.fn();
  const source = "Description ![Preview](preview.png)";
  const item: ChatTranscriptItem = { id: "answer", eventType: "output", title: "Answer", createdAt: "2026-10-18T10:00:00Z", content: "![Preview](data:image/png;base64,AAAA)", metadataJson: JSON.stringify({ responseSourceText: source }) };
  try {
    await act(() => root.render(<BuildWardenClientProvider client={createElectronBuildWardenClient({} as DesktopApi)}><ChatTranscript items={[item]} emptyMessage="Empty" onCopyOutput={copy} /></BuildWardenClientProvider>));
    await act(() => container.querySelector<HTMLButtonElement>('[title="Copy output"]')!.click());
    expect(copy).toHaveBeenCalledWith(source, "answer");
  } finally { await act(() => root.unmount()); }
});

it("keeps working after commentary and tools, shows only the delivered image, and stops on completion", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  const step = (id: string, eventType: ChatTranscriptItem["eventType"], content: string, metadata = {}): ChatTranscriptItem => ({
    id, eventType, content, title: id, metadataJson: JSON.stringify(metadata), createdAt: "2026-10-18T10:00:00Z",
  });
  const initial = [step("user", "log", "Draw a mockup", { source: "user" })];
  const progress = [...initial,
    step("commentary", "output", "I am preparing the mockup."),
    step("tool", "tool-result", "Raw tool output"),
    step("Codex update", "status", "Image Generation"),
    step("inspection", "output", "![Inspection](https://example.com/image.png)", { itemType: "imageView", assistantKind: "image" }),
  ];
  const render = async (items: ChatTranscriptItem[], active: boolean) => {
    await act(() => root.render(<BuildWardenClientProvider client={client}><ChatTranscript items={items} active={active} emptyMessage="Empty" /></BuildWardenClientProvider>));
  };
  try {
    await render(initial, true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Agent is working...");
    await render(progress, true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Agent is working...");
    expect(container.textContent).toContain("I am preparing the mockup.");
    expect(container.textContent).not.toContain("Raw tool output");
    expect(container.textContent).not.toContain("Codex update");
    expect(container.querySelectorAll("img")).toHaveLength(0);
    await render([...progress, step("answer", "output", "![Final mockup](https://example.com/image.png)")], false);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render([...progress, step("error", "error", "Generation failed")], false);
    expect(container.textContent).toContain("Generation failed");
    expect(container.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
