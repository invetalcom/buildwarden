import {
  automationLocalDateTimeToUtc,
  formatAutomationLocalDateTime,
  oneTimeAutomationRunAt,
  type ProjectAutomationSummary,
  type RunListItem,
} from "@buildwarden/shared";
import type { BadgeProps } from "../ui/badge";

const MINUTE_MS = 60_000;

/** Lifecycle of a one-time automation, derived from its stored schedule fields and run history. */
export type OneTimeAutomationState = "scheduled" | "cancelled" | "ran" | "failed" | "missed";

export const oneTimeAutomationState = (
  automation: Pick<ProjectAutomationSummary, "enabled" | "lastScheduledAt" | "lastError">,
  runs: Pick<RunListItem, "createdAt">[],
): OneTimeAutomationState => {
  if (!automation.lastScheduledAt) return automation.enabled ? "scheduled" : "cancelled";
  if (automation.lastError) return "failed";
  // The scheduler and the startup catch-up both create the run after consuming the occurrence.
  const consumedAt = Date.parse(automation.lastScheduledAt);
  return runs.some((run) => Date.parse(run.createdAt) >= consumedAt) ? "ran" : "missed";
};

/**
 * The moment a one-time automation's details show, labelled for where it is in its lifecycle.
 * Once it ran, that is when its run started (a catch-up run can start long after the planned time).
 */
export const oneTimeScheduleMoment = (
  automation: Pick<ProjectAutomationSummary, "nextRunAt" | "lastScheduledAt">,
  runs: Pick<RunListItem, "createdAt">[],
  state: OneTimeAutomationState,
): { label: string; value: string } => {
  if (state === "missed" || state === "failed") return { label: "Was due", value: automation.nextRunAt };
  if (state !== "ran") return { label: "Runs at", value: automation.nextRunAt };
  const consumedAt = Date.parse(automation.lastScheduledAt ?? "");
  const startedAt = runs.map((run) => Date.parse(run.createdAt)).filter((createdAt) => createdAt >= consumedAt);
  return startedAt.length > 0
    ? { label: "Ran at", value: new Date(Math.min(...startedAt)).toISOString() }
    : { label: "Scheduled for", value: automation.nextRunAt };
};

export const ONE_TIME_STATE_PRESENTATION: Record<OneTimeAutomationState, { label: string; tone: NonNullable<BadgeProps["tone"]>; dotClass: string }> = {
  scheduled: { label: "Scheduled", tone: "running", dotClass: "bg-[var(--ec-accent)]" },
  cancelled: { label: "Cancelled", tone: "neutral", dotClass: "bg-[var(--ec-faint)]" },
  ran: { label: "Ran", tone: "completed", dotClass: "bg-[var(--ec-faint)]" },
  failed: { label: "Failed to start", tone: "failed", dotClass: "bg-[var(--ec-danger)]" },
  missed: { label: "Missed", tone: "queued", dotClass: "bg-[var(--ec-warning)]" },
};

/** Compact countdown such as "in 12 min", "in 3 h 20 min", or "in 2 d 14 h". */
export const formatTimeUntil = (target: string, now: number): string => {
  const minutes = Math.ceil((Date.parse(target) - now) / MINUTE_MS);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "due now";
  if (minutes < 60) return `in ${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `in ${String(hours)} h ${String(minutes % 60)} min` : `in ${String(hours)} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `in ${String(days)} d ${String(hours % 24)} h` : `in ${String(days)} d`;
};

/** Short, zone-aware label such as "Thu, 20 Nov, 09:00". */
export const formatScheduleMoment = (value: string, timeZone: string, options?: { withYear?: boolean }): string => {
  try {
    return new Date(value).toLocaleString(undefined, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      ...(options?.withYear ? { year: "numeric" } : {}),
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(value).toLocaleString();
  }
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const shiftDate = (date: string, days: number): { date: string; weekday: number } => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    date: `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`,
    weekday: shifted.getUTCDay(),
  };
};

export interface OneTimeQuickPick {
  label: string;
  value: string;
}

/** Common one-time starts, expressed as wall times in the automation's time zone. */
export const oneTimeQuickPicks = (timeZone: string, now: number): OneTimeQuickPick[] => {
  let today: string;
  let inOneHour: string;
  try {
    today = formatAutomationLocalDateTime(new Date(now), timeZone);
    inOneHour = formatAutomationLocalDateTime(new Date(Math.ceil((now + 60 * MINUTE_MS) / (5 * MINUTE_MS)) * 5 * MINUTE_MS), timeZone);
  } catch {
    return [];
  }
  const todayDate = today.slice(0, 10);
  const picks: OneTimeQuickPick[] = [{ label: "In 1 hour", value: inOneHour }];
  if (today.slice(11) < "22:00") picks.push({ label: "Tonight 22:00", value: `${todayDate}T22:00` });
  picks.push({ label: "Tomorrow 09:00", value: `${shiftDate(todayDate, 1).date}T09:00` });
  const todayWeekday = shiftDate(todayDate, 0).weekday;
  const daysUntilMonday = ((8 - todayWeekday) % 7) || 7;
  picks.push({ label: "Next Monday 09:00", value: `${shiftDate(todayDate, daysUntilMonday).date}T09:00` });
  // Wall times are ambiguous around daylight-saving changes: in a repeated hour "In 1 hour" names a
  // time that resolves to its earlier, already elapsed occurrence. Only offer picks that can be saved.
  return picks.filter((pick) => previewOneTimeRunAt(pick.value, timeZone, now).ok);
};

/**
 * Suggested start when rescheduling: the same wall time tomorrow if the old start has passed,
 * otherwise the old start itself.
 */
export const suggestedRescheduleLocal = (previousRunAt: string, timeZone: string, now: number): string => {
  try {
    const previous = formatAutomationLocalDateTime(previousRunAt, timeZone);
    if (Date.parse(previousRunAt) > now) return previous;
    const today = formatAutomationLocalDateTime(new Date(now), timeZone).slice(0, 10);
    return `${shiftDate(today, 1).date}T${previous.slice(11)}`;
  } catch {
    return "";
  }
};

export type OneTimePreview = { ok: true; runAt: string } | { ok: false; message: string };

/** Mirrors the main-process validation so the editor can explain problems before saving. */
export const previewOneTimeRunAt = (localDateTime: string, timeZone: string, now: number): OneTimePreview => {
  if (!localDateTime.trim()) return { ok: false, message: "Choose a date and time." };
  try {
    const runAt = automationLocalDateTimeToUtc(localDateTime, timeZone);
    if (Date.parse(runAt) <= now) return { ok: false, message: "This time has already passed." };
    // Applies the remaining rules saving enforces, such as the planning horizon.
    return { ok: true, runAt: oneTimeAutomationRunAt(localDateTime, timeZone, new Date(now)) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid date and time." };
  }
};
