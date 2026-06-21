import { describe, expect, it } from "vitest";
import {
  computeNextAutomationRunAt,
  normalizeAutomationGuardrails,
  normalizeAutomationTrigger,
  renderAutomationTemplate,
} from "@buildwarden/shared";

describe("automation helpers", () => {
  it("renders known template variables and blanks unknown variables", () => {
    expect(
      renderAutomationTemplate("Review {{ pr.title }} in {{project.name}} / {{missing}}", {
        "pr.title": "Fix auth",
        "project.name": "API",
      }),
    ).toBe("Review Fix auth in API / ");
  });

  it("normalizes guardrails into bounded defaults", () => {
    expect(normalizeAutomationGuardrails({ maxConcurrentRuns: -2, dailyRunLimit: 0, accessMode: "full-access" })).toMatchObject({
      maxConcurrentRuns: 1,
      dailyRunLimit: 1,
      accessMode: "full-access",
      requireExternalWriteConfirmation: true,
    });
  });

  it("computes interval and daily next run times", () => {
    expect(
      computeNextAutomationRunAt(
        normalizeAutomationTrigger({ type: "schedule", mode: "interval", intervalMinutes: 30 }),
        new Date("2026-06-20T08:00:00.000Z"),
      ),
    ).toBe("2026-06-20T08:30:00.000Z");

    const from = new Date(2026, 5, 20, 10, 0, 0, 0);
    const nextDaily = computeNextAutomationRunAt(
      normalizeAutomationTrigger({ type: "schedule", mode: "daily", dailyTime: "09:15" }),
      from,
    );
    const nextDate = new Date(nextDaily ?? "");
    expect(nextDate.getHours()).toBe(9);
    expect(nextDate.getMinutes()).toBe(15);
    expect(nextDate.getDate()).toBe(21);
  });
});
