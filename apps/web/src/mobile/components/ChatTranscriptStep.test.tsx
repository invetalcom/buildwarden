import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ChatStepRecord } from "@buildwarden/shared";
import { MobileChatStep } from "./ChatTranscriptStep";

const step = (eventType: ChatStepRecord["eventType"], metadata = {}): ChatStepRecord => ({
  id: "step", chatId: "chat", eventType, title: "Internal update",
  content: "![Preview](https://example.com/image.png)", metadataJson: JSON.stringify(metadata), createdAt: "2026-10-18T10:00:00Z",
});

it.each<ChatStepRecord["eventType"]>(["tool-call", "tool-result", "tool-progress", "status", "diff-updated"])("hides %s from mobile chat", (eventType) => {
  expect(renderToStaticMarkup(<MobileChatStep step={step(eventType)} />)).toBe("");
});

it("keeps delivered image answers while hiding inspection previews", () => {
  expect(renderToStaticMarkup(<MobileChatStep step={step("output", { itemType: "imageView" })} />)).toBe("");
  const external = renderToStaticMarkup(<MobileChatStep step={step("output", { assistantKind: "image" })} />);
  expect(external).toContain("Load external image");
  expect(external).not.toContain("<img");
  expect(renderToStaticMarkup(<MobileChatStep step={{ ...step("output"), content: "![Preview](data:image/png;base64,AAAA)" }} />)).toContain("<img");
});

it("keeps errors visible", () => {
  expect(renderToStaticMarkup(<MobileChatStep step={step("error")} />)).toContain("Internal update");
});

it("explains interruptions and cancellations without restoring generic status noise", () => {
  for (const title of ["Session interrupted", "Chat cancelled"]) {
    const html = renderToStaticMarkup(<MobileChatStep step={{ ...step("status"), title, content: "The previous session stopped." }} />);
    expect(html).toContain(title);
    expect(html).toContain("The previous session stopped.");
  }
});
