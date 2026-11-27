import { describe, expect, it } from "vitest";
import type { RunStepRecord } from "@buildwarden/shared";
import { withRunFailureStep } from "./run-failure-step";

const run = {
  id: "run-1",
  status: "failed" as const,
  errorMessage: "Command `pnpm build` exited with code 1.",
  finishedAt: "2026-11-27T10:00:00.000Z",
  updatedAt: "2026-11-27T10:00:01.000Z",
};

const step = (eventType: RunStepRecord["eventType"], content: string, title = "Step"): RunStepRecord => ({
  id: `${eventType}-${content.length}`,
  runId: run.id,
  eventType,
  title,
  content,
  metadataJson: "{}",
  createdAt: "2026-11-27T09:59:00.000Z",
});

describe("withRunFailureStep", () => {
  it("adds the stored reason as a closing error step when no step shows it", () => {
    const steps = [step("output", "Working on it.")];
    const result = withRunFailureStep(run, steps);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ eventType: "error", title: "Run failed", content: run.errorMessage, createdAt: run.finishedAt });
  });

  it("keeps the steps when an error step already carries the reason", () => {
    const steps = [step("error", `Run could not start\n${run.errorMessage}`)];
    expect(withRunFailureStep(run, steps)).toBe(steps);
  });

  it("adds the reason when only an unrelated error step exists", () => {
    const steps = [step("error", "A tool call timed out.")];
    expect(withRunFailureStep(run, steps)).toHaveLength(2);
  });

  it("adds the reason when an error step holds only part of it", () => {
    const failed = { ...run, errorMessage: "Command exited with code 127: executable not found" };
    const steps = [step("error", "Command exited with code 1")];
    expect(withRunFailureStep(failed, steps)).toHaveLength(2);
  });

  it("leaves runs alone that did not fail or have no reason", () => {
    const steps = [step("output", "Done.")];
    expect(withRunFailureStep({ ...run, status: "completed" }, steps)).toBe(steps);
    expect(withRunFailureStep({ ...run, errorMessage: "  " }, steps)).toBe(steps);
    expect(withRunFailureStep({ ...run, errorMessage: null }, steps)).toBe(steps);
  });

  it("falls back to the update time when the run has no finish time", () => {
    const result = withRunFailureStep({ ...run, finishedAt: null }, []);
    expect(result[0]?.createdAt).toBe(run.updatedAt);
  });
});
