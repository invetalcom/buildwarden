import { describe, expect, it } from "vitest";
import {
  ORCHESTRATION_COORDINATOR_PROMPT,
  buildOrchestrationAwarePrompt,
} from "./orchestration-tools";

describe("orchestration coordinator prompt", () => {
  it("leaves ordinary and child-run prompts unchanged when orchestration tools are unavailable", () => {
    const prompt = "Fix the failing unit test.";

    expect(buildOrchestrationAwarePrompt(prompt, false)).toBe(prompt);
  });

  it("adds selective durable-orchestration guidance when orchestration is enabled", () => {
    const prompt = buildOrchestrationAwarePrompt("Inspect the renderer and improve it.", true);

    expect(prompt).toContain(ORCHESTRATION_COORDINATOR_PROMPT);
    expect(prompt).toContain("<user_request>\nInspect the renderer and improve it.\n</user_request>");
    expect(prompt).toContain("The user does not need to explicitly request delegation");
    expect(prompt).toContain("Do not delegate trivial work");
    expect(prompt).toContain("buildwarden_orchestration_get");
    expect(prompt).toContain("buildwarden_tasks_delegate");
    expect(prompt).toContain("buildwarden_orchestration_yield");
    expect(prompt).toContain("Do not poll with shell sleeps");
  });
});
