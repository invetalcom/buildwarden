import { describe, expect, it } from "vitest";
import { estimateContextWindow } from "./context-window-estimate";

describe("estimateContextWindow", () => {
  it("renders a cheap heuristic before exact tokenizer counts arrive", () => {
    const estimate = estimateContextWindow({
      modelIds: ["gpt-5"],
      prompt: "12345678",
      historyText: "1234",
    });

    expect(estimate?.usedTokens).toBe(303);
  });

  it("replaces only text estimates with exact worker counts", () => {
    const estimate = estimateContextWindow({
      modelIds: ["gpt-5"],
      prompt: "ignored by exact count",
      historyText: "also ignored",
      isRun: true,
      textTokenCounts: { prompt: 19, history: 31 },
    });

    expect(estimate?.usedTokens).toBe(1_450);
  });
});
