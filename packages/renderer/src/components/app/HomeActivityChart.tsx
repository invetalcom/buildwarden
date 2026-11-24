import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { HOME_CHART_METRICS, HOME_CHART_RANGES, type HomeChartMetric, type HomeChartRange } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { SegmentedControl } from "../ui/segmented-control";
import { formatCompactNumber, formatFullNumber, type HomeChartDay } from "./landing-page-model";
import { formatUsd } from "./usage-analytics";
import "./usage-charts.css";

const METRIC_VIEWS: Record<HomeChartMetric, {
  /** What one bar counts, as it reads after a number. */
  unit: string;
  /** The chart series this lane takes its color from, so a theme's chart colors reach it. */
  color: string;
  value: (day: HomeChartDay) => number;
  format: (value: number) => string;
}> = {
  runs: { unit: "runs", color: "var(--usage-series-1)", value: (day) => day.runs, format: formatFullNumber },
  tokens: { unit: "tokens", color: "var(--usage-series-2)", value: (day) => day.tokens, format: formatCompactNumber },
  cost: { unit: "est. cost", color: "var(--usage-series-3)", value: (day) => day.cost ?? 0, format: formatUsd },
};

const RANGE_OPTIONS = HOME_CHART_RANGES.map((range) => ({ value: range, label: `${String(range)}d` }));

const formatDay = (date: Date) => date.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "2-digit" });

/** Width of a lane's label column plus the gap to its bars; the tooltip and the axis line up with it. */
const GUTTER = "6rem";
const TOOLTIP_WIDTH = "11rem";

interface HomeActivityChartProps {
  /** The chart's window, oldest day first. */
  days: ReadonlyArray<HomeChartDay>;
  /** Lanes the layout asks for. */
  metrics: ReadonlyArray<HomeChartMetric>;
  /** Lanes that have data to show. Cost is missing while cost tracking is off. */
  available: ReadonlyArray<HomeChartMetric>;
  range: HomeChartRange;
  /** Cost is being loaded: its lane stays, its total shows a placeholder. */
  costPending?: boolean;
  onMetricsChange: (metrics: HomeChartMetric[]) => void;
  onRangeChange: (range: HomeChartRange) => void;
  className?: string;
}

/**
 * Activity along the bottom of Home. Runs, tokens and cost have no common scale, so each gets a
 * thin lane with its own scale over one shared time axis, instead of several y-axes on one plot.
 * The chips above are the legend, carry the totals of the window and switch lanes on and off.
 */
export const HomeActivityChart = ({ days, metrics, available, range, costPending = false, onMetricsChange, onRangeChange, className }: HomeActivityChartProps) => {
  const plotRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const offered = HOME_CHART_METRICS.filter((metric) => available.includes(metric.key));
  const selected = offered.filter((metric) => metrics.includes(metric.key));
  // A layout can ask only for lanes that cannot show (cost while tracking is off). Runs always can.
  const shown = selected.length > 0 ? selected : offered.slice(0, 1);

  const lanes = useMemo(() => shown.map((metric) => {
    const view = METRIC_VIEWS[metric.key];
    const values = days.map(view.value);
    return { ...metric, view, values, peak: Math.max(0, ...values), total: values.reduce((sum, value) => sum + value, 0) };
  // `shown` is rebuilt every render; its keys say when it changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [days, shown.map((metric) => metric.key).join(",")]);

  const toggle = (key: HomeChartMetric) => {
    const on = shown.some((metric) => metric.key === key);
    if (on && shown.length === 1) return;
    // Lanes that cannot show right now keep their place in the setting.
    const next = HOME_CHART_METRICS.map((metric) => metric.key).filter((entry) =>
      entry === key ? !on : available.includes(entry) ? shown.some((metric) => metric.key === entry) : metrics.includes(entry));
    onMetricsChange(next);
  };

  const count = days.length;
  const active = activeIndex !== null && activeIndex < count ? activeIndex : null;
  const activeDay = active === null ? null : days[active]!;
  const empty = lanes.every((lane) => lane.total === 0);

  const describe = (index: number) => {
    const day = days[index]!;
    const parts = lanes.map((lane) => `${lane.view.format(lane.values[index]!)} ${lane.view.unit}`);
    return `${index === count - 1 ? "Today" : formatDay(day.date)}: ${parts.join(", ")}${day.failedRuns > 0 ? `, ${String(day.failedRuns)} failed` : ""}`;
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const columns = plotRef.current?.querySelector<HTMLElement>("[data-home-chart-columns]");
    if (!columns || count === 0) return;
    const rect = columns.getBoundingClientRect();
    if (rect.width <= 0) return;
    setActiveIndex(Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * count))));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = active ?? count - 1;
    let next: number;
    if (event.key === "ArrowLeft") next = active === null ? current : Math.max(0, current - 1);
    else if (event.key === "ArrowRight") next = active === null ? current : Math.min(count - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape") { setActiveIndex(null); return; }
    else return;
    event.preventDefault();
    setActiveIndex(next);
  };

  return (
    <section data-ui="home-chart" aria-label="Activity" className={cn("flex w-full shrink-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Chart metrics">
          {offered.map((metric) => {
            const lane = lanes.find((entry) => entry.key === metric.key);
            const on = Boolean(lane);
            const only = on && lanes.length === 1;
            return (
              <button
                key={metric.key}
                type="button"
                aria-pressed={on}
                title={only ? "At least one metric stays on" : on ? `Hide ${metric.label.toLowerCase()}` : `Show ${metric.label.toLowerCase()}`}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-sm px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
                  on ? "bg-[var(--ec-control)] hover:bg-[var(--ec-control-hover)]" : "shadow-[inset_0_0_0_1px_var(--ec-border)] hover:bg-[var(--ec-hover)]",
                )}
                onClick={() => toggle(metric.key)}
              >
                <span
                  aria-hidden
                  className={cn("size-2 rounded-[2px]", !on && "shadow-[inset_0_0_0_1px_var(--ec-faint)]")}
                  style={on ? { background: METRIC_VIEWS[metric.key].color } : undefined}
                />
                <span className={on ? "text-[var(--ec-muted)]" : "text-[var(--ec-faint)]"}>{metric.label}</span>
                {lane ? (
                  <span className="font-medium tabular-nums text-[var(--ec-text)]">
                    {metric.key === "cost" && costPending ? "…" : lane.view.format(lane.total)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <SegmentedControl label="Chart range" options={RANGE_OPTIONS} value={range} onChange={onRangeChange} />
      </div>

      <div
        ref={plotRef}
        role="group"
        tabIndex={0}
        aria-label={`${lanes.map((lane) => lane.label).join(", ")} per day, last ${String(count)} days. Use the arrow keys to read single days.`}
        className="relative flex h-44 flex-col gap-2.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setActiveIndex(null)}
        onKeyDown={handleKeyDown}
        onBlur={() => setActiveIndex(null)}
      >
        {lanes.map((lane, laneIndex) => (
          <div
            key={lane.key}
            data-ui="home-chart-lane"
            data-metric={lane.key}
            className="flex min-h-0 flex-1 gap-2"
          >
            <div className="w-[5.5rem] shrink-0 leading-tight">
              <p className="truncate text-[11px] text-[var(--ec-muted)]">{lane.label}</p>
              <p className="truncate font-mono text-[10px] tabular-nums text-[var(--ec-faint)]" title={`Busiest day in this range: ${lane.view.format(lane.peak)} ${lane.view.unit}`}>
                peak {lane.view.format(lane.peak)}
              </p>
            </div>
            <div
              {...(laneIndex === 0 ? { "data-home-chart-columns": "" } : {})}
              // Tighter gaps keep 30 days readable on a narrow page.
              className={cn("flex min-w-0 flex-1 items-stretch border-b border-[var(--ec-border)]", count > 14 ? "gap-[3px]" : "gap-1.5")}
            >
              {days.map((day, index) => {
                const value = lane.values[index]!;
                const failed = lane.key === "runs" ? Math.min(day.failedRuns, value) : 0;
                return (
                  <div key={day.key} data-home-chart-day={day.key} className={cn("flex min-w-0 flex-1 items-end rounded-t-[3px] transition-colors", active === index && "bg-[var(--ec-hover)]")}>
                    {value > 0 ? (
                      <div
                        className="mx-auto flex w-full max-w-9 flex-col gap-px overflow-hidden rounded-t-[3px]"
                        style={{ height: `max(2px, ${String((value / lane.peak) * 100)}%)` }}
                      >
                        {failed > 0 ? <span className="block min-h-[2px] bg-[var(--bw-state-failed,var(--ec-danger))]" style={{ flex: `${String(failed)} 1 0` }} /> : null}
                        {value > failed ? <span className="block" style={{ flex: `${String(value - failed)} 1 0`, background: lane.view.color }} /> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {empty ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-[var(--ec-faint)]" style={{ paddingLeft: GUTTER }}>
            No activity in the last {count} days
          </p>
        ) : null}

        {activeDay && active !== null ? (
          <div
            data-ui="popover"
            role="presentation"
            className="pointer-events-none absolute bottom-full z-10 mb-1.5 rounded-md border border-[var(--ec-border)] bg-[var(--ec-dialog-bg,var(--ec-bg-elevated))] px-2.5 py-2 text-xs shadow-[var(--ec-popover-shadow)]"
            style={{
              width: TOOLTIP_WIDTH,
              // Centered on the day, but kept inside the chart at both ends.
              left: `clamp(0px, calc(${GUTTER} + (100% - ${GUTTER}) * ${String((active + 0.5) / count)} - ${TOOLTIP_WIDTH} / 2), calc(100% - ${TOOLTIP_WIDTH}))`,
            }}
          >
            <p className="mb-1 text-[var(--ec-muted)]">{active === count - 1 ? "Today" : formatDay(activeDay.date)}</p>
            {lanes.map((lane) => (
              <p key={lane.key} className="flex items-center gap-1.5">
                <span aria-hidden className="h-0.5 w-2 shrink-0 rounded-full" style={{ background: lane.view.color }} />
                <span className="font-semibold tabular-nums text-[var(--ec-text)]">{lane.view.format(lane.values[active]!)}</span>
                <span className="ml-auto truncate text-[var(--ec-muted)]">
                  {lane.key === "runs" && activeDay.failedRuns > 0 ? `${String(activeDay.failedRuns)} failed · ` : ""}{lane.view.unit}
                </span>
              </p>
            ))}
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">{active === null ? "" : describe(active)}</p>
      </div>

      <div className="flex justify-between font-mono text-[10px] text-[var(--ec-faint)]" style={{ paddingLeft: GUTTER }}>
        <span>{days[0] ? formatDay(days[0].date) : ""}</span>
        <span>Today</span>
      </div>
    </section>
  );
};
