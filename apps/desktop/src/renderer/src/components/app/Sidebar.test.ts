import { describe, expect, it } from "vitest";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";

describe("Sidebar recent run ordering", () => {
  it("uses the latest user input timestamp instead of run activity updates", () => {
    const olderPromptButNewerActivity = {
      createdAt: "2026-05-31T10:00:00.000Z",
      updatedAt: "2026-05-31T10:30:00.000Z",
      lastUserInputAt: "2026-05-31T10:00:00.000Z",
    };
    const newerPromptButOlderActivity = {
      createdAt: "2026-05-31T10:05:00.000Z",
      updatedAt: "2026-05-31T10:06:00.000Z",
      lastUserInputAt: "2026-05-31T10:05:00.000Z",
    };

    const sorted = [olderPromptButNewerActivity, newerPromptButOlderActivity].sort(
      (left, right) => recentRunOrderTimestamp(right) - recentRunOrderTimestamp(left),
    );

    expect(sorted[0]).toBe(newerPromptButOlderActivity);
  });
});
