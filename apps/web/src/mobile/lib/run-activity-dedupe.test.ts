import { describe, expect, it } from "vitest";
import type { RunStepRecord } from "@buildwarden/shared";
import {
  dedupeFinalSummarySteps,
  finalAssistantStep,
  latestAssistantOutputText,
  summaryDuplicatesTranscript,
} from "./run-activity-dedupe";

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

describe("dedupeFinalSummarySteps", () => {
  it("drops a final-summary step that repeats the assistant message before it", () => {
    const steps = [
      step("a", "output", FINAL),
      step("b", "output", FINAL, { assistantKind: "final-summary" }, "Final summary"),
    ];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("ignores whitespace and line-break differences when comparing", () => {
    const steps = [
      step("a", "output", "All done.\n\nThe cards   are redesigned."),
      step("b", "output", "All done. The cards are redesigned.", { assistantKind: "final-summary" }),
    ];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["a"]);
  });

  it("keeps a final-summary step that says something new", () => {
    const steps = [
      step("a", "output", FINAL),
      step("b", "output", "Follow-up: run npm start to preview.", { assistantKind: "final-summary" }),
    ];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("keeps a repeated assistant message that is not marked as a final summary", () => {
    const steps = [step("a", "output", FINAL), step("b", "output", FINAL)];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not treat reasoning as the previous assistant message", () => {
    const steps = [
      step("a", "output", FINAL),
      step("r", "output", "thinking out loud", { assistantKind: "reasoning" }, "Reasoning"),
      step("b", "output", FINAL, { assistantKind: "final-summary" }),
    ];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["a", "r"]);
  });

  it("leaves tool and status steps untouched", () => {
    const steps = [
      step("t", "tool-call", "", { toolName: "run_shell" }, "run_shell"),
      step("s", "status", "", {}, "Run completed"),
    ];
    expect(dedupeFinalSummarySteps(steps).map((entry) => entry.id)).toEqual(["t", "s"]);
  });

  it("survives malformed metadata", () => {
    const broken: RunStepRecord = { ...step("a", "output", FINAL), metadataJson: "{not json" };
    expect(dedupeFinalSummarySteps([broken]).map((entry) => entry.id)).toEqual(["a"]);
  });
});

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

describe("latestAssistantOutputText", () => {
  it("returns the last non-reasoning assistant message", () => {
    const steps = [
      step("a", "output", "first"),
      step("b", "output", "second"),
      step("r", "output", "thinking", { assistantKind: "reasoning" }, "Reasoning"),
      step("s", "status", "", {}, "Run completed"),
    ];
    expect(latestAssistantOutputText(steps)).toBe("second");
  });

  it("returns an empty string when the run produced no assistant output", () => {
    expect(latestAssistantOutputText([step("s", "status", "", {}, "Run completed")])).toBe("");
  });
});

describe("summaryDuplicatesTranscript", () => {
  const steps = [step("a", "output", FINAL)];

  it("is true when the summary repeats the closing message", () => {
    expect(summaryDuplicatesTranscript(FINAL, steps)).toBe(true);
    expect(summaryDuplicatesTranscript(`  ${FINAL}\n`, steps)).toBe(true);
  });

  it("is false when the summary adds something", () => {
    expect(summaryDuplicatesTranscript("Redesigned the kanban cards only.", steps)).toBe(false);
  });

  it("treats a missing or blank summary as nothing to show", () => {
    expect(summaryDuplicatesTranscript(null, steps)).toBe(true);
    expect(summaryDuplicatesTranscript("   ", steps)).toBe(true);
  });
});
