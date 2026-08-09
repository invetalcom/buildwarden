import type { RunDeletionImpact } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { buildRunDeletionPlan } from "./run-deletion-plan";

const impact = (overrides: Partial<RunDeletionImpact> = {}): RunDeletionImpact => ({
  runId: "coordinator",
  coordinatorRunId: "coordinator",
  orchestrationId: "orchestration-1",
  runIds: ["coordinator", "child"],
  runningRunIds: ["child"],
  ownedDirectories: ["C:/repo/coordinator", "C:/repo/child"],
  branches: ["feat/coordinator", "feat/child"],
  artifactPaths: ["C:/artifacts/orchestration-1"],
  lockedOrMissingPaths: [],
  ...overrides,
});

describe("buildRunDeletionPlan", () => {
  it("collapses a selected coordinator and child into one coordinator deletion", () => {
    const plan = buildRunDeletionPlan([
      impact(),
      impact({ runId: "child" }),
    ]);

    expect(plan.targetRunIds).toEqual(["coordinator"]);
    expect([...plan.affectedRunIds]).toEqual(["coordinator", "child"]);
    expect(plan.runningRunIds.size).toBe(1);
    expect(plan.ownedDirectories.size).toBe(2);
  });

  it("keeps independent runs as separate deletion targets", () => {
    const standalone = impact({
      runId: "standalone",
      coordinatorRunId: "standalone",
      orchestrationId: null,
      runIds: ["standalone"],
      runningRunIds: [],
      ownedDirectories: ["C:/repo/standalone"],
      branches: ["feat/standalone"],
      artifactPaths: [],
    });
    const plan = buildRunDeletionPlan([impact(), standalone]);

    expect(plan.targetRunIds).toEqual(["coordinator", "standalone"]);
    expect(plan.affectedRunIds.size).toBe(3);
  });
});
