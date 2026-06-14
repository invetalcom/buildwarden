import { describe, expect, it } from "vitest";
import { parseRunPlanProgressStepsFromMarkdown } from "@buildwarden/shared";
import { deriveLatestRunPlanProgress, type RunPlanProgressStepLike } from "./run-plan-progress";

const step = (
  id: string,
  eventType: RunPlanProgressStepLike["eventType"],
  content: string,
  metadata: Record<string, unknown> = {},
): RunPlanProgressStepLike => ({
  id,
  eventType,
  content,
  metadataJson: JSON.stringify(metadata),
  createdAt: "2026-06-14T10:00:00.000Z",
});

describe("run plan progress markdown parsing", () => {
  it("parses compact checkbox progress with status inference", () => {
    expect(
      parseRunPlanProgressStepsFromMarkdown(
        ["1. [x] Inspect contracts", "2. [-] Patch provider", "3. [ ] Render pill"].join("\n"),
        { inferStatus: true },
      ),
    ).toEqual([
      { title: "Inspect contracts", status: "completed" },
      { title: "Patch provider", status: "inProgress" },
      { title: "Render pill", status: "pending" },
    ]);
  });

  it("parses plan tables as pending fallback steps", () => {
    expect(
      parseRunPlanProgressStepsFromMarkdown(
        ["| # | Step | Files |", "| - | ---- | ----- |", "| 1 | Add contracts | shared |", "| 2 | Render header | renderer |"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { title: "Add contracts", status: "pending" },
      { title: "Render header", status: "pending" },
    ]);
  });
});

describe("deriveLatestRunPlanProgress", () => {
  it("prefers the latest structured plan-progress event", () => {
    const progress = deriveLatestRunPlanProgress(
      [
        step("plan", "plan-updated", "1. Old plan\n2. Old renderer", { provider: "codex-cli" }),
        step("progress", "plan-progress", "", {
          provider: "claude-code",
          planProgress: {
            explanation: "Working through it",
            steps: [
              { title: "Inspect", status: "completed" },
              { title: "Implement", status: "in_progress" },
            ],
          },
        }),
      ],
      "code",
    );

    expect(progress).toMatchObject({
      explanation: "Working through it",
      fallback: false,
      source: "claude",
      stepId: "progress",
      steps: [
        { title: "Inspect", status: "completed" },
        { title: "Implement", status: "inProgress" },
      ],
    });
  });

  it("derives a pending fallback checklist from proposed plan markdown", () => {
    const progress = deriveLatestRunPlanProgress(
      [step("plan", "plan-updated", "1. Add contracts\n2. Render progress pill", { provider: "codex-cli" })],
      "code",
    );

    expect(progress).toMatchObject({
      fallback: true,
      source: "codex",
      steps: [
        { title: "Add contracts", status: "pending" },
        { title: "Render progress pill", status: "pending" },
      ],
    });
  });

  it("does not infer progress from ordinary assistant output", () => {
    expect(
      deriveLatestRunPlanProgress([step("output", "output", "1. This is just an answer\n2. Not a plan", { source: "assistant" })], "code"),
    ).toBeNull();
  });
});
