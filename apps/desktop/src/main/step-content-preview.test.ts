import { describe, expect, it } from "vitest";
import {
  previewLargeStepContent,
  previewLargeStepContents,
  STEP_CONTENT_PREVIEW_THRESHOLD,
  stepContentOmissionMarker,
  type RunStepRecord,
} from "@buildwarden/shared";
import { withStepContentPreview } from "./services/run-step-content";

const logLines = (count: number) => Array.from({ length: count }, (_, index) => `line ${String(index).padStart(6, "0")} ${"x".repeat(40)}`).join("\n");

describe("step content previews", () => {
  it("keeps small tool output and non-tool steps whole", () => {
    const small = { eventType: "tool-result", content: "x".repeat(STEP_CONTENT_PREVIEW_THRESHOLD) };
    const answer = { eventType: "output", content: "y".repeat(STEP_CONTENT_PREVIEW_THRESHOLD * 4) };
    expect(previewLargeStepContent(small)).toBe(small);
    expect(previewLargeStepContent(answer)).toBe(answer);
  });

  it("keeps whole lines of the head and tail of large output and reports what it left out", () => {
    const content = logLines(20_000);
    const preview = previewLargeStepContent({ id: "s1", eventType: "tool-result", content });
    expect(preview.content.length).toBeLessThan(STEP_CONTENT_PREVIEW_THRESHOLD);
    const omitted = preview.contentOmittedChars!;
    const marker = stepContentOmissionMarker(omitted);
    const [head, tail] = preview.content.split(marker);
    expect(content.startsWith(head!)).toBe(true);
    expect(content.endsWith(tail!)).toBe(true);
    expect(head!.length + omitted + tail!.length).toBe(content.length);
    expect(head!.endsWith("\n")).toBe(true);
    expect(tail!.startsWith("line ")).toBe(true);
    expect(preview).toMatchObject({ id: "s1", eventType: "tool-result" });
    // A preview is final; previewing it again changes nothing.
    expect(previewLargeStepContent(preview)).toBe(preview);
  });

  it("does not split a surrogate pair when the output has no line breaks", () => {
    const content = "😀".repeat(STEP_CONTENT_PREVIEW_THRESHOLD);
    const preview = previewLargeStepContent({ eventType: "tool-progress", content });
    const [head, tail] = preview.content.split(stepContentOmissionMarker(preview.contentOmittedChars!));
    expect(head!.length % 2).toBe(0);
    expect(tail!.length % 2).toBe(0);
    expect(head!.length + preview.contentOmittedChars! + tail!.length).toBe(content.length);
  });

  it("previews the step and event text of live events, but leaves others untouched", () => {
    const content = logLines(20_000);
    const step: RunStepRecord = { id: "s1", runId: "r1", eventType: "tool-result", title: "Tool", content, metadataJson: "{}", createdAt: "" };
    const event = withStepContentPreview({ runId: "r1", type: "tool-result" as const, title: "Tool", content, createdAt: "", step });
    expect(event.step.contentOmittedChars).toBeGreaterThan(0);
    expect(event.content).toBe(event.step.content);
    const small = { runId: "r1", type: "tool-result" as const, title: "Tool", content: "ok", createdAt: "", step: { ...step, content: "ok" } };
    expect(withStepContentPreview(small)).toBe(small);
    expect(previewLargeStepContents([small.step, step])[0]).toBe(small.step);
  });
});
