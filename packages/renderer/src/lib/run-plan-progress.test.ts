import { describe, expect, it } from "vitest";
import { normalizeRunPlanStepStatus, parseRunPlanProgressStepsFromMarkdown } from "@buildwarden/shared";
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
  it("normalizes status variants case-insensitively", () => {
    expect(normalizeRunPlanStepStatus("Completed")).toBe("completed");
    expect(normalizeRunPlanStepStatus("DONE")).toBe("completed");
    expect(normalizeRunPlanStepStatus("IN_PROGRESS")).toBe("inProgress");
    expect(normalizeRunPlanStepStatus("in-progress")).toBe("inProgress");
    expect(normalizeRunPlanStepStatus("ACTIVE")).toBe("inProgress");
  });

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
  it("completes a stale final active step for a successful run without changing stored events", () => {
    const progressEvent = step("progress", "plan-progress", "", {
      provider: "ai-sdk",
      planProgress: {
        steps: [
          { title: "Implement", status: "completed" },
          { title: "Validate", status: "inProgress" },
        ],
      },
    });
    const originalMetadata = progressEvent.metadataJson;

    expect(deriveLatestRunPlanProgress([progressEvent], "code", "completed")?.steps).toEqual([
      { title: "Implement", status: "completed" },
      { title: "Validate", status: "completed" },
    ]);
    expect(progressEvent.metadataJson).toBe(originalMetadata);
    // Resuming the run restores the provider's progress until it sends an update.
    expect(deriveLatestRunPlanProgress([progressEvent], "code", "running")?.steps.at(-1)?.status).toBe("inProgress");
  });

  it.each(["queued", "preparing", "running", "failed", "cancelled"] as const)(
    "preserves the active final step for a %s run",
    (status) => {
      const progress = deriveLatestRunPlanProgress([
        step("progress", "plan-progress", "1. [x] Implement\n2. [-] Validate"),
      ], "code", status);
      expect(progress?.steps.at(-1)?.status).toBe("inProgress");
    },
  );

  it.each([
    ["pending", "inProgress"],
    ["inProgress", "inProgress"],
    ["completed", "pending"],
  ])("preserves unfinished checklists (%s, %s) after run completion", (firstStatus, lastStatus) => {
    const progress = deriveLatestRunPlanProgress([
      step("progress", "plan-progress", "", {
        planProgress: {
          steps: [
            { title: "Implement", status: firstStatus },
            { title: "Validate", status: lastStatus },
          ],
        },
      }),
    ], "code", "completed");
    expect(progress?.steps.map((planStep) => planStep.status)).toEqual([firstStatus, lastStatus]);
  });

  it("keeps a completed planning run's proposed checklist pending", () => {
    const progress = deriveLatestRunPlanProgress([
      step("plan", "plan-updated", "1. Implement\n2. Validate"),
    ], "plan", "completed");
    expect(progress?.steps.map((planStep) => planStep.status)).toEqual(["pending", "pending"]);
  });

  it.each(["plan", "ask"] as const)("preserves structured progress when a %s run completes", (mode) => {
    const progressEvent = step("progress", "plan-progress", "", {
      planProgress: { steps: [
        { title: "Inspect", status: "completed" },
        { title: "Implement", status: "inProgress" },
      ] },
    });
    const originalMetadata = progressEvent.metadataJson;
    for (const status of ["completed", "running", "completed"] as const) {
      expect(deriveLatestRunPlanProgress([progressEvent], mode, status)?.steps).toEqual([
        { title: "Inspect", status: "completed" },
        { title: "Implement", status: "inProgress" },
      ]);
    }
    expect(progressEvent.metadataJson).toBe(originalMetadata);
  });

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

  it("prefers structured Cursor plan-progress events over markdown fallback", () => {
    const progress = deriveLatestRunPlanProgress(
      [
        step("plan", "plan-updated", "1. Old plan\n2. Old renderer", { provider: "cursor-agent" }),
        step("progress", "plan-progress", "", {
          provider: "cursor-agent",
          planProgress: {
            explanation: "Cursor is working",
            steps: [
              { title: "Inspect ACP", status: "completed" },
              { title: "Wire renderer", status: "in_progress" },
            ],
          },
        }),
      ],
      "code",
    );

    expect(progress).toMatchObject({
      explanation: "Cursor is working",
      fallback: false,
      source: "cursor-acp",
      stepId: "progress",
      steps: [
        { title: "Inspect ACP", status: "completed" },
        { title: "Wire renderer", status: "inProgress" },
      ],
    });
  });

  it("maps Cursor provider plan metadata to the Cursor ACP source", () => {
    const progress = deriveLatestRunPlanProgress(
      [step("plan", "plan-updated", "1. Inspect ACP\n2. Update todos", { provider: "cursor-agent" })],
      "code",
    );

    expect(progress).toMatchObject({
      fallback: true,
      source: "cursor-acp",
      steps: [
        { title: "Inspect ACP", status: "pending" },
        { title: "Update todos", status: "pending" },
      ],
    });
  });

  describe("prompt turn scoping", () => {
    const plan = (id: string, statuses: string[]) =>
      step(id, "plan-progress", "", {
        provider: "claude-code",
        planProgress: { steps: statuses.map((status, index) => ({ title: `Step ${String(index + 1)}`, status })) },
      });
    const followUp = (id: string, metadata: Record<string, unknown> = {}) =>
      step(id, "log", "Next request", { source: "user", commandType: "follow-up", ...metadata });

    it("hides a finished plan once a follow-up prompt starts", () => {
      expect(deriveLatestRunPlanProgress([plan("p", ["completed", "completed"]), followUp("f")], "code", "running")).toBeNull();
    });

    it("hides a plan whose stale final step the ended turn already finished", () => {
      expect(deriveLatestRunPlanProgress([plan("p", ["completed", "in_progress"]), followUp("f")], "code", "running")).toBeNull();
    });

    it("shows the new turn's plan once the agent reports one", () => {
      const progress = deriveLatestRunPlanProgress(
        [plan("old", ["completed", "pending"]), followUp("f"), plan("new", ["in_progress", "pending"])],
        "code",
        "running",
      );
      expect(progress).toMatchObject({ stepId: "new", previousTurn: false });
    });

    it("keeps an unfinished plan from the previous prompt, marked as previous", () => {
      const progress = deriveLatestRunPlanProgress([plan("p", ["completed", "pending", "pending"]), followUp("f")], "code", "running");
      expect(progress).toMatchObject({ stepId: "p", previousTurn: true });
    });

    it("drops an unfinished plan after a second follow-up prompt", () => {
      expect(
        deriveLatestRunPlanProgress([plan("p", ["completed", "pending"]), followUp("f1"), followUp("f2")], "code", "running"),
      ).toBeNull();
    });

    it("does not carry a proposed plan over to the next prompt", () => {
      expect(
        deriveLatestRunPlanProgress(
          [step("plan", "plan-updated", "1. Add contracts\n2. Render pill", { provider: "codex-cli" }), followUp("f")],
          "plan",
          "running",
        ),
      ).toBeNull();
    });

    it.each([
      ["steered messages", { source: "user", commandType: "steer", steered: true }],
      ["goal updates", { source: "user", commandType: "goal" }],
      ["coordinator wakes", { source: "orchestration", commandType: "follow-up", orchestrationResume: true }],
      ["deferred task resumes", { source: "user", commandType: "follow-up", orchestrationResume: true, orchestrationTaskId: "task-1" }],
      ["auto-recovery turns", { source: "user", commandType: "follow-up", autoRecoveryKind: "azure-legacy" }],
    ])("keeps the current plan across %s", (_label, metadata) => {
      const progress = deriveLatestRunPlanProgress(
        [plan("p", ["completed", "completed"]), step("m", "log", "message", metadata)],
        "code",
        "running",
      );
      expect(progress).toMatchObject({ stepId: "p", previousTurn: false });
    });

    it("treats a message delivered to a delegated task as a new prompt", () => {
      const progress = deriveLatestRunPlanProgress(
        [
          plan("p", ["completed", "pending"]),
          followUp("f", { orchestrationResume: true, orchestrationTaskId: "task-1", orchestrationMessageIds: ["message-1"] }),
        ],
        "code",
        "running",
      );
      expect(progress).toMatchObject({ stepId: "p", previousTurn: true });
    });

    it("treats a user wake of a coordinator as a new prompt", () => {
      expect(
        deriveLatestRunPlanProgress(
          [plan("p", ["completed", "completed"]), followUp("f", { orchestrationResume: true, userWake: true })],
          "code",
          "running",
        ),
      ).toBeNull();
    });
  });

  it("does not infer progress from ordinary assistant output", () => {
    expect(
      deriveLatestRunPlanProgress([step("output", "output", "1. This is just an answer\n2. Not a plan", { source: "assistant" })], "code"),
    ).toBeNull();
  });
});
