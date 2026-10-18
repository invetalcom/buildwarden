import { describe, expect, it } from "vitest";
import { RUN_CHAT_CONTEXT_SOURCE, type RunEventType } from "@buildwarden/shared";
import { isVisibleChatStep } from "./chat-transcript";

describe("chat conversation visibility", () => {
  it("retains interruption and cancellation notices, including legacy saved steps", () => {
    for (const title of ["Session interrupted", "Chat cancelled"]) {
      expect(isVisibleChatStep({ eventType: "status", title, content: "Explanation" }, {})).toBe(true);
    }
    expect(isVisibleChatStep({ eventType: "status", content: "Explanation" }, { sessionInterrupted: true })).toBe(true);
    expect(isVisibleChatStep({ eventType: "status", content: "Explanation" }, { userFacing: true })).toBe(true);
    expect(isVisibleChatStep({ eventType: "status", title: "Codex update", content: "Image view" }, {})).toBe(false);
  });
  it.each<RunEventType>(["tool-call", "tool-result", "tool-progress", "diff-updated", "status", "plan-progress", "log"])("hides internal %s events regardless of provider", (eventType) => {
    expect(isVisibleChatStep({ eventType, content: "Internal details" }, {})).toBe(false);
  });

  it.each<RunEventType>(["output", "plan", "plan-updated", "error", "request", "user-input-requested", "approval-requested", "approval-resolved"])("retains %s conversation events", (eventType) => {
    expect(isVisibleChatStep({ eventType, content: "Message" }, {})).toBe(true);
  });

  it("keeps user attachments and assistant image answers but hides image inspection", () => {
    expect(isVisibleChatStep({ eventType: "log", content: "" }, { source: "user" })).toBe(true);
    const image = { eventType: "output" as const, content: "![Image](https://example.com/image.png)" };
    expect(isVisibleChatStep(image, { assistantKind: "image" })).toBe(true);
    expect(isVisibleChatStep(image, { assistantKind: "image", itemType: "imageView" })).toBe(false);
    const mediaOnly = { eventType: "output" as const, content: "" };
    const attachments = [{ fileName: "image.png", mimeType: "image/png", dataBase64: "AAAA" }];
    expect(isVisibleChatStep(mediaOnly, { attachments })).toBe(true);
    expect(isVisibleChatStep(mediaOnly, { attachments, itemType: "imageView" })).toBe(false);
    expect(isVisibleChatStep(mediaOnly, { attachments, silent: true })).toBe(false);
  });

  it("keeps subagent summaries but hides their internal events and context seeds", () => {
    const step = { eventType: "tool-progress" as const, content: "Progress" };
    expect(isVisibleChatStep(step, { subagent: { id: "a", source: "claude-code", status: "running" } })).toBe(true);
    expect(isVisibleChatStep(step, { subagentId: "a" })).toBe(false);
    expect(isVisibleChatStep({ ...step, eventType: "output" }, { source: RUN_CHAT_CONTEXT_SOURCE })).toBe(false);
  });

  it("hides silent and empty output without suppressing errors or questions", () => {
    expect(isVisibleChatStep({ eventType: "output", content: "" }, {})).toBe(false);
    expect(isVisibleChatStep({ eventType: "output", content: "Internal" }, { silent: true })).toBe(false);
    expect(isVisibleChatStep({ eventType: "error", content: "Failed" }, { silent: true })).toBe(true);
    expect(isVisibleChatStep({ eventType: "user-input-requested", content: "" }, { silent: true })).toBe(true);
  });
});
