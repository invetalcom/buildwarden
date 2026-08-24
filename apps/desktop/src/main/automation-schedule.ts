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

const zonedParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  return {
    minute: Number(value("minute")),
    hour: Number(value("hour")),
    dayOfMonth: Number(value("day")),
    month: Number(value("month")),
    dayOfWeek: weekday,
  };
};

const cronMatches = (cron: ParsedCron, date: Date, timeZone: string): boolean => {
  const parts = zonedParts(date, timeZone);
  const dayOfMonthMatches = cron.dayOfMonth.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.has(parts.dayOfWeek);
  const dayMatches = cron.dayOfMonthWildcard
    ? dayOfWeekMatches
    : cron.dayOfWeekWildcard
      ? dayOfMonthMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return cron.minute.has(parts.minute) && cron.hour.has(parts.hour) && cron.month.has(parts.month) && dayMatches;
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
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
  } catch {
    throw new Error(`Unknown time zone: ${trimmed || "(empty)"}.`);
  }
  return trimmed;
};

export const nextAutomationRunAt = (expression: string, timeZone: string, after: Date): string => {
  const cron = parseAutomationCron(expression);
  const zone = validateAutomationTimeZone(timeZone);
  assertCronCanMatchCalendar(cron);
  const start = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = start + 2 * 366 * 24 * 60 * MINUTE_MS;
  for (let timestamp = start; timestamp <= limit; timestamp += MINUTE_MS) {
    const candidate = new Date(timestamp);
    if (cronMatches(cron, candidate, zone)) return candidate.toISOString();
  }
  throw new Error("This cron schedule has no matching time in the next two years.");
};

