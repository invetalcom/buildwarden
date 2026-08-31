import { describe, expect, it } from "vitest";
import { advanceReportedTokenUsage } from "./token-usage-accounting";

describe("advanceReportedTokenUsage", () => {
  it("adds a fresh worker turn to the owner's previously persisted usage", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 80, outputTokens: 10 },
    )).toEqual({
      inputTokensDelta: 80,
      outputTokensDelta: 10,
      nextReportedUsage: { inputTokens: 80, outputTokens: 10 },
    });
  });

  it("records only the increase between streamed reports from the same worker turn", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 140, outputTokens: 25 },
      { inputTokens: 40, outputTokens: 5 },
      { inputTokens: 80, outputTokens: 10 },
    )).toEqual({
      inputTokensDelta: 40,
      outputTokensDelta: 5,
      nextReportedUsage: { inputTokens: 80, outputTokens: 10 },
    });
  });

  it("subtracts a resumed provider session baseline before recording new usage", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 180, outputTokens: 30 },
    )).toEqual({
      inputTokensDelta: 80,
      outputTokensDelta: 10,
      nextReportedUsage: { inputTokens: 180, outputTokens: 30 },
    });
  });

  it("never subtracts tokens when a provider reports a lower corrected total", () => {
    expect(advanceReportedTokenUsage(
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 80, outputTokens: 10 },
      { inputTokens: 70, outputTokens: 8 },
    )).toEqual({
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      nextReportedUsage: { inputTokens: 80, outputTokens: 10 },
    });
  });
});
