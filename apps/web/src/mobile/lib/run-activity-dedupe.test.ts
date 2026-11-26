import { describe, expect, it } from "vitest";
import type { RunStepRecord } from "@buildwarden/shared";
import { finalAssistantStep, summaryDuplicatesTranscript } from "./run-activity-dedupe";

const step = (
  id: string,
  eventType: RunStepRecord["eventType"],
  content: string,
  metadata: Record<string, unknown> = {},
  title = "Assistant",
): RunStepRecord => ({
  id,
  runId: "r1",
  eventType,
  title,
  content,
  metadataJson: JSON.stringify(metadata),
  createdAt: "2026-07-27T10:00:00.000Z",
});

const FINAL = "All done. The cards are redesigned.";

describe("finalAssistantStep", () => {
  it("picks the last assistant message, skipping reasoning, status and tool steps", () => {
    const steps = [
      step("a", "output", "first"),
      step("b", "output", "second"),
      step("r", "output", "thinking", { assistantKind: "reasoning" }, "Reasoning"),
      step("t", "tool-result", "shell output", { toolName: "run_shell" }, "run_shell"),
      step("s", "status", "", {}, "Run completed"),
    ];
    expect(finalAssistantStep(steps)?.id).toBe("b");
  });

  it("skips empty assistant messages so the callout never lands on a blank step", () => {
    const steps = [step("a", "output", "real answer"), step("b", "output", "   ")];
    expect(finalAssistantStep(steps)?.id).toBe("a");
  });

  it("returns null when the run produced no assistant output", () => {
    expect(finalAssistantStep([step("s", "status", "", {}, "Run completed")])).toBeNull();
  });
});

describe("summaryDuplicatesTranscript", () => {
  const steps = [step("a", "output", FINAL)];

  it("is true when the summary repeats the closing message", () => {
    expect(summaryDuplicatesTranscript(FINAL, steps)).toBe(true);
    expect(summaryDuplicatesTranscript(`  ${FINAL}\n`, steps)).toBe(true);
  });

  it("is true when the summary runs the latest turn's messages together", () => {
    const turn = [step("a", "output", "Looking at the cards."), step("b", "output", FINAL)];
    expect(summaryDuplicatesTranscript(`Looking at the cards.${FINAL}`, turn)).toBe(true);
  });

  it("is true when a kept final-summary step already shows the summary", () => {
    const turn = [
      step("a", "output", FINAL),
      step("s", "output", "![shot](data:image/png;base64,AAAA) Preview it with npm start.", {
        assistantKind: "final-summary",
        responseSourceText: "![shot](shot.png) Preview it with npm start.",
      }, "Final summary"),
    ];
    expect(summaryDuplicatesTranscript("![shot](shot.png) Preview it with npm start.", turn)).toBe(true);
  });

  it("is false when the summary adds something", () => {
    expect(summaryDuplicatesTranscript("Redesigned the kanban cards only.", steps)).toBe(false);
  });

  it("treats a missing or blank summary as nothing to show", () => {
    expect(summaryDuplicatesTranscript(null, steps)).toBe(true);
    expect(summaryDuplicatesTranscript("   ", steps)).toBe(true);
  });
});
