/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ChatStepRecord } from "@buildwarden/shared";
import { MobileChatStep } from "./ChatTranscriptStep";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(["output", "plan", "plan-updated"] as const)("supports Reply and selected-text Cite for %s", async (eventType) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const cite = vi.fn();
  const step: ChatStepRecord = { id: "plan", chatId: "chat", eventType, title: "Plan", content: "Implement this plan", metadataJson: "{}", createdAt: "2026-11-17T10:00:00Z" };
  try {
    await act(() => root.render(<MobileChatStep step={step} onCiteResponse={cite} />));
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Reply to response"]')!.click());
    expect(cite).toHaveBeenLastCalledWith({ kind: "reply", stepId: "plan", text: step.content });
    const paragraph = container.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(() => paragraph.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(cite).toHaveBeenLastCalledWith({ kind: "cite", stepId: "plan", text: step.content });
    for (const excluded of [
      { ...step, metadataJson: JSON.stringify({ source: "user" }) },
      { ...step, eventType: "error" as const },
      { ...step, eventType: "output" as const, metadataJson: JSON.stringify({ assistantKind: "reasoning" }) },
    ]) {
      await act(() => root.render(<MobileChatStep step={excluded} onCiteResponse={cite} />));
      expect(container.querySelector('[aria-label="Reply to response"]')).toBeNull();
    }
  } finally {
    await act(() => root.unmount());
    window.getSelection()?.removeAllRanges();
    container.remove();
  }
});
