import { describe, expect, it } from "vitest";
import { buildCodexPlanProgressChunk } from "../../../../packages/provider-codex-cli/src";

describe("Codex CLI plan progress", () => {
  it("maps turn plan updates to replaceable plan-progress chunks", () => {
    const chunk = buildCodexPlanProgressChunk({
      explanation: "Implementing the approved plan.",
      plan: [
        { step: "Update shared contracts", status: "completed" },
        { step: "Render progress pill", status: "inProgress" },
        { step: "Run validation", status: "pending" },
      ],
    });

    expect(chunk).toEqual({
      type: "plan-progress",
      title: "Plan progress",
      value: "Implementing the approved plan.\n\n1. [x] Update shared contracts\n2. [-] Render progress pill\n3. [ ] Run validation",
      metadata: {
        provider: "codex-cli",
        planProgress: {
          explanation: "Implementing the approved plan.",
          source: "codex",
          steps: [
            { title: "Update shared contracts", status: "completed" },
            { title: "Render progress pill", status: "inProgress" },
            { title: "Run validation", status: "pending" },
          ],
        },
        streamId: "codex-plan-progress",
        replace: true,
        rawPlanUpdate: {
          explanation: "Implementing the approved plan.",
          plan: [
            { step: "Update shared contracts", status: "completed" },
            { step: "Render progress pill", status: "inProgress" },
            { step: "Run validation", status: "pending" },
          ],
        },
      },
    });
  });
});
