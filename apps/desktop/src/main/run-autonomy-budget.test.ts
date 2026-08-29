import { describe, expect, it } from "vitest";
import { timeBudgetExhaustion, tokenBudgetExhaustion } from "./run-autonomy-budget";

describe("run autonomy budget", () => {
  it("stays inactive when unlimited or below the token ceiling", () => {
    expect(tokenBudgetExhaustion(0, { inputTokens: 100, outputTokens: 100 })).toBeNull();
    expect(tokenBudgetExhaustion(1_000, { inputTokens: 700, outputTokens: 299 })).toBeNull();
  });

  it("exhausts at the combined input and output token ceiling", () => {
    expect(tokenBudgetExhaustion(1_000, { inputTokens: 700, outputTokens: 300 })).toEqual({
      kind: "tokens",
      limit: 1_000,
      observed: 1_000,
      reason: "This turn used 1,000 tokens and reached its 1,000 token autonomy limit.",
    });
  });

  it("describes wall-clock exhaustion", () => {
    expect(timeBudgetExhaustion(45)).toMatchObject({ kind: "time", limit: 45, observed: 45 });
  });
});
