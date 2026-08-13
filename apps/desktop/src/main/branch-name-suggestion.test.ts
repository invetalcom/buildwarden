import { describe, expect, it } from "vitest";
import { normalizeSuggestedBranchName } from "./branch-name-suggestion";

describe("normalizeSuggestedBranchName", () => {
  it("unwraps a labeled branch suggestion", () => {
    expect(normalizeSuggestedBranchName("Branch name: `feat/redesign-kanban-cards`")).toBe("feat/redesign-kanban-cards");
  });

  it("normalizes model prose into a Git-safe branch name", () => {
    expect(normalizeSuggestedBranchName("```text\nFix/Crème brûlée: cards?\n```")).toBe("fix/creme-brulee-cards");
  });

  it("removes invalid path segments and suffixes", () => {
    expect(normalizeSuggestedBranchName("../feat//cards.lock.")).toBe("feat/cards-lock");
  });
});
