import {
  automationStepConditionHolds,
  automationStepValues,
  createAutomationStepState,
  parseAutomationCheckAnswer,
  parseAutomationTrigger,
  parseAutomationWorkflow,
  readStoredAutomationWorkflow,
  validateAutomationWorkflow,
  type AutomationStepDefinition,
  type AutomationWorkflowDefinition,
} from "@buildwarden/shared";
import { describe, expect, it } from "vitest";

const ask = (id: string, choices = ["Upgrade", "Skip"]): AutomationStepDefinition => ({
  id, when: null, kind: "ask", title: "Upgrade?", detail: "", choices, requireReason: false, timeoutHours: null, timeoutChoice: null,
});

describe("automation workflow definitions", () => {
  it("reads stored steps and fills in safe defaults", () => {
    const definition = parseAutomationWorkflow(JSON.stringify({
      check: " Did you find outdated dependencies? ",
      steps: [
        { id: "a", kind: "ask", title: "Upgrade?", choices: ["Upgrade", "Skip", "Upgrade", ""], timeoutHours: 5, timeoutChoice: "Skip" },
        { id: "b", kind: "agent", prompt: "Upgrade them", when: { stepId: "a", equals: "Upgrade" } },
        { id: "c", kind: "wait", minutes: -4 },
        { id: "d", kind: "merge-pr", method: "fast-forward" },
      ],
    }));
    expect(definition.check).toBe("Did you find outdated dependencies?");
    expect(definition.steps[0]).toMatchObject({ kind: "ask", choices: ["Upgrade", "Skip"], timeoutHours: 5, timeoutChoice: "Skip" });
    expect(definition.steps[1]).toMatchObject({ kind: "agent", workspace: "continue", check: null, when: { stepId: "a", equals: "Upgrade" } });
    expect(definition.steps[2]).toMatchObject({ kind: "wait", minutes: 60 });
    expect(definition.steps[3]).toMatchObject({ kind: "merge-pr", method: "squash" });
  });

  it("rejects unknown step types when saving but keeps reading stored rows", () => {
    expect(() => parseAutomationWorkflow({ steps: [{ kind: "deploy" }] })).toThrow("Step 2 has an unknown type.");
    expect(readStoredAutomationWorkflow('{"steps":[{"kind":"deploy"}]}')).toEqual({ check: null, steps: [] });
    expect(readStoredAutomationWorkflow("")).toEqual({ check: null, steps: [] });
  });

  it("explains what has to be fixed before saving", () => {
    const valid: AutomationWorkflowDefinition = {
      check: "Outdated?",
      steps: [
        { ...ask("approve"), when: { stepId: "prompt", equals: "yes" } },
        { id: "fix", when: { stepId: "approve", equals: "Upgrade" }, kind: "agent", prompt: "Upgrade", workspace: "continue", check: null },
        { id: "pr", when: null, kind: "open-pr", title: "" },
        { id: "checks", when: null, kind: "wait-pr", until: "checks", timeoutHours: 2 },
        { id: "merge", when: { stepId: "checks", equals: "passing" }, kind: "merge-pr", method: "squash" },
      ],
    };
    expect(validateAutomationWorkflow(valid, { gitProject: true })).toBeNull();
    expect(validateAutomationWorkflow(valid, { gitProject: false })).toBe("Step 4 needs a Git project.");
    expect(validateAutomationWorkflow({ check: null, steps: [{ ...ask("x"), when: { stepId: "prompt", equals: "yes" } }] }, { gitProject: true }))
      .toBe("Step 2 waits for an answer its earlier step cannot give.");
    expect(validateAutomationWorkflow({ check: null, steps: [{ ...ask("x"), when: { stepId: "later", equals: "Upgrade" } }, ask("later")] }, { gitProject: true }))
      .toBe("Step 2 depends on a step that does not come before it.");
    expect(validateAutomationWorkflow({ check: null, steps: [ask("x", ["Only"])] }, { gitProject: true })).toBe("Step 2 needs at least two answers.");
    expect(validateAutomationWorkflow({ check: null, steps: [{ id: "m", when: null, kind: "merge-pr", method: "squash" }] }, { gitProject: true }))
      .toBe('Step 2 needs an "Open pull request" step before it.');
  });

  it("lists the values later steps can wait for", () => {
    expect(automationStepValues({ kind: "agent", check: null })).toEqual(["done"]);
    expect(automationStepValues({ kind: "agent", check: "Done?" })).toEqual(["yes", "no"]);
    expect(automationStepValues(ask("a", ["A", "B", "C"]))).toEqual(["A", "B", "C"]);
    expect(automationStepValues({ id: "c", when: null, kind: "council", fixFindings: true })).toEqual(["clean", "fixed"]);
  });

  it("holds a condition only for a finished step with that value", () => {
    const done = { ...createAutomationStepState("a", "ask"), status: "done" as const, value: "Upgrade" };
    const skipped = { ...createAutomationStepState("b", "ask"), status: "skipped" as const };
    expect(automationStepConditionHolds(null, [])).toBe(true);
    expect(automationStepConditionHolds({ stepId: "a", equals: "Upgrade" }, [done])).toBe(true);
    expect(automationStepConditionHolds({ stepId: "a", equals: "Skip" }, [done])).toBe(false);
    expect(automationStepConditionHolds({ stepId: "b", equals: "Upgrade" }, [skipped])).toBe(false);
  });

  it("reads the last answer line of a checked agent step", () => {
    expect(parseAutomationCheckAnswer("I found three.\n\nANSWER: yes")).toBe("yes");
    expect(parseAutomationCheckAnswer("**ANSWER:** No")).toBe("no");
    expect(parseAutomationCheckAnswer("ANSWER: yes\nOn second thought…\nANSWER: no")).toBe("no");
    expect(parseAutomationCheckAnswer("The answer is yes")).toBeNull();
  });

  it("falls back to the schedule for unknown triggers", () => {
    expect(parseAutomationTrigger("not json")).toEqual({ kind: "schedule" });
    expect(parseAutomationTrigger({ kind: "issue-labelled", label: " ready " })).toEqual({ kind: "issue-labelled", label: "ready" });
    expect(parseAutomationTrigger({ kind: "automation-finished", automationId: "a", outcome: "weird" }))
      .toEqual({ kind: "automation-finished", automationId: "a", outcome: "any" });
  });
});
