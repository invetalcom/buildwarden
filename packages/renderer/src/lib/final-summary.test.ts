import { describe, expect, it } from "vitest";
import { dedupeFinalSummarySteps, finalSummaryRepeatsTurn, latestTurnAnswerTexts, type RunStepRecord } from "@buildwarden/shared";

const step = (
  id: string,
  eventType: RunStepRecord["eventType"],
  content: string,
  metadata: Record<string, unknown> = {},
  title = "Agent output",
): RunStepRecord => ({
  id,
  runId: "r1",
  eventType,
  title,
  content,
  metadataJson: JSON.stringify(metadata),
  createdAt: "2026-11-26T10:00:00.000Z",
});

const summaryStep = (id: string, content: string) => step(id, "output", content, { assistantKind: "final-summary" }, "Final summary");
const turnStart = (id: string, commandType: "initial" | "follow-up" = "follow-up") =>
  step(id, "log", "next request", { source: "user", commandType }, "Follow-up command");

const FINAL = "All done. The cards are redesigned.";
const ids = (steps: RunStepRecord[]) => steps.map((entry) => entry.id);

describe("dedupeFinalSummarySteps", () => {
  it("drops a final-summary step that repeats the assistant message before it", () => {
    expect(ids(dedupeFinalSummarySteps([step("a", "output", FINAL), summaryStep("b", FINAL)]))).toEqual(["a"]);
  });

  it("ignores whitespace and line-break differences when comparing", () => {
    const steps = [step("a", "output", "All done.\n\nThe cards   are redesigned."), summaryStep("b", FINAL)];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a"]);
  });

  it("drops a summary that runs all of the turn's messages together", () => {
    const steps = [
      turnStart("u"),
      step("a", "output", "I'll update the header first."),
      step("t", "tool-call", "edit_file", { toolName: "edit_file" }, "Tool call: edit_file"),
      step("b", "output", "Done — the header is redesigned.\n\n- new badge"),
      summaryStep("s", "I'll update the header first.Done — the header is redesigned.\n\n- new badge"),
    ];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["u", "a", "t", "b"]);
  });

  it("drops such a summary when it was cut short", () => {
    const steps = [step("a", "output", "First message."), step("b", "output", "Second, much longer message."), summaryStep("s", "First message.Second, much")];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a", "b"]);
  });

  it("only compares with messages of the same turn", () => {
    const steps = [step("a", "output", FINAL), turnStart("u"), summaryStep("s", FINAL)];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a", "u", "s"]);
  });

  it("keeps a final-summary step that says something new", () => {
    const steps = [step("a", "output", FINAL), summaryStep("b", "Follow-up: run npm start to preview.")];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a", "b"]);
  });

  it("keeps a repeated assistant message that is not marked as a final summary", () => {
    expect(ids(dedupeFinalSummarySteps([step("a", "output", FINAL), step("b", "output", FINAL)]))).toEqual(["a", "b"]);
  });

  it("does not count reasoning or subagent text as the turn's answers", () => {
    const steps = [
      step("a", "output", FINAL),
      step("r", "output", "thinking out loud", { assistantKind: "reasoning" }, "Reasoning"),
      step("c", "output", "subagent report", { subagentId: "child-1" }),
      summaryStep("b", FINAL),
    ];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a", "r", "c"]);
  });

  it("compares the source text of answers that embed images", () => {
    const steps = [
      step("a", "output", "![shot](data:image/png;base64,AAAA)", { responseSourceText: "![shot](shot.png)" }),
      step("s", "output", "![shot](data:image/png;base64,AAAA)", { assistantKind: "final-summary", responseSourceText: "![shot](shot.png)" }, "Final summary"),
    ];
    expect(ids(dedupeFinalSummarySteps(steps))).toEqual(["a"]);
  });

  it("survives malformed metadata", () => {
    const broken: RunStepRecord = { ...step("a", "output", FINAL), metadataJson: "{not json" };
    expect(ids(dedupeFinalSummarySteps([broken]))).toEqual(["a"]);
  });
});

describe("finalSummaryRepeatsTurn", () => {
  it("needs an answer in the turn to compare with", () => {
    expect(finalSummaryRepeatsTurn(FINAL, [])).toBe(false);
    expect(finalSummaryRepeatsTurn("   ", [FINAL])).toBe(false);
  });

  it("matches the last answer alone", () => {
    expect(finalSummaryRepeatsTurn("Second.", ["First.", "Second."])).toBe(true);
  });

  it("matches the last few answers run together when earlier ones are left out", () => {
    expect(finalSummaryRepeatsTurn("Retry start.Done.", ["First try.", "Retry start.", "Done."])).toBe(true);
    expect(finalSummaryRepeatsTurn("Retry start.Do", ["First try.", "Retry start.", "Done."])).toBe(true);
  });

  it("does not match a summary that only shares the turn's last words", () => {
    expect(finalSummaryRepeatsTurn("Summary: Second.", ["First.", "Second."])).toBe(false);
  });
});

describe("latestTurnAnswerTexts", () => {
  it("returns the answers after the last turn start, without summaries or reasoning", () => {
    const steps = [
      step("old", "output", "previous turn"),
      turnStart("u"),
      step("a", "output", "first"),
      step("r", "output", "thinking", { assistantKind: "reasoning" }, "Reasoning"),
      step("b", "output", "second"),
      summaryStep("s", "firstsecond"),
    ];
    expect(latestTurnAnswerTexts(steps)).toEqual(["first", "second"]);
  });
});
