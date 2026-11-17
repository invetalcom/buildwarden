import { describe, expect, it } from "vitest";
import {
  formatTimeUntil,
  oneTimeAutomationState,
  oneTimeQuickPicks,
  oneTimeScheduleMoment,
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

  it("shows when the scheduled run actually started once it ran", () => {
    const consumed = { nextRunAt: "2026-11-14T08:00:00.000Z", lastScheduledAt: "2026-11-14T08:00:00.000Z" };
    // Started by the startup catch-up three days late, then run again manually.
    const runs = [
      { createdAt: "2026-11-17T12:05:00.000Z", startedAt: "2026-11-17T12:05:02.000Z" },
      { createdAt: "2026-11-17T09:00:03.000Z", startedAt: "2026-11-17T09:00:41.000Z" },
      { createdAt: "2026-11-13T10:00:00.000Z", startedAt: "2026-11-13T10:00:01.000Z" },
    ];
    expect(oneTimeScheduleMoment(consumed, runs, "ran")).toEqual({ label: "Ran at", value: "2026-11-17T09:00:41.000Z" });
    // A run that has not started yet shows when it was created.
    expect(oneTimeScheduleMoment(consumed, [{ createdAt: "2026-11-17T09:00:03.000Z", startedAt: null }], "ran")).toEqual({ label: "Ran at", value: "2026-11-17T09:00:03.000Z" });
    expect(oneTimeScheduleMoment(consumed, [], "missed")).toEqual({ label: "Was due", value: consumed.nextRunAt });
    expect(oneTimeScheduleMoment(consumed, [], "failed")).toEqual({ label: "Was due", value: consumed.nextRunAt });
    expect(oneTimeScheduleMoment({ ...consumed, lastScheduledAt: null }, [], "scheduled")).toEqual({ label: "Runs at", value: consumed.nextRunAt });
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
    // 01:30 EDT on the fall-back night: an hour later is 01:30 EST, which the wall time cannot express.
    expect(oneTimeQuickPicks("America/New_York", Date.parse("2026-11-01T05:30:00Z")).map((pick) => pick.label)).toEqual([
      "Tonight 22:00",
      "Tomorrow 09:00",
      "Next Monday 09:00",
    ]);
    // 01:31 EDT: an hour later rounds to 01:35 EST (06:35Z), but "01:35" resolves to 05:35Z, four minutes away.
    expect(oneTimeQuickPicks("America/New_York", Date.parse("2026-11-01T05:31:00Z")).map((pick) => pick.label)).not.toContain("In 1 hour");
    // Outside the repeated hour the pick is offered as usual.
    expect(oneTimeQuickPicks("America/New_York", Date.parse("2026-11-01T07:31:00Z"))[0]).toEqual({ label: "In 1 hour", value: "2026-11-01T03:35" });
  });

  it("suggests the same wall time tomorrow when the previous start has passed", () => {
    expect(suggestedRescheduleLocal("2026-11-14T08:00:00.000Z", "UTC", NOW)).toBe("2026-11-18T08:00");
    expect(suggestedRescheduleLocal("2026-11-20T09:00:00.000Z", "Europe/Vienna", NOW)).toBe("2026-11-20T10:00");
  });

  it("previews a one-time start or explains why it cannot be used", () => {
    expect(previewOneTimeRunAt("2026-11-20T10:00", "Europe/Vienna", NOW)).toEqual({ ok: true, runAt: "2026-11-20T09:00:00.000Z" });
    expect(previewOneTimeRunAt("2026-11-17T11:00", "UTC", NOW)).toEqual({ ok: false, message: "This time has already passed." });
    expect(previewOneTimeRunAt("", "UTC", NOW)).toEqual({ ok: false, message: "Choose a date and time." });
    expect(previewOneTimeRunAt("2029-01-01T09:00", "UTC", NOW)).toEqual({ ok: false, message: "One-time automations can be scheduled up to two years ahead." });
    expect(previewOneTimeRunAt("2027-03-28T02:30", "Europe/Berlin", NOW)).toMatchObject({ ok: false, message: expect.stringMatching(/does not exist/) });
  });
});
