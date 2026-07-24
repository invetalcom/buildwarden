import { describe, expect, it } from "vitest";
import {
  isRunDisplayStatusActive,
  resolveRunDisplayStatus,
  runDisplayStatusTone,
  RUN_DISPLAY_STATUS_LABELS,
} from "./run-display-status";

describe("run display status", () => {
  it("shows the durable orchestration lifecycle over an idle provider turn", () => {
    expect(resolveRunDisplayStatus("completed", "waiting")).toBe("waiting");
    expect(resolveRunDisplayStatus("completed", "active")).toBe("running");
    expect(resolveRunDisplayStatus("completed", "attention")).toBe("attention");
    expect(resolveRunDisplayStatus("completed", "completed")).toBe("completed");
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
