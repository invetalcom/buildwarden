import { describe, expect, it, vi } from "vitest";
import {
  automationLocalDateTimeToUtc,
  formatAutomationLocalDateTime,
  nextAutomationRunAt,
  oneTimeAutomationRunAt,
  parseAutomationCron,
  previewAutomationRunTimes,
  validateAutomationTimeZone,
} from "@buildwarden/shared";

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

  it("previews upcoming cron starts and tolerates incomplete expressions", () => {
    expect(previewAutomationRunTimes("0 9 * * 1-5", "UTC", new Date("2026-08-21T10:00:00Z"), 3))
      .toEqual(["2026-08-24T09:00:00.000Z", "2026-08-25T09:00:00.000Z", "2026-08-26T09:00:00.000Z"]);
    expect(previewAutomationRunTimes("0 9 *", "UTC", new Date("2026-08-21T10:00:00Z"), 3)).toEqual([]);
  });
});

describe("one-time automation schedules", () => {
  it.each([
    ["2026-11-20T09:00", "Europe/Vienna", "2026-11-20T08:00:00.000Z"],
    ["2026-07-01T09:00", "Europe/Vienna", "2026-07-01T07:00:00.000Z"],
    ["2026-01-01T09:00", "Asia/Kathmandu", "2026-01-01T03:15:00.000Z"],
    ["2026-04-05T01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    ["2026-03-10T23:59", "UTC", "2026-03-10T23:59:00.000Z"],
    ["2026-03-10T23:59:00", "UTC", "2026-03-10T23:59:00.000Z"],
  ])("converts %s in %s to UTC", (local, zone, expected) => {
    expect(automationLocalDateTimeToUtc(local, zone)).toBe(expected);
  });

  it("resolves a repeated autumn wall time to its earlier occurrence", () => {
    expect(automationLocalDateTimeToUtc("2026-10-25T02:30", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("rejects a wall time skipped by the spring daylight-saving jump", () => {
    expect(() => automationLocalDateTimeToUtc("2026-03-29T02:30", "Europe/Berlin")).toThrow(/does not exist/);
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => automationLocalDateTimeToUtc("", "UTC")).toThrow(/Choose a date and time/);
    expect(() => automationLocalDateTimeToUtc("2026-02-30T09:00", "UTC")).toThrow(/not a valid date/);
    expect(() => automationLocalDateTimeToUtc("2026-02-10T24:00", "UTC")).toThrow(/not a valid date/);
    expect(() => automationLocalDateTimeToUtc("2026-02-10T09:00", "Mars/Olympus")).toThrow(/Unknown time zone/);
  });

  it("formats a UTC start back to its wall time in the configured zone", () => {
    expect(formatAutomationLocalDateTime("2026-11-20T08:00:00.000Z", "Europe/Vienna")).toBe("2026-11-20T09:00");
    expect(formatAutomationLocalDateTime("2026-10-25T00:30:00.000Z", "Europe/Berlin")).toBe("2026-10-25T02:30");
    expect(formatAutomationLocalDateTime(new Date("2026-01-01T03:15:30Z"), "Asia/Kathmandu")).toBe("2026-01-01T09:00");
  });

  it("requires a future start within the two-year horizon", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(oneTimeAutomationRunAt("2026-11-17T12:01", "UTC", now)).toBe("2026-11-17T12:01:00.000Z");
    expect(() => oneTimeAutomationRunAt("2026-11-17T12:00", "UTC", now)).toThrow(/in the future/);
    expect(() => oneTimeAutomationRunAt("2029-01-01T00:00", "UTC", now)).toThrow(/two years/);
  });
});
