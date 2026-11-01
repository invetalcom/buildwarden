/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { DesktopApi } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ChatTranscript, type ChatTranscriptItem } from "./ChatTranscript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("shows media-only replies as large previews with zoom and downloads, preserving real captions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  const image = { fileName: "generated-image.png", mimeType: "image/png", dataBase64: "AAAA" };
  const render = async (content: string, attachments = [image], assistantKind = "files") => {
    const item: ChatTranscriptItem = {
      id: "media", eventType: "output", title: "Generated files", content,
      metadataJson: JSON.stringify({ assistantKind, attachments }), createdAt: "2026-10-18T10:00:00Z",
    };
    await act(() => root.render(<BuildWardenClientProvider client={client}><ChatTranscript items={[item]} emptyMessage="Empty" /></BuildWardenClientProvider>));
  };
  try {
    await render("Generated 1 file.");
    expect(container.querySelector(".chat-bubble--media")).not.toBeNull();
    expect(container.textContent).not.toContain("Generated 1 file.");
    expect(container.querySelector('[title="Copy output"]')).toBeNull();
    expect(container.querySelector("img")?.className).toContain("object-contain");
    expect(container.querySelector('a[download="generated-image.png"]')).not.toBeNull();
    await act(() => container.querySelector<HTMLButtonElement>('[title="Open generated-image.png"]')!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await render("", [image], "assistant");
    expect(container.querySelector(".chat-bubble--media")).not.toBeNull();
    await render("Generated 2 files.", [image, { ...image, fileName: "second.png" }]);
    expect(container.querySelectorAll(".chat-media-grid img")).toHaveLength(2);
    await render("Generated 1 file.", [{ fileName: "clip.mp4", mimeType: "video/mp4", dataBase64: "AAAA" }]);
    expect(container.querySelector(".chat-media-grid video[controls]")).not.toBeNull();
    await render("Generated 1 file.", [{ fileName: "music.mp3", mimeType: "audio/mpeg", dataBase64: "AAAA" }]);
    expect(container.querySelector(".chat-media-grid audio[controls]")).not.toBeNull();
    await render("Here is the image with an explanation.");
    expect(container.querySelector(".chat-bubble--media")).toBeNull();
    expect(container.textContent).toContain("Here is the image with an explanation.");
    expect(container.querySelector('[title="Copy output"]')).not.toBeNull();
    await render("Generated 1 file.", [], "files");
    expect(container.textContent).toContain("Generated 1 file.");
  } finally { await act(() => root.unmount()); }
});

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
    await render([...progress, step("answer", "output", "![Final mockup](data:image/png;base64,AAAA)")], false);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render([...progress, step("error", "error", "Generation failed")], false);
    expect(container.textContent).toContain("Generation failed");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render([...progress, { ...step("interrupted", "status", "The previous session stopped."), title: "Session interrupted" }], false);
    expect(container.textContent).toContain("Session interrupted");
    expect(container.textContent).toContain("The previous session stopped.");
    expect(container.textContent).not.toContain("Codex update");
  } finally {
    await act(() => root.unmount());
  }
});

it("shows a model switch in a chat as a compact handoff divider", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const client = createElectronBuildWardenClient({} as DesktopApi);
  const handoff: ChatTranscriptItem = {
    id: "handoff", eventType: "status", title: "Model switched", content: "Passing over to Sonnet · Claude Code",
    metadataJson: JSON.stringify({
      userFacing: true,
      modelHandoff: { fromModelId: "a", fromModelLabel: "GPT-5", toModelId: "b", toModelLabel: "Sonnet", toProviderLabel: "Claude Code", providerChanged: true, context: "history" },
    }),
    createdAt: "2026-10-18T10:00:00Z",
  };
  try {
    await act(() => root.render(<BuildWardenClientProvider client={client}><ChatTranscript items={[handoff]} emptyMessage="Empty" /></BuildWardenClientProvider>));
    const divider = container.querySelector(".agent-turn-end--handoff");
    expect(divider?.getAttribute("aria-label")).toBe("Passing over to Sonnet · Claude Code");
    expect(divider?.textContent).toContain("conversation handed over");
    expect(container.querySelector(".chat-system-message")).toBeNull();
  } finally {
    await act(() => root.unmount());
  }
});
