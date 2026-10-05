import { useMemo, useState } from "react";
import type { ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import { BarChart3 } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { cn } from "../../lib/cn";
import {
  buildDailyRunActivity,
  buildProviderUsage,
  formatCompactNumber,
  formatFullNumber,
  RUN_OUTCOME_SERIES,
  type DailyRunActivity,
} from "./landing-page-model";
import { ProviderBrandIcon } from "./provider-brand-icons";

const ACTIVITY_RANGES = [7, 14, 30] as const;
type ActivityRange = (typeof ACTIVITY_RANGES)[number];
const DEFAULT_ACTIVITY_RANGE: ActivityRange = 14;
const MAX_PROVIDER_ROWS = 5;

const formatDay = (date: Date) => date.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "2-digit" });

const describeDay = (day: DailyRunActivity) => {
  const parts = RUN_OUTCOME_SERIES.filter((series) => day[series.key] > 0)
    .map((series) => `${String(day[series.key])} ${series.label.toLowerCase()}`);
  return `${String(day.total)} ${day.total === 1 ? "run" : "runs"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""} · ${formatCompactNumber(day.tokens)} tokens`;
};

const RunActivityChart = ({ days }: { days: DailyRunActivity[] }) => {
  const range = days.length;
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const maxTotal = Math.max(1, ...days.map((day) => day.total));
  const hovered = days.find((day) => day.key === hoveredKey) ?? null;
  const windowTotal = days.reduce((sum, day) => sum + day.total, 0);
  const windowTokens = days.reduce((sum, day) => sum + day.tokens, 0);

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 truncate text-xs text-[var(--ec-text)]" aria-live="polite">
          {hovered ? (
            <><span className="font-semibold">{formatDay(hovered.date)}</span> <span className="text-[var(--ec-muted)]">{describeDay(hovered)}</span></>
          ) : (
            <><span className="font-semibold">{windowTotal} {windowTotal === 1 ? "run" : "runs"}</span> <span className="text-[var(--ec-muted)]">in {range} days · {formatCompactNumber(windowTokens)} tokens</span></>
          )}
        </p>
        <ul className="flex flex-wrap items-center gap-x-2.5 gap-y-1" aria-label="Legend">
          {RUN_OUTCOME_SERIES.map((series) => (
            <li key={series.key} className="flex items-center gap-1 text-[10px] text-[var(--ec-muted)]">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: series.color }} />
              {series.label}
            </li>
          ))}
        </ul>
      </div>
      <div
        // Tighter gaps keep 30 bars readable in a narrow card.
        className={cn("relative flex min-h-20 flex-1 items-stretch border-b border-[var(--ec-border)]", range > 14 ? "gap-0.5" : "gap-1")}
        role="list"
        aria-label={`Runs started per day, last ${String(range)} days`}
        onMouseLeave={() => setHoveredKey(null)}
      >
        {windowTotal === 0 ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-[var(--ec-faint)]">No runs in the last {range} days</p>
        ) : null}
        {days.map((day) => (
          <div
            key={day.key}
            role="listitem"
            tabIndex={0}
            aria-label={`${formatDay(day.date)}: ${describeDay(day)}`}
            data-activity-day={day.key}
            className={cn(
              "flex min-w-0 flex-1 cursor-default flex-col justify-end rounded-t-[4px] px-px outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
              hoveredKey === day.key && "bg-[var(--ec-hover)]",
            )}
            onMouseEnter={() => setHoveredKey(day.key)}
            onFocus={() => setHoveredKey(day.key)}
            onBlur={() => setHoveredKey(null)}
          >
            {day.total > 0 ? (
              <div
                className="mx-auto flex w-full max-w-7 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                style={{ height: `max(4px, ${String((day.total / maxTotal) * 100)}%)` }}
              >
                {RUN_OUTCOME_SERIES.filter((series) => day[series.key] > 0).map((series) => (
                  <span key={series.key} className="block min-h-[2px]" style={{ flex: `${String(day[series.key])} 1 0`, background: series.color }} />
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10px] text-[var(--ec-faint)]">
        <span>{days[0] ? formatDay(days[0].date) : ""}</span>
        <span>Today</span>
      </div>
    </div>
  );
};

export const LandingActivityPanel = ({
  runs,
  providerAccounts,
  className,
}: {
  runs: ReadonlyArray<RunRecord>;
  providerAccounts: ReadonlyArray<ProviderAccountRecord>;
  className?: string;
}) => {
  const [range, setRange] = useState<ActivityRange>(DEFAULT_ACTIVITY_RANGE);
  const days = useMemo(() => buildDailyRunActivity(runs, range), [range, runs]);
  // Provider usage follows the selected range so the whole panel describes the same window.
  const providers = useMemo(() => {
    const windowStart = days[0]?.date.getTime() ?? 0;
    return buildProviderUsage(runs.filter((run) => new Date(run.createdAt).getTime() >= windowStart), providerAccounts);
  }, [days, providerAccounts, runs]);
  const maxProviderRuns = Math.max(1, ...providers.map((provider) => provider.runs));

  return (
    <Card className={cn("flex min-h-0 flex-col", className)}>
      <CardHeader className="shrink-0 flex-row items-start gap-2 px-4 pt-3 pb-2">
        <BarChart3 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
        <div className="min-w-0">
          <CardTitle>Activity</CardTitle>
          <CardDescription>Runs per day and provider usage.</CardDescription>
        </div>
        <CardAction>
          <div className="flex h-7 items-center rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-0.5" role="group" aria-label="Activity range">
            {ACTIVITY_RANGES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={range === option}
                title={`Last ${String(option)} days`}
                className={cn(
                  "h-6 rounded px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
                  range === option ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:text-[var(--ec-text)]",
                )}
                onClick={() => setRange(option)}
              >
                {option}d
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="app-scrollbar flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        <RunActivityChart days={days} />
        {providers.length > 0 ? (
          <div className="shrink-0 border-t border-[var(--ec-border)] pt-2">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-faint)]">By provider</p>
            <ul className="flex flex-col gap-1.5">
              {providers.slice(0, MAX_PROVIDER_ROWS).map((provider) => (
                <li key={provider.providerAccountId} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <ProviderBrandIcon harnessType={provider.harnessType} providerType={provider.providerType} className="size-3.5 shrink-0" />
                    <span className="truncate text-[var(--ec-text)]">{provider.label}</span>
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]" aria-hidden>
                    <span className="block h-full rounded-full bg-[var(--ec-accent)]" style={{ width: `${String((provider.runs / maxProviderRuns) * 100)}%` }} />
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-[var(--ec-muted)]" title={`${formatFullNumber(provider.tokens)} tokens`}>
                    {provider.runs} runs · {formatCompactNumber(provider.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};
