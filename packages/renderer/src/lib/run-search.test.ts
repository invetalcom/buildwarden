import { describe, expect, it } from "vitest";
import { parseSearchTerms, runMatchesSearch } from "./run-search";

describe("runMatchesSearch", () => {
  const run = { id: "run-1", prompt: "Fix the sidebar", goalText: "Keep it compact" };

  it("matches every term across the prompt and goal locally", () => {
    expect(runMatchesSearch(run, parseSearchTerms("sidebar COMPACT"))).toBe(true);
    expect(runMatchesSearch(run, parseSearchTerms("sidebar follow-up"))).toBe(false);
  });

  it("includes runs the host matched on follow-up input", () => {
    const terms = parseSearchTerms("follow-up");
    expect(runMatchesSearch(run, terms, null)).toBe(false);
    expect(runMatchesSearch(run, terms, new Set(["run-1"]))).toBe(true);
    expect(runMatchesSearch(run, terms, new Set(["run-2"]))).toBe(false);
  });
});
