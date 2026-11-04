import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../lib/cn";
import { SegmentedControl } from "../ui/segmented-control";
import {
  describeUsageBucket,
  formatUsageBucket,
  usageBucketsSpanYears,
  type UsageSeries,
  type UsageTimeSeries,
} from "./usage-analytics";
import "./usage-charts.css";

const MARGIN = { top: 18, right: 6, bottom: 22, left: 46 };
const MAX_BAR_WIDTH = 24;
const SEGMENT_GAP = 2;
const CORNER_RADIUS = 4;

/** Rounds the axis top up to 1/2/2.5/5 × 10^n so ticks land on clean values. */
const niceScale = (max: number, targetTicks = 4, integerTicks = false): { top: number; step: number } => {
  if (max <= 0) return { top: 1, step: 0.25 };
  const rough = Math.max(max / targetTicks, integerTicks ? 1 : 0);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude)
    .find((candidate) => candidate >= rough && (!integerTicks || Number.isInteger(candidate))) ?? 10 * magnitude;
  return { top: Math.ceil(max / step) * step, step };
};

/**
 * Tracks an element's width through a callback ref, so it follows whichever element is mounted
 * (the empty state and the chart are different nodes) and measures before the first paint.
 */
const useElementWidth = (fallback: number) => {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const measured = Math.floor(element.getBoundingClientRect().width);
    if (measured > 0) setWidth(Math.max(120, measured));
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.max(120, Math.floor(entry.contentRect.width)));
    });
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width] as const;
};

/** A bar segment with only its data end rounded; the baseline end stays square. */
const roundedTopPath = (x: number, y: number, width: number, height: number, radius: number): string => {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
};

export const UsageChartLegend = ({ series, className }: { series: ReadonlyArray<Pick<UsageSeries, "key" | "label" | "color">>; className?: string }) => (
  <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)} aria-label="Legend">
    {series.map((entry) => (
      <li key={entry.key} className="flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--ec-muted)]">
        <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: entry.color }} />
        <span className="max-w-[16rem] truncate">{entry.label}</span>
      </li>
    ))}
  </ul>
);

export type UsageChartView = "bar" | "line" | "table";

export const UsageChartViewControl = ({ value, onChange, label, className }: {
  value: UsageChartView;
  onChange: (value: UsageChartView) => void;
  label: string;
  className?: string;
}) => (
  <SegmentedControl label={label} value={value} onChange={onChange} className={className}
    options={[{ value: "bar", label: "Bars" }, { value: "line", label: "Lines" }, { value: "table", label: "Table" }] as const} />
);

export type UsageStackedBarChartProps = {
  data: UsageTimeSeries;
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
  ariaLabel: string;
  /** Plot height in pixels, excluding the x-axis band. */
  plotHeight?: number;
  className?: string;
  emptyMessage?: string;
  integerTicks?: boolean;
};

/**
 * Shared axes and interaction for stacked bars and independent lines. Each bucket's band
 * is its hover/tap/focus target; the readout lists every series at that point, values first.
 */
const UsageTimeChart = ({
  data,
  formatValue,
  formatAxis,
  ariaLabel,
  plotHeight = 168,
  className,
  emptyMessage = "No usage in this period",
  integerTicks = false,
  variant,
}: UsageStackedBarChartProps & { variant: "bar" | "line" }) => {
  const [containerRef, width] = useElementWidth(640);
  const [active, setActive] = useState<number | null>(null);
  const count = data.buckets.length;

  const totals = useMemo(
    () => data.buckets.map((_, index) => data.series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0)),
    [data],
  );
  const peakIndex = totals.reduce((best, value, index) => (value > (totals[best] ?? 0) ? index : best), 0);
  const peak = totals[peakIndex] ?? 0;
  const linePeak = useMemo(() => data.series.reduce((max, entry) => entry.values.reduce((best, value) => Math.max(best, value), max), 0), [data]);
  // Lines represent each series' own value, never cumulative stacked values.
  const { top, step } = niceScale(variant === "line" ? linePeak : peak, 4, integerTicks);
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const band = count > 0 ? plotWidth / count : plotWidth;
  const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, band - SEGMENT_GAP, band * 0.68));
  const height = MARGIN.top + plotHeight + MARGIN.bottom;
  const yFor = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const xFor = (index: number) => MARGIN.left + (index + 0.5) * band;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
  const withYear = usageBucketsSpanYears(data.buckets);
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / (withYear ? 70 : 58)))));

  useEffect(() => {
    if (active !== null && active >= count) setActive(null);
  }, [active, count]);

  if (count === 0 || peak <= 0) {
    return (
      <div ref={containerRef} className={cn("flex items-center justify-center text-xs text-[color:var(--ec-faint)]", className)} style={{ height }}>
        {emptyMessage}
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      setActive((current) => Math.min(count - 1, Math.max(0, (current ?? (delta > 0 ? -1 : count)) + delta)));
    } else if (event.key === "Escape") {
      setActive(null);
    }
  };
  const onPointerLeave = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "mouse") setActive(null);
  };

  const activeRows = active === null
    ? []
    : data.series
      .map((entry) => ({ entry, value: entry.values[active] ?? 0 }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value);
  const activeCenter = active === null ? 0 : MARGIN.left + active * band + band / 2;
  const tooltipOnLeft = activeCenter > width * 0.62;

  return (
    <div
      ref={containerRef}
      className={cn("relative outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-accent-ring)] rounded-md", className)}
      tabIndex={0}
      role="group"
      aria-label={`${ariaLabel}, ${variant === "line" ? "line" : "stacked bar"} chart. Use the left and right arrow keys to read each ${data.bucketSize}.`}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      <svg width={width} height={height} className="block select-none" onPointerLeave={onPointerLeave} aria-hidden>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={yFor(tick)}
              y2={yFor(tick)}
              stroke={tick === 0 ? "var(--usage-chart-axis)" : "var(--usage-chart-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={MARGIN.left - 8}
              y={yFor(tick)}
              dy="0.32em"
              textAnchor="end"
              className="fill-[var(--ec-faint)] text-[10px] tabular-nums"
            >
              {formatAxis(tick)}
            </text>
          </g>
        ))}

        {variant === "line" ? data.series.map((entry) => (
          <g key={entry.key}>
            <path
              d={data.buckets.map((_, index) => `${index === 0 ? "M" : "L"}${xFor(index)},${yFor(entry.values[index] ?? 0)}`).join(" ")}
              fill="none" stroke={entry.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              data-series-key={entry.key}
            />
            {count === 1 ? <circle cx={xFor(0)} cy={yFor(entry.values[0] ?? 0)} r={3} fill={entry.color} /> : null}
          </g>
        )) : data.buckets.map((bucket, index) => {
          const x = MARGIN.left + index * band + (band - barWidth) / 2;
          let base = MARGIN.top + plotHeight;
          const visible = data.series.filter((entry) => (entry.values[index] ?? 0) > 0);
          const dimmed = active !== null && active !== index;
          return (
            <g key={bucket} opacity={dimmed ? 0.4 : 1} style={{ transition: "opacity 120ms" }}>
              {visible.map((entry, position) => {
                const segment = ((entry.values[index] ?? 0) / top) * plotHeight;
                const y = base - segment;
                // A surface-colored gap separates stacked segments; tiny segments skip it.
                const gap = position > 0 && segment > SEGMENT_GAP + 1 ? SEGMENT_GAP : 0;
                const drawHeight = Math.max(segment - gap, 0.75);
                base = y;
                return position === visible.length - 1 ? (
                  <path key={entry.key} d={roundedTopPath(x, y, barWidth, drawHeight, CORNER_RADIUS)} fill={entry.color} />
                ) : (
                  <rect key={entry.key} x={x} y={y + 0} width={barWidth} height={drawHeight} fill={entry.color} />
                );
              })}
            </g>
          );
        })}

        {variant === "bar" && active === null ? <text
          x={MARGIN.left + peakIndex * band + band / 2}
          y={yFor(peak) - 5}
          textAnchor={peakIndex > count * 0.85 ? "end" : peakIndex < count * 0.15 ? "start" : "middle"}
          className="fill-[var(--ec-muted)] text-[10px] font-medium tabular-nums"
        >
          {formatValue(peak)}
        </text> : null}

        {variant === "line" && active !== null ? <g>
          <line x1={xFor(active)} x2={xFor(active)} y1={MARGIN.top} y2={yFor(0)} stroke="var(--ec-faint)" strokeDasharray="3 3" />
          {data.series.map((entry) => <circle key={entry.key} cx={xFor(active)} cy={yFor(entry.values[active] ?? 0)} r={3.5} fill={entry.color} stroke="var(--usage-chart-surface)" strokeWidth={1.5} />)}
        </g> : null}

        {data.buckets.map((bucket, index) =>
          index % labelEvery === 0 ? (
            <text
              key={bucket}
              x={MARGIN.left + index * band + band / 2}
              y={height - 6}
              textAnchor="middle"
              className="fill-[var(--ec-faint)] text-[10px] tabular-nums"
            >
              {formatUsageBucket(bucket, data.bucketSize, withYear)}
            </text>
          ) : null,
        )}

        {data.buckets.map((bucket, index) => (
          <rect
            key={`hit-${bucket}`}
            x={MARGIN.left + index * band}
            y={MARGIN.top}
            width={band}
            height={plotHeight}
            fill="transparent"
            onPointerEnter={() => setActive(index)}
            onPointerDown={() => setActive(index)}
          />
        ))}
      </svg>

      {active !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute top-1 z-10 min-w-40 max-w-64 rounded-md border border-[var(--ec-border)] bg-[var(--ec-dialog-bg,var(--ec-bg-elevated))] px-2.5 py-2 shadow-[var(--ec-popover-shadow)]"
          style={tooltipOnLeft ? { right: width - activeCenter + 10 } : { left: activeCenter + 10 }}
        >
          <p className="text-[10px] uppercase tracking-[0.12em] text-[color:var(--ec-faint)]">
            {describeUsageBucket(data.buckets[active]!, data.bucketSize)}
          </p>
          <p className="text-sm font-semibold tabular-nums text-[color:var(--ec-text)]">{formatValue(totals[active] ?? 0)}</p>
          {activeRows.length > 1 ? (
            <ul className="mt-1 space-y-0.5 border-t border-[var(--ec-border)] pt-1">
              {activeRows.map(({ entry, value }) => (
                <li key={entry.key} className="flex items-center gap-2 text-[11px]">
                  <span aria-hidden className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: entry.color }} />
                  <span className="font-medium tabular-nums text-[color:var(--ec-text)]">{formatValue(value)}</span>
                  <span className="min-w-0 truncate text-[color:var(--ec-muted)]">{entry.label}</span>
                </li>
              ))}
            </ul>
          ) : activeRows[0] ? (
            <p className="truncate text-[11px] text-[color:var(--ec-muted)]">{activeRows[0].entry.label}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const UsageStackedBarChart = (props: UsageStackedBarChartProps) => <UsageTimeChart {...props} variant="bar" />;
export const UsageLineChart = (props: UsageStackedBarChartProps) => <UsageTimeChart {...props} variant="line" />;

/** Every plotted value without hovering, for either chart style. */
export const UsageSeriesTable = ({
  data,
  formatValue,
  className,
}: {
  data: UsageTimeSeries;
  formatValue: (value: number) => string;
  className?: string;
}) => {
  const rows = data.buckets
    .map((bucket, index) => ({
      bucket,
      values: data.series.map((entry) => entry.values[index] ?? 0),
    }))
    .filter((row) => row.values.some((value) => value > 0))
    .reverse();
  if (rows.length === 0) return <p className={cn("py-6 text-center text-xs text-[color:var(--ec-faint)]", className)}>No usage in this period</p>;
  return (
    <div className={cn("app-scrollbar overflow-auto", className)}>
      <table className="w-full text-[11px] tabular-nums">
        <thead className="sticky top-0 bg-[var(--ec-dialog-bg,var(--ec-bg-elevated))]">
          <tr className="text-right text-[10px] uppercase tracking-[0.1em] text-[color:var(--ec-faint)]">
            <th scope="col" className="py-1 pr-3 text-left font-medium">{{ hour: "Hour", day: "Day", week: "Week", month: "Month" }[data.bucketSize]}</th>
            {data.series.map((entry) => (
              <th key={entry.key} scope="col" className="max-w-32 truncate py-1 pr-3 font-medium" title={entry.label}>{entry.label}</th>
            ))}
            <th scope="col" className="py-1 font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.bucket} className="border-t border-[var(--ec-border)] text-right text-[color:var(--ec-text)]">
              <th scope="row" className="py-1 pr-3 text-left font-normal text-[color:var(--ec-muted)]">
                {describeUsageBucket(row.bucket, data.bucketSize)}
              </th>
              {row.values.map((value, index) => (
                <td key={data.series[index]!.key} className="py-1 pr-3">{value > 0 ? formatValue(value) : "—"}</td>
              ))}
              <td className="py-1 font-medium">{formatValue(row.values.reduce((sum, value) => sum + value, 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
