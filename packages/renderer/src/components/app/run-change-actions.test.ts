import type { RunDetail } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { deriveRunChangeActionAvailability, resolveRunWorkspaceChangeState } from "./run-change-actions";

const changeDetail = (overrides: Partial<Pick<RunDetail, "diff" | "diffLoaded" | "diffSummary" | "diffSummaryPending">> = {}) => ({
  diff: "",
  diffLoaded: false,
  diffSummaryPending: false,
  ...overrides,
});

describe("run change actions", () => {
  it("recognizes summary changes without loading the full diff", () => {
    const changeState = resolveRunWorkspaceChangeState(changeDetail({
      diffSummary: {
        files: [{ path: "src/App.tsx", additions: 4, deletions: 1 }],
        totalFiles: 1,
        totalAdditions: 4,
        totalDeletions: 1,
      },
    }));

    expect(changeState).toBe("dirty");
    expect(deriveRunChangeActionAvailability({ changeState, hasCommit: false, canManageChanges: true })).toEqual({
      canCommit: true,
      canPublish: false,
      canCreateLocalBranch: true,
    });
  });

  it("does not trust a stale summary while its refresh is pending", () => {
    const changeState = resolveRunWorkspaceChangeState(changeDetail({
      diffSummaryPending: true,
      diffSummary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 },
    }));

    expect(changeState).toBe("unknown");
    expect(deriveRunChangeActionAvailability({ changeState, hasCommit: false, canManageChanges: true })).toEqual({
      canCommit: false,
      canPublish: false,
      canCreateLocalBranch: false,
    });
    expect(deriveRunChangeActionAvailability({ changeState, hasCommit: true, canManageChanges: true })).toEqual({
      canCommit: false,
      canPublish: false,
      canCreateLocalBranch: false,
    });
  });

  it("enables publishing only for a known clean workspace with an existing commit", () => {
    const cleanState = resolveRunWorkspaceChangeState(changeDetail({
      diffSummary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 },
    }));

    expect(cleanState).toBe("clean");
    expect(deriveRunChangeActionAvailability({ changeState: cleanState, hasCommit: true, canManageChanges: true })).toEqual({
      canCommit: false,
      canPublish: true,
      canCreateLocalBranch: true,
    });
  });

  it("falls back to the full diff only when no summary is available", () => {
    expect(resolveRunWorkspaceChangeState(changeDetail({
      diffLoaded: true,
      diff: "diff --git a/a.ts b/a.ts\n+change",
    }))).toBe("dirty");
    expect(resolveRunWorkspaceChangeState(changeDetail())).toBe("unknown");
  });
});
