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

  it("treats */1 as a wildcard in both day fields", () => {
    expect(nextAutomationRunAt("0 9 */1 * 1-5", "UTC", new Date("2026-08-21T09:00:00Z")))
      .toBe("2026-08-24T09:00:00.000Z");
    expect(nextAutomationRunAt("0 9 15 * */1", "UTC", new Date("2026-08-10T09:00:00Z")))
      .toBe("2026-08-15T09:00:00.000Z");
  });

  it("rejects malformed schedules and time zones", () => {
    expect(() => parseAutomationCron("every day")).toThrow(/five-field/);
    expect(() => validateAutomationTimeZone("Mars/Olympus")).toThrow(/Unknown time zone/);
  });
});
