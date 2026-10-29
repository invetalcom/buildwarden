import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UsageCostReport } from "@buildwarden/shared";
import { ArrowDown, ArrowUp, Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { SegmentedControl } from "../ui/segmented-control";
import { UsageChartLegend, UsageSeriesTable, UsageStackedBarChart } from "./UsageCharts";
import {
  USAGE_BREAKDOWN_OPTIONS,
  USAGE_RANGE_OPTIONS,
  buildUsageAnalytics,
  buildUsageTimeSeries,
  cacheHitRate,
  costPerMillionTokens,
  formatDelta,
  formatPercent,
  formatRate,
  formatTokenCount,
  formatUsd,
  formatUsdAxis,
  providerTypeLabel,
  usageDelta,
  type UsageBreakdown,
  type UsageBreakdownRow,
  type UsageFilters,
  type UsageMetric,
  type UsageModelEntry,
  type UsageProjectEntry,
  type UsageTimeSeries,
} from "./usage-analytics";


const formatRelativeTime = (iso: string | null): string => {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/** Comparison windows end at the same time of day as now, so a partial today is compared fairly. */
const RANGE_COMPARISON: Record<string, string> = {
  "1": "vs yesterday at this time",
  "7": "vs prior 7 days",
  "30": "vs prior 30 days",
  "90": "vs prior 90 days",
};

type FilterOption = { key: string; label: string; detail?: string; color?: string };

/** Multi-select dimension filter: a button showing the selection, with a checklist popover. */
const FilterMenu = ({
  label,
  options,
  excluded,
  onChange,
}: {
  label: string;
  options: readonly FilterOption[];
  excluded: ReadonlySet<string>;
  onChange: (excluded: Set<string>) => void;
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  const selected = options.filter((option) => !excluded.has(option.key)).length;
  const summary = selected === options.length ? "All" : selected === 0 ? "None" : `${selected} of ${options.length}`;
  const toggle = (key: string) => {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <div
      ref={rootRef}
      // Size text on wrappers: the global unlayered `button { font: inherit }` beats utilities on buttons.
      className="relative text-xs"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={options.length === 0}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2.5 text-xs text-[color:var(--ec-muted)] transition hover:text-[color:var(--ec-text)] disabled:opacity-50",
          selected < options.length && "border-[var(--ec-accent-ring)] text-[color:var(--ec-text)]",
        )}
      >
        {label}
        <span className="font-medium text-[color:var(--ec-text)]">{summary}</span>
        <ChevronDown className="size-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-30 w-72 rounded-md border border-[var(--ec-border)] bg-[var(--ec-dialog-bg,var(--ec-bg-elevated))] py-1 shadow-[var(--ec-popover-shadow)]">
          <div className="flex items-center justify-between border-b border-[var(--ec-border)] px-2.5 pb-1 pt-0.5 text-[11px]">
            <span className="text-[color:var(--ec-faint)]">{label}</span>
            <span className="flex gap-2">
              <button type="button" className="text-[color:var(--ec-accent)] hover:underline" onClick={() => onChange(new Set())}>All</button>
              <button type="button" className="text-[color:var(--ec-accent)] hover:underline" onClick={() => onChange(new Set(options.map((option) => option.key)))}>None</button>
            </span>
          </div>
          <ul className="app-scrollbar max-h-72 overflow-y-auto py-1 text-xs" role="listbox" aria-multiselectable aria-label={label}>
            {options.map((option) => {
              const checked = !excluded.has(option.key);
              return (
                <li key={option.key} role="option" aria-selected={checked}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-[var(--ec-hover)]"
                    onClick={() => toggle(option.key)}
                  >
                    <span className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
                      checked ? "border-[var(--ec-accent)] bg-[var(--ec-accent)] text-[color:var(--ec-accent-foreground)]" : "border-[var(--ec-border-strong,var(--ec-border))]",
                    )}>
                      {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
                    </span>
                    {option.color ? <span aria-hidden className="size-2.5 shrink-0 rounded-[2px]" style={{ background: option.color }} /> : null}
                    <span className="min-w-0 flex-1 truncate text-[color:var(--ec-text)]">{option.label}</span>
                    {option.detail ? <span className="shrink-0 text-[10px] text-[color:var(--ec-faint)]">{option.detail}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
};

const KpiTile = ({
  label,
  value,
  detail,
  delta,
  comparison,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  delta?: number | null;
  comparison?: string;
}) => (
  <div className="min-w-0 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2.5">
    <p className="truncate text-[11px] text-[color:var(--ec-muted)]">{label}</p>
    <p className="mt-0.5 truncate text-xl font-semibold text-[color:var(--ec-text)]">{value}</p>
    <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[11px] text-[color:var(--ec-faint)]">
      {delta !== undefined && delta !== null ? (
        <span className="inline-flex shrink-0 items-center font-medium text-[color:var(--ec-muted)]">
          {delta > 0 ? <ArrowUp className="size-3" /> : delta < 0 ? <ArrowDown className="size-3" /> : null}
          {formatDelta(delta)}
        </span>
      ) : null}
      {delta !== undefined && delta !== null && comparison ? <span className="truncate">{comparison}</span> : null}
      {delta === undefined || delta === null ? detail : null}
    </p>
  </div>
);

const ChartCard = ({
  title,
  total,
  data,
  formatValue,
  formatAxis,
}: {
  title: string;
  total: string;
  data: UsageTimeSeries;
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
}) => {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <Card className="min-w-0 !bg-[var(--ec-panel)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-medium text-[color:var(--ec-muted)]">{title}</h3>
          <p className="text-lg font-semibold text-[color:var(--ec-text)]">{total}</p>
        </div>
        <SegmentedControl
          label={`${title} view`}
          options={[{ value: "chart", label: "Chart" }, { value: "table", label: "Table" }] as const}
          value={view}
          onChange={setView}
        />
      </div>
      {data.series.length > 1 ? <UsageChartLegend series={data.series} className="mt-2" /> : null}
      {view === "chart" ? (
        <UsageStackedBarChart className="mt-2" data={data} formatValue={formatValue} formatAxis={formatAxis} ariaLabel={`${title} over time`} />
      ) : (
        <UsageSeriesTable className="mt-2 max-h-[208px]" data={data} formatValue={formatValue} />
      )}
    </Card>
  );
};

type ModelSortKey = "cost" | "tokens" | "input" | "cacheRead" | "cacheWrite" | "output" | "cacheHit";

const MODEL_SORT_VALUE: Record<ModelSortKey, (row: UsageBreakdownRow<UsageModelEntry>) => number> = {
  cost: (row) => row.totals.costUsd,
  tokens: (row) => row.totals.totalTokens,
  input: (row) => row.totals.tokens.uncachedInputTokens,
  cacheRead: (row) => row.totals.tokens.cacheReadTokens,
  cacheWrite: (row) => row.totals.tokens.cacheWriteTokens,
  output: (row) => row.totals.tokens.outputTokens,
  cacheHit: (row) => cacheHitRate(row.totals),
};

const ShareBar = ({ share, color }: { share: number; color: string }) => (
  <span className="flex items-center gap-1.5">
    <span className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--ec-control)]">
      <span className="block h-full rounded-full" style={{ width: `${Math.min(100, share * 100)}%`, background: color }} />
    </span>
    <span className="w-8 text-right text-[color:var(--ec-muted)]">{formatPercent(share)}</span>
  </span>
);

const IncludeToggle = ({ included, label, color, onToggle }: { included: boolean; label: string; color: string; onToggle: () => void }) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={included}
    aria-label={`Include ${label}`}
    onClick={onToggle}
    className={cn(
      "flex size-4 shrink-0 items-center justify-center rounded-[3px] border transition",
      included ? "border-transparent" : "border-[var(--ec-border)] bg-transparent",
    )}
    style={included ? { background: color } : undefined}
  >
    {included ? <Check className="size-3 text-white" strokeWidth={3} /> : null}
  </button>
);

const ModelsTable = ({
  rows,
  onToggle,
}: {
  rows: Array<UsageBreakdownRow<UsageModelEntry>>;
  onToggle: (key: string) => void;
}) => {
  const [sort, setSort] = useState<{ key: ModelSortKey; descending: boolean }>({ key: "cost", descending: true });
  const sorted = useMemo(() => {
    const value = MODEL_SORT_VALUE[sort.key];
    return [...rows].sort((a, b) => (sort.descending ? value(b) - value(a) : value(a) - value(b)));
  }, [rows, sort]);
  const header = (key: ModelSortKey, label: string, title?: string) => (
    <th scope="col" className="py-1.5 pr-3 font-medium" aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        title={title}
        className={cn("inline-flex items-center gap-0.5 uppercase hover:text-[color:var(--ec-text)]", sort.key === key && "text-[color:var(--ec-text)]")}
        onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : true }))}
      >
        {label}
        {sort.key === key ? (sort.descending ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />) : null}
      </button>
    </th>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-right text-[10px] tracking-[0.08em] text-[color:var(--ec-faint)]">
            <th scope="col" className="py-1.5 pr-3 text-left font-medium uppercase">Model</th>
            {header("input", "Input", "Uncached input tokens")}
            {header("cacheRead", "Cache read")}
            {header("cacheWrite", "Cache write")}
            {header("output", "Output")}
            {header("cacheHit", "Cache hit", "Share of input served from cache")}
            <th scope="col" className="py-1.5 pr-3 font-medium uppercase" title="USD per 1M input / output tokens">$/1M in · out</th>
            {header("cost", "Est. cost")}
            <th scope="col" className="py-1.5 font-medium uppercase">Share</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.entry.key} className={cn("border-t border-[var(--ec-border)] text-right text-[color:var(--ec-text)]", row.excluded && "opacity-45")}>
              <td className="max-w-72 py-1.5 pr-3 text-left">
                <div className="flex items-center gap-2">
                  <IncludeToggle included={!row.excluded} label={row.entry.label} color={row.entry.color} onToggle={() => onToggle(row.entry.key)} />
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={row.entry.label}>{row.entry.label}</p>
                    <p className="truncate text-[10px] text-[color:var(--ec-faint)]">
                      {row.entry.modelId === null
                        ? "No model or cache split recorded"
                        : `${providerTypeLabel(row.entry.providerType)}${row.entry.matchedKey && row.entry.matchedKey !== row.entry.modelId.toLowerCase() ? ` · priced as ${row.entry.matchedKey}` : ""}`}
                    </p>
                  </div>
                </div>
              </td>
              <td className="py-1.5 pr-3">{formatTokenCount(row.totals.tokens.uncachedInputTokens)}</td>
              <td className="py-1.5 pr-3">{formatTokenCount(row.totals.tokens.cacheReadTokens)}</td>
              <td className="py-1.5 pr-3">{formatTokenCount(row.totals.tokens.cacheWriteTokens)}</td>
              <td className="py-1.5 pr-3">{formatTokenCount(row.totals.tokens.outputTokens)}</td>
              <td className="py-1.5 pr-3">{row.entry.modelId === null ? "—" : formatPercent(cacheHitRate(row.totals))}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-[color:var(--ec-muted)]">
                {row.entry.rates ? `${formatRate(row.entry.rates.inputPerMillion)} · ${formatRate(row.entry.rates.outputPerMillion)}` : "—"}
              </td>
              <td className="py-1.5 pr-3 font-semibold">
                {row.entry.rates ? formatUsd(row.totals.costUsd) : <span className="font-normal text-[color:var(--ec-faint)]">No price</span>}
              </td>
              <td className="py-1.5"><ShareBar share={row.share} color={row.entry.color} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ProjectsTable = ({
  rows,
  onToggle,
}: {
  rows: Array<UsageBreakdownRow<UsageProjectEntry>>;
  onToggle: (key: string) => void;
}) => (
  <table className="w-full text-xs tabular-nums">
    <thead>
      <tr className="text-right text-[10px] uppercase tracking-[0.08em] text-[color:var(--ec-faint)]">
        <th scope="col" className="py-1.5 pr-3 text-left font-medium">Project</th>
        <th scope="col" className="py-1.5 pr-3 font-medium">Tokens</th>
        <th scope="col" className="py-1.5 pr-3 font-medium">Est. cost</th>
        <th scope="col" className="py-1.5 font-medium">Share</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr key={row.entry.key} className={cn("border-t border-[var(--ec-border)] text-right text-[color:var(--ec-text)]", row.excluded && "opacity-45")}>
          <td className="max-w-56 py-1.5 pr-3 text-left">
            <div className="flex items-center gap-2">
              <IncludeToggle included={!row.excluded} label={row.entry.label} color={row.entry.color} onToggle={() => onToggle(row.entry.key)} />
              <span className="truncate font-medium" title={row.entry.label}>{row.entry.label}</span>
            </div>
          </td>
          <td className="py-1.5 pr-3">{formatTokenCount(row.totals.totalTokens)}</td>
          <td className="py-1.5 pr-3 font-semibold">{formatUsd(row.totals.costUsd)}</td>
          <td className="py-1.5"><ShareBar share={row.share} color={row.entry.color} /></td>
        </tr>
      ))}
    </tbody>
  </table>
);

const toggled = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

/** Usage & cost analytics, shown as the Home page's "Usage & cost" tab while cost tracking is on. */
export const UsagePage = () => {
  const buildwarden = useBuildWardenClient();
  const [rangeDays, setRangeDays] = useState<number | null>(30);
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<UsageFilters>({ excludedModels: new Set(), excludedProjects: new Set() });
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("model");

  // Each load gets a sequence number; only the latest may update state, so a slow response for
  // an earlier period can never overwrite the one the user has since selected.
  const latestRequest = useRef(0);
  const loadReport = useCallback(async (refreshPricing = false) => {
    const request = ++latestRequest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await buildwarden.getUsageCostReport({ rangeDays, refreshPricing });
      if (request === latestRequest.current) setReport(next);
    } catch (caught) {
      if (request === latestRequest.current) setError(caught instanceof Error ? caught.message : "Usage could not be loaded.");
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [buildwarden, rangeDays]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const analytics = useMemo(() => (report ? buildUsageAnalytics(report, filters) : null), [report, filters]);
  const costSeries = useMemo(() => (analytics ? buildUsageTimeSeries(analytics, breakdown, "cost" satisfies UsageMetric) : null), [analytics, breakdown]);
  const tokenSeries = useMemo(() => (analytics ? buildUsageTimeSeries(analytics, breakdown, "tokens") : null), [analytics, breakdown]);

  const modelOptions = useMemo(
    () => (analytics?.modelRows ?? []).map((row) => ({
      key: row.entry.key,
      label: row.entry.label,
      detail: row.entry.modelId === null ? "unpriced" : providerTypeLabel(row.entry.providerType),
      color: row.entry.color,
    })),
    [analytics],
  );
  const projectOptions = useMemo(
    () => (analytics?.projectRows ?? []).map((row) => ({ key: row.entry.key, label: row.entry.label, color: row.entry.color })),
    [analytics],
  );

  const current = analytics?.current;
  const previous = analytics?.previous ?? null;
  // Label the KPIs by the report they show, not the period picked while its replacement loads.
  const comparison = report?.rangeDays == null ? undefined : RANGE_COMPARISON[String(report.rangeDays)];
  const blended = current ? costPerMillionTokens(current) : null;

  return (
    <div className="space-y-3">
      <Card className="relative z-10 p-0">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
          <SegmentedControl label="Period" options={USAGE_RANGE_OPTIONS.map((option) => ({ value: option.days, label: option.label }))} value={rangeDays} onChange={setRangeDays} />
          <FilterMenu
            label="Models"
            options={modelOptions}
            excluded={filters.excludedModels}
            onChange={(excludedModels) => setFilters((current) => ({ ...current, excludedModels }))}
          />
          <FilterMenu
            label="Projects"
            options={projectOptions}
            excluded={filters.excludedProjects}
            onChange={(excludedProjects) => setFilters((current) => ({ ...current, excludedProjects }))}
          />
          {filters.excludedModels.size + filters.excludedProjects.size > 0 ? (
            <button type="button" className="text-xs text-[color:var(--ec-accent)] hover:underline" onClick={() => setFilters({ excludedModels: new Set(), excludedProjects: new Set() })}>
              Clear filters
            </button>
          ) : null}
          {loading && report ? <Loader2 className="size-3.5 animate-spin text-[color:var(--ec-faint)]" /> : null}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] text-[color:var(--ec-faint)]">Break down by</span>
            <SegmentedControl label="Break down by" options={USAGE_BREAKDOWN_OPTIONS} value={breakdown} onChange={setBreakdown} />
            <Button type="button" size="icon" variant="ghost" className="size-7" disabled={loading} title="Refresh prices" aria-label="Refresh prices" onClick={() => void loadReport(true)}>
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </Card>

      <div>
          {error ? <p className="mb-3 rounded-md border border-[var(--ec-danger)] px-3 py-2 text-xs text-[color:var(--ec-danger)]">{error}</p> : null}
          {report?.pricing.error ? <p className="mb-3 text-[11px] text-[color:var(--ec-warning)]">{report.pricing.error}</p> : null}
          {!analytics || !current || !costSeries || !tokenSeries ? (
            loading ? <div className="flex h-60 items-center justify-center"><Loader2 className="size-5 animate-spin text-[color:var(--ec-accent)]" /></div> : null
          ) : (
            <div className={cn("space-y-3 transition-opacity", loading && "opacity-60")}>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                <KpiTile
                  label="Estimated API cost"
                  value={formatUsd(current.costUsd)}
                  delta={previous ? usageDelta(current.costUsd, previous.costUsd) : undefined}
                  comparison={comparison}
                  detail="List prices, not your bill"
                />
                <KpiTile
                  label="Tokens"
                  value={formatTokenCount(current.totalTokens)}
                  delta={previous ? usageDelta(current.totalTokens, previous.totalTokens) : undefined}
                  comparison={comparison}
                  detail={`${formatTokenCount(current.tokens.inputTokens)} in · ${formatTokenCount(current.tokens.outputTokens)} out`}
                />
                <KpiTile
                  label="Cache hit rate"
                  value={formatPercent(cacheHitRate(current))}
                  detail={`${formatTokenCount(current.tokens.cacheReadTokens)} cached input tokens`}
                />
                <KpiTile
                  label="Net cache savings"
                  value={formatUsd(current.cacheSavingsUsd)}
                  detail={blended === null ? "No priced usage" : `Blended ${formatRate(blended)} per 1M tokens`}
                />
                <KpiTile
                  label="Unpriced tokens"
                  value={formatTokenCount(current.unpricedTokens)}
                  detail={current.unpricedTokens > 0 ? "No public price or recorded before tracking" : "Every model is priced"}
                />
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <ChartCard title="Estimated cost" total={formatUsd(current.costUsd)} data={costSeries} formatValue={formatUsd} formatAxis={formatUsdAxis} />
                <ChartCard title="Tokens" total={formatTokenCount(current.totalTokens)} data={tokenSeries} formatValue={formatTokenCount} formatAxis={formatTokenCount} />
              </div>

              <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <Card className="min-w-0 !bg-[var(--ec-panel)] p-3">
                  <h3 className="mb-1 text-xs font-medium text-[color:var(--ec-muted)]">Models</h3>
                  {analytics.modelRows.length > 0 ? (
                    <ModelsTable
                      rows={analytics.modelRows}
                      onToggle={(key) => setFilters((current) => ({ ...current, excludedModels: toggled(current.excludedModels, key) }))}
                    />
                  ) : <p className="py-4 text-xs text-[color:var(--ec-faint)]">No usage in this period.</p>}
                </Card>
                <Card className="min-w-0 !bg-[var(--ec-panel)] p-3">
                  <h3 className="mb-1 text-xs font-medium text-[color:var(--ec-muted)]">Projects</h3>
                  {analytics.projectRows.length > 0 ? (
                    <ProjectsTable
                      rows={analytics.projectRows}
                      onToggle={(key) => setFilters((current) => ({ ...current, excludedProjects: toggled(current.excludedProjects, key) }))}
                    />
                  ) : <p className="py-4 text-xs text-[color:var(--ec-faint)]">No usage in this period.</p>}
                </Card>
              </div>
            </div>
          )}
      </div>

      <p className="px-1 pb-2 text-[11px] text-[color:var(--ec-faint)]">
        {report ? (
          <span
            className={cn(report.pricing.status === "unavailable" && "text-[color:var(--ec-warning)]")}
            title={[report.pricing.source, report.pricing.error].filter(Boolean).join("\n")}
          >
            {report.pricing.status === "unavailable"
              ? "Price list unavailable."
              : `LiteLLM list prices · ${report.pricing.knownModels.toLocaleString()} models · updated ${formatRelativeTime(report.pricing.fetchedAt)}.`}{" "}
          </span>
        ) : null}
        Public per-token API list prices applied to recorded usage. Subscription plans bill differently, so this is an API-equivalent estimate, not your bill.
      </p>
    </div>
  );
};
