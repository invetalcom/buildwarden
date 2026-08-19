import { describe, expect, it } from "vitest";
import { nextAutomationRunAt, parseAutomationCron, validateAutomationTimeZone } from "./automation-schedule";

describe("automation schedules", () => {
  it("accepts lists, ranges, and steps", () => {
    expect(() => parseAutomationCron("*/15 8-17 * * 1-5")).not.toThrow();
  });

  it("finds the next matching minute in the configured time zone", () => {
    expect(nextAutomationRunAt("30 9 * * *", "UTC", new Date("2026-08-19T09:29:45Z")))
      .toBe("2026-08-19T09:30:00.000Z");
  });

  it("rejects malformed schedules and time zones", () => {
    expect(() => parseAutomationCron("every day")).toThrow(/five-field/);
    expect(() => validateAutomationTimeZone("Mars/Olympus")).toThrow(/Unknown time zone/);
  });
});
