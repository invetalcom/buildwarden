import { describe, expect, it, vi } from "vitest";
import { nextAutomationRunAt, parseAutomationCron, validateAutomationTimeZone } from "./automation-schedule";

describe("automation schedules", () => {
  it.each([
    ["30 2 * * *", "Europe/Berlin", "2026-03-29T00:00:00Z", "2026-03-30T00:30:00.000Z"],
    ["30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00.000Z"],
    ["45 1 * * *", "Australia/Lord_Howe", "2026-04-04T14:45:00Z", "2026-04-04T15:15:00.000Z"],
    ["15 2 * * *", "Australia/Lord_Howe", "2026-10-03T14:00:00Z", "2026-10-04T15:15:00.000Z"],
    ["0 0 1 * *", "Europe/Berlin", "2026-03-01T00:00:00Z", "2026-03-31T22:00:00.000Z"],
    ["0 0 * * *", "Pacific/Apia", "2011-12-29T10:00:00Z", "2011-12-30T10:00:00.000Z"],
    ["0 9 * * *", "Asia/Kathmandu", "2026-01-01T00:00:00Z", "2026-01-01T03:15:00.000Z"],
    ["0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["0 9 15 * 1", "UTC", "2026-08-10T09:00:00Z", "2026-08-15T09:00:00.000Z"],
    ["*/15 8-17 * * 1-5", "UTC", "2026-08-21T17:45:00Z", "2026-08-24T08:00:00.000Z"],
  ])("advances %s in %s across calendar and offset boundaries", (expression, zone, after, expected) => {
    expect(nextAutomationRunAt(expression, zone, new Date(after))).toBe(expected);
  });

  it("skips nonmatching calendar fields instead of formatting every minute", () => {
    const format = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    try {
      expect(nextAutomationRunAt("0 0 1 * *", "Europe/Berlin", new Date("2026-01-01T00:00:00Z")))
        .toBe("2026-01-31T23:00:00.000Z");
      expect(format.mock.calls.length).toBeLessThan(100);
    } finally { format.mockRestore(); }
  });

  it("retains the bounded search for leap days outside the search horizon", () => {
    expect(() => nextAutomationRunAt("0 0 29 2 *", "UTC", new Date("2028-03-01T00:00:00Z"))).toThrow(/next two years/);
  });
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

  it("rejects impossible calendar schedules before scanning for a match", () => {
    expect(() => nextAutomationRunAt("0 0 31 2 *", "UTC", new Date("2026-01-01T00:00:00Z")))
      .toThrow(/never occur/);
  });

  it("rejects malformed schedules and time zones", () => {
    expect(() => parseAutomationCron("every day")).toThrow(/five-field/);
    expect(() => validateAutomationTimeZone("Mars/Olympus")).toThrow(/Unknown time zone/);
  });
});
