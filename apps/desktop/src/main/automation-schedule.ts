const MINUTE_MS = 60_000;

type CronField = Set<number>;
type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
};

const parseNumber = (value: string, minimum: number, maximum: number, label: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${String(minimum)} and ${String(maximum)}.`);
  }
  return parsed;
};

const parseCronField = (raw: string, minimum: number, maximum: number, label: string): CronField => {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    if (!rangeRaw || part.split("/").length > 2) throw new Error(`Invalid ${label} field.`);
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, 1, maximum - minimum + 1, `${label} step`);
    let start = minimum;
    let end = maximum;
    if (rangeRaw !== "*") {
      const bounds = rangeRaw.split("-");
      start = parseNumber(bounds[0] ?? "", minimum, maximum, label);
      end = bounds.length === 1 ? start : parseNumber(bounds[1] ?? "", minimum, maximum, label);
      if (bounds.length > 2 || start > end) throw new Error(`Invalid ${label} range.`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`${label} cannot be empty.`);
  return values;
};

const isCronWildcard = (field: string): boolean => field === "*" || field === "*/1";

export const parseAutomationCron = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Use a five-field cron schedule: minute hour day-of-month month day-of-week.");
  return {
    minute: parseCronField(fields[0]!, 0, 59, "Minute"),
    hour: parseCronField(fields[1]!, 0, 23, "Hour"),
    dayOfMonth: parseCronField(fields[2]!, 1, 31, "Day of month"),
    month: parseCronField(fields[3]!, 1, 12, "Month"),
    dayOfWeek: parseCronField(fields[4]!, 0, 6, "Day of week"),
    dayOfMonthWildcard: isCronWildcard(fields[2]!),
    dayOfWeekWildcard: isCronWildcard(fields[4]!),
  };
};

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

const zoneFormatter = (timeZone: string): Intl.DateTimeFormat => {
  const cached = zoneFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  });
  // Time zones are user-controlled; keep the cache bounded.
  if (zoneFormatters.size >= 32) zoneFormatters.delete(zoneFormatters.keys().next().value!);
  zoneFormatters.set(timeZone, formatter);
  return formatter;
};

const zonedParts = (timestamp: number, formatter: Intl.DateTimeFormat) => {
  const parts = formatter.formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  return {
    year: Number(value("year")),
    minute: Number(value("minute")),
    hour: Number(value("hour")),
    dayOfMonth: Number(value("day")),
    month: Number(value("month")),
    dayOfWeek: weekday,
  };
};

const cronDayMatches = (cron: ParsedCron, parts: ReturnType<typeof zonedParts>): boolean => {
  const dayOfMonthMatches = cron.dayOfMonth.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.has(parts.dayOfWeek);
  let dayMatches = dayOfMonthMatches || dayOfWeekMatches;
  if (cron.dayOfMonthWildcard) dayMatches = dayOfWeekMatches;
  else if (cron.dayOfWeekWildcard) dayMatches = dayOfMonthMatches;
  return cron.month.has(parts.month) && dayMatches;
};

const zoneOffset = (timestamp: number, parts: ReturnType<typeof zonedParts>): number =>
  Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute) - timestamp;

const minutesUntilCandidate = (cron: ParsedCron, parts: ReturnType<typeof zonedParts>): number => {
  if (!cronDayMatches(cron, parts)) return (24 - parts.hour) * 60 - parts.minute;
  if (!cron.hour.has(parts.hour)) {
    const nextHour = Math.min(24, ...[...cron.hour].filter((hour) => hour > parts.hour));
    return (nextHour - parts.hour) * 60 - parts.minute;
  }
  if (!cron.minute.has(parts.minute)) {
    return Math.min(60, ...[...cron.minute].filter((minute) => minute > parts.minute)) - parts.minute;
  }
  return 0;
};

const MAX_DAYS_BY_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const assertCronCanMatchCalendar = (cron: ParsedCron): void => {
  // A restricted weekday is ORed with a restricted day-of-month, so it always
  // provides a possible date. Calendar validation is only needed when the
  // weekday is a wildcard and the day-of-month must match.
  if (cron.dayOfMonthWildcard || !cron.dayOfWeekWildcard) return;
  const hasPossibleDate = [...cron.month].some((month) => {
    const maximumDay = MAX_DAYS_BY_MONTH[month - 1] ?? 0;
    return [...cron.dayOfMonth].some((day) => day <= maximumDay);
  });
  if (!hasPossibleDate) {
    throw new Error("This cron schedule can never occur for the selected months.");
  }
};

export const validateAutomationTimeZone = (timeZone: string): string => {
  const trimmed = timeZone.trim();
  try {
    zoneFormatter(trimmed);
  } catch {
    throw new Error(`Unknown time zone: ${trimmed || "(empty)"}.`);
  }
  return trimmed;
};

export const nextAutomationRunAt = (expression: string, timeZone: string, after: Date): string => {
  const cron = parseAutomationCron(expression);
  const zone = validateAutomationTimeZone(timeZone);
  assertCronCanMatchCalendar(cron);
  if (!Number.isFinite(after.getTime())) throw new Error("The schedule start time is invalid.");
  const formatter = zoneFormatter(zone);
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = start + 2 * 366 * 24 * 60 * MINUTE_MS;
  let timestamp = start;
  let parts = zonedParts(timestamp, formatter);
  while (timestamp <= limit) {
    const advance = minutesUntilCandidate(cron, parts);
    if (advance === 0) return new Date(timestamp).toISOString();
    let next = timestamp + advance * MINUTE_MS;
    let nextParts = zonedParts(next, formatter);
    const offset = zoneOffset(timestamp, parts);
    if (zoneOffset(next, nextParts) !== offset) {
      // A wall-clock jump may cross a missing or repeated time. Approach the
      // transition in hours, then scan its minutes in UTC so both folds remain
      // eligible and non-hour DST changes are handled as well.
      next = timestamp + Math.min(advance, 60) * MINUTE_MS;
      nextParts = zonedParts(next, formatter);
      if (zoneOffset(next, nextParts) !== offset) {
        next = timestamp + MINUTE_MS;
        nextParts = zonedParts(next, formatter);
      }
    }
    timestamp = next;
    parts = nextParts;
  }
  throw new Error("This cron schedule has no matching time in the next two years.");
};

