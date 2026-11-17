import { describe, expect, it } from "vitest";
import {
  formatTimeUntil,
  oneTimeAutomationState,
  oneTimeQuickPicks,
  previewOneTimeRunAt,
  suggestedRescheduleLocal,
} from "./automation-schedule-model";

const NOW = Date.parse("2026-11-17T12:00:00Z"); // Tuesday

describe("one-time automation state", () => {
  const base = { enabled: true, lastScheduledAt: null, lastError: null };

  it("distinguishes pending, cancelled, ran, failed, and missed occurrences", () => {
    expect(oneTimeAutomationState(base, [])).toBe("scheduled");
    expect(oneTimeAutomationState({ ...base, enabled: false }, [])).toBe("cancelled");
    const consumed = { ...base, enabled: false, lastScheduledAt: "2026-11-14T08:00:00.000Z" };
    expect(oneTimeAutomationState(consumed, [{ createdAt: "2026-11-14T08:00:03.000Z" }])).toBe("ran");
    expect(oneTimeAutomationState({ ...consumed, lastError: "Model unavailable" }, [])).toBe("failed");
    expect(oneTimeAutomationState(consumed, [])).toBe("missed");
    // A manual "Run now" before the scheduled time does not count as the scheduled start.
    expect(oneTimeAutomationState(consumed, [{ createdAt: "2026-11-13T10:00:00.000Z" }])).toBe("missed");
  });
});

describe("schedule countdowns and suggestions", () => {
  it.each([
    ["2026-11-17T12:00:00Z", "due now"],
    ["2026-11-17T12:12:00Z", "in 12 min"],
    ["2026-11-17T15:00:00Z", "in 3 h"],
    ["2026-11-17T15:20:00Z", "in 3 h 20 min"],
    ["2026-11-19T12:00:00Z", "in 2 d"],
    ["2026-11-20T09:00:00Z", "in 2 d 21 h"],
  ])("formats the time until %s as %s", (target, expected) => {
    expect(formatTimeUntil(target, NOW)).toBe(expected);
  });

  it("offers quick picks in the automation's time zone", () => {
    expect(oneTimeQuickPicks("UTC", NOW)).toEqual([
      { label: "In 1 hour", value: "2026-11-17T13:00" },
      { label: "Tonight 22:00", value: "2026-11-17T22:00" },
      { label: "Tomorrow 09:00", value: "2026-11-18T09:00" },
      { label: "Next Monday 09:00", value: "2026-11-23T09:00" },
    ]);
    // 23:30 in Tokyo: tonight has passed and "tomorrow" is already Wednesday there.
    expect(oneTimeQuickPicks("Asia/Tokyo", Date.parse("2026-11-17T14:30:00Z")).map((pick) => pick.label)).not.toContain("Tonight 22:00");
    expect(oneTimeQuickPicks("Asia/Tokyo", Date.parse("2026-11-17T14:30:00Z")).find((pick) => pick.label === "Tomorrow 09:00")?.value).toBe("2026-11-18T09:00");
    expect(oneTimeQuickPicks("Mars/Olympus", NOW)).toEqual([]);
  });

  it("suggests the same wall time tomorrow when the previous start has passed", () => {
    expect(suggestedRescheduleLocal("2026-11-14T08:00:00.000Z", "UTC", NOW)).toBe("2026-11-18T08:00");
    expect(suggestedRescheduleLocal("2026-11-20T09:00:00.000Z", "Europe/Vienna", NOW)).toBe("2026-11-20T10:00");
  });

  it("previews a one-time start or explains why it cannot be used", () => {
    expect(previewOneTimeRunAt("2026-11-20T10:00", "Europe/Vienna", NOW)).toEqual({ ok: true, runAt: "2026-11-20T09:00:00.000Z" });
    expect(previewOneTimeRunAt("2026-11-17T11:00", "UTC", NOW)).toEqual({ ok: false, message: "This time has already passed." });
    expect(previewOneTimeRunAt("", "UTC", NOW)).toEqual({ ok: false, message: "Choose a date and time." });
    expect(previewOneTimeRunAt("2027-03-28T02:30", "Europe/Berlin", NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/does not exist/) });
  });
});
