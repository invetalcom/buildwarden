import { describe, expect, it } from "vitest";
import { isRunDisplayStatusActive, resolveRunDisplayStatus, runDisplayStatusTone, RUN_DISPLAY_STATUS_LABELS } from "./run-display-status";

describe("resolveRunDisplayStatus", () => {
  it.each(["completed", "failed", "cancelled"] as const)("shows an active follow-up after a %s orchestration", (orchestrationStatus) => {
    for (const status of ["queued", "preparing", "running"] as const) {
      expect(resolveRunDisplayStatus(status, orchestrationStatus)).toBe(status);
    }
  });

  it("preserves orchestration lifecycle statuses when the coordinator turn finishes", () => {
    expect(resolveRunDisplayStatus("completed", "waiting")).toBe("waiting");
    expect(resolveRunDisplayStatus("completed", "active")).toBe("running");
    expect(resolveRunDisplayStatus("completed", "attention")).toBe("attention");
    expect(resolveRunDisplayStatus("completed", "completed")).toBe("completed");
    expect(resolveRunDisplayStatus("running", "deleting")).toBe("deleting");
    expect(resolveRunDisplayStatus("running", "paused")).toBe("paused");
    expect(resolveRunDisplayStatus("running")).toBe("running");
  });

  it("preserves ordinary run statuses and maps orchestration-only presentation", () => {
    expect(resolveRunDisplayStatus("completed")).toBe("completed");
    expect(runDisplayStatusTone("waiting")).toBe("queued");
    expect(runDisplayStatusTone("attention")).toBe("failed");
    expect(RUN_DISPLAY_STATUS_LABELS.waiting).toBe("Waiting");
    expect(isRunDisplayStatusActive("waiting")).toBe(true);
    expect(isRunDisplayStatusActive("completed")).toBe(false);
  });
});
