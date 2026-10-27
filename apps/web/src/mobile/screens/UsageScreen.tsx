import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isUsageCostTrackingEnabled, type UsageCostReport } from "@buildwarden/shared";
import { UsageChartLegend, UsageSeriesTable, UsageStackedBarChart } from "@buildwarden/renderer";
import {
  USAGE_BREAKDOWN_OPTIONS,
  USAGE_RANGE_OPTIONS,
  buildUsageAnalytics,
  buildUsageTimeSeries,
  cacheHitRate,
  formatDelta,
  formatPercent,
  formatTokenCount,
  formatUsd,
  formatUsdAxis,
  providerTypeLabel,
  usageDelta,
  type UsageBreakdown,
  type UsageBreakdownRow,
  type UsageFilters,
  type UsageModelEntry,
  type UsageProjectEntry,
  type UsageTimeSeries,
} from "@buildwarden/renderer/logic";
import { Check, ChevronDown, CircleDollarSign, RefreshCw } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { errorMessage, relativeTime } from "../lib/format";
import { cn } from "../lib/cn";
import { AppBar } from "../components/AppBar";
import { ActionSheet, Sheet } from "../components/Sheet";
import {
  Button,
  CenteredSpinner,
  EmptyState,
  IconButton,
  InlineError,
  SectionLabel,
  SegmentedTabs,
  type SegmentOption,
} from "../components/primitives";

type RangeKey = "1" | "7" | "30" | "90" | "all";

const RANGE_OPTIONS: readonly SegmentOption<RangeKey>[] = USAGE_RANGE_OPTIONS.map((option) => ({
  value: (option.days === null ? "all" : String(option.days)) as RangeKey,
  label: option.label,
}));

const rangeDaysFor = (key: RangeKey): number | null => key === "all" ? null : Number(key);

const COMPARISON: Record<RangeKey, string | undefined> = {
  "1": "vs yesterday at this time",
  "7": "vs prior 7 days",
  "30": "vs prior 30 days",
  "90": "vs prior 90 days",
  all: undefined,
};

const toggled = (set: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

const FilterChip = ({ label, value, active, onClick }: { label: string; value: string; active: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "m-tap flex shrink-0 items-center gap-1 rounded-full border px-3 text-xs transition active:bg-[var(--ec-hover)]",
      active ? "border-[var(--ec-accent-ring)] text-[color:var(--ec-text)]" : "border-[var(--ec-border)] text-[color:var(--ec-muted)]",
    )}
  >
    {label}
    <span className="font-medium text-[color:var(--ec-text)]">{value}</span>
    <ChevronDown className="size-3.5" />
  </button>
);

const Kpi = ({ label, value, detail }: { label: string; value: string; detail?: ReactNode }) => (
  <div className="min-w-0 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2">
    <p className="truncate text-[11px] text-[color:var(--ec-muted)]">{label}</p>
    <p className="truncate text-lg font-semibold">{value}</p>
    {detail ? <p className="truncate text-[11px] text-[color:var(--ec-faint)]">{detail}</p> : null}
  </div>
);

const deltaDetail = (delta: number | null, comparison: string | undefined, fallback: string): string =>
  delta !== null && comparison ? `${formatDelta(delta)} ${comparison}` : fallback;

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
  const [table, setTable] = useState(false);
  return (
    <section className="mx-4 mt-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 pt-2.5 pb-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-[color:var(--ec-muted)]">{title}</p>
          <p className="text-base font-semibold">{total}</p>
        </div>
        <button type="button" className="m-tap px-1 text-xs font-medium text-[color:var(--ec-accent)]" onClick={() => setTable((current) => !current)}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {data.series.length > 1 ? <UsageChartLegend series={data.series} className="mt-1.5" /> : null}
      {table ? (
        <UsageSeriesTable className="mt-2 max-h-56" data={data} formatValue={formatValue} />
      ) : (
        <UsageStackedBarChart className="mt-1" data={data} formatValue={formatValue} formatAxis={formatAxis} ariaLabel={`${title} over time`} plotHeight={132} />
      )}
    </section>
  );
};

/** A list row that switches one model or project in or out of every number on the screen. */
const IncludeRow = ({
  label,
  subtitle,
  color,
  value,
  share,
  excluded,
  onToggle,
}: {
  label: string;
  subtitle: string;
  color: string;
  value: ReactNode;
  share: number;
  excluded: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={!excluded}
    onClick={onToggle}
    className={cn("m-tap flex w-full items-center gap-3 border-b border-[var(--ec-border)] px-4 py-2 text-left transition active:bg-[var(--ec-hover)]", excluded && "opacity-45")}
  >
    <span
      aria-hidden
      className={cn("flex size-5 shrink-0 items-center justify-center rounded", excluded && "border border-[var(--ec-border)]")}
      style={excluded ? undefined : { background: color }}
    >
      {excluded ? null : <Check className="size-3.5 text-white" strokeWidth={3} />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-[13px] font-medium">{label}</span>
      <span className="truncate text-[11px] text-[color:var(--ec-muted)]">{subtitle}</span>
    </span>
    <span className="flex shrink-0 flex-col items-end">
      <span className="text-sm font-semibold">{value}</span>
      <span className="text-[11px] text-[color:var(--ec-faint)]">{formatPercent(share)}</span>
    </span>
  </button>
);

const FilterSheet = ({
  open,
  title,
  options,
  excluded,
  onChange,
  onClose,
}: {
  open: boolean;
  title: string;
  options: ReadonlyArray<{ key: string; label: string; color: string }>;
  excluded: ReadonlySet<string>;
  onChange: (excluded: Set<string>) => void;
  onClose: () => void;
}) => (
  <Sheet
    open={open}
    onClose={onClose}
    title={title}
    footer={(
      <div className="flex gap-2">
        <Button block tone="neutral" onClick={() => onChange(new Set())}>Select all</Button>
        <Button block tone="neutral" onClick={() => onChange(new Set(options.map((option) => option.key)))}>Clear</Button>
      </div>
    )}
  >
    <div className="py-1">
      {options.map((option) => {
        const checked = !excluded.has(option.key);
        return (
          <button
            key={option.key}
            type="button"
            role="checkbox"
            aria-checked={checked}
            onClick={() => onChange(toggled(excluded, option.key))}
            className="m-tap flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition active:bg-[var(--ec-hover)]"
          >
            <span
              aria-hidden
              className={cn("flex size-5 shrink-0 items-center justify-center rounded", !checked && "border border-[var(--ec-border)]")}
              style={checked ? { background: option.color } : undefined}
            >
              {checked ? <Check className="size-3.5 text-white" strokeWidth={3} /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  </Sheet>
);

const modelSubtitle = (row: UsageBreakdownRow<UsageModelEntry>): string =>
  row.entry.modelId === null
    ? `No model recorded · ${formatTokenCount(row.totals.totalTokens)} tokens`
    : `${providerTypeLabel(row.entry.providerType)} · ${formatTokenCount(row.totals.totalTokens)} tokens · ${formatPercent(cacheHitRate(row.totals))} cached`;

/**
 * Estimated API-equivalent cost of recorded runs and chats, the mobile counterpart of the desktop
 * usage dashboard. Reachable from More and from Settings → Network while the host has tracking on.
 */
export const UsageScreen = () => {
  const { client, snapshot, router } = useMobileApp();
  const enabled = isUsageCostTrackingEnabled(snapshot);
  const [rangeKey, setRangeKey] = useState<RangeKey>("30");
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<UsageFilters>({ excludedModels: new Set(), excludedProjects: new Set() });
  const [breakdown, setBreakdown] = useState<UsageBreakdown>("model");
  const [sheet, setSheet] = useState<"models" | "projects" | "breakdown" | null>(null);

  // Only the latest request may update state, so a slow response for an earlier period never
  // replaces the one the user has since switched to.
  const latestRequest = useRef(0);
  const load = useCallback(async (refreshPricing = false) => {
    if (!enabled) return;
    const request = ++latestRequest.current;
    setLoading(true);
    try {
      const next = await client.getUsageCostReport({ rangeDays: rangeDaysFor(rangeKey), refreshPricing });
      if (request !== latestRequest.current) return;
      setReport(next);
      setError(null);
    } catch (caught) {
      if (request === latestRequest.current) setError(errorMessage(caught, "Could not load usage."));
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [client, enabled, rangeKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const analytics = useMemo(() => (report ? buildUsageAnalytics(report, filters) : null), [report, filters]);
  const costSeries = useMemo(() => (analytics ? buildUsageTimeSeries(analytics, breakdown, "cost") : null), [analytics, breakdown]);
  const tokenSeries = useMemo(() => (analytics ? buildUsageTimeSeries(analytics, breakdown, "tokens") : null), [analytics, breakdown]);

  if (!enabled) {
    return (
      <>
        <AppBar title="Usage & cost" onBack={router.back} />
        <EmptyState
          icon={<CircleDollarSign className="size-7" />}
          title="Cost tracking is off"
          message={client.capabilities.settings
            ? "Turn it on in Settings → Network. The host then downloads a public model price list to estimate costs."
            : "An admin session or the desktop app can turn it on in Settings → Network."}
          action={client.capabilities.settings ? (
            <Button tone="neutral" onClick={() => router.push({ name: "settings", section: "network" })}>Open network settings</Button>
          ) : undefined}
        />
      </>
    );
  }

  const pricingSubtitle = !report
    ? "Estimated API cost"
    : report.pricing.status === "unavailable"
      ? "Price list unavailable"
      : `LiteLLM list prices · updated ${relativeTime(report.pricing.fetchedAt)}`;
  const summary = (options: ReadonlyArray<{ key: string }>, excluded: ReadonlySet<string>) => {
    const selected = options.filter((option) => !excluded.has(option.key)).length;
    return selected === options.length ? "All" : `${selected}/${options.length}`;
  };
  const modelOptions = (analytics?.modelRows ?? []).map((row) => ({ key: row.entry.key, label: row.entry.label, color: row.entry.color }));
  const projectOptions = (analytics?.projectRows ?? []).map((row) => ({ key: row.entry.key, label: row.entry.label, color: row.entry.color }));
  const current = analytics?.current;
  const previous = analytics?.previous ?? null;
  // Label the KPIs by the report they show, not the period picked while its replacement loads.
  const comparison = report?.rangeDays == null ? undefined : COMPARISON[String(report.rangeDays) as RangeKey];

  return (
    <>
      <AppBar
        title="Usage & cost"
        subtitle={pricingSubtitle}
        onBack={router.back}
        actions={(
          <IconButton label="Refresh prices" disabled={loading} onClick={() => void load(true)}>
            <RefreshCw className={cn("size-5", loading && "animate-spin")} />
          </IconButton>
        )}
      />
      <SegmentedTabs options={RANGE_OPTIONS} value={rangeKey} onChange={setRangeKey} />
      <div className="m-scroll-x flex shrink-0 gap-2 border-b border-[var(--ec-border)] px-4 py-1.5">
        <FilterChip label="Models" value={summary(modelOptions, filters.excludedModels)} active={filters.excludedModels.size > 0} onClick={() => setSheet("models")} />
        <FilterChip label="Projects" value={summary(projectOptions, filters.excludedProjects)} active={filters.excludedProjects.size > 0} onClick={() => setSheet("projects")} />
        <FilterChip
          label="By"
          value={USAGE_BREAKDOWN_OPTIONS.find((option) => option.value === breakdown)?.label ?? ""}
          active={false}
          onClick={() => setSheet("breakdown")}
        />
      </div>

      <div className="m-scroll m-screen-enter flex-1">
        {error ? <InlineError message={error} onRetry={() => void load()} /> : null}
        {report?.pricing.error ? <p className="px-4 pt-3 text-[11px] leading-4 text-[color:var(--ec-warning)]">{report.pricing.error}</p> : null}
        {!analytics || !current || !costSeries || !tokenSeries ? (
          loading ? <CenteredSpinner label="Loading usage" /> : null
        ) : (
          <div className={cn("transition-opacity", loading && "opacity-60")}>
            <div className="grid grid-cols-2 gap-2 px-4 pt-3">
              <Kpi
                label="Estimated API cost"
                value={formatUsd(current.costUsd)}
                detail={deltaDetail(previous ? usageDelta(current.costUsd, previous.costUsd) : null, comparison, "List prices, not your bill")}
              />
              <Kpi
                label="Tokens"
                value={formatTokenCount(current.totalTokens)}
                detail={deltaDetail(previous ? usageDelta(current.totalTokens, previous.totalTokens) : null, comparison, `${formatTokenCount(current.tokens.outputTokens)} output`)}
              />
              <Kpi label="Cache hit rate" value={formatPercent(cacheHitRate(current))} detail={`Net savings ${formatUsd(current.cacheSavingsUsd)}`} />
              <Kpi label="Unpriced tokens" value={formatTokenCount(current.unpricedTokens)} detail={current.unpricedTokens > 0 ? "No public price" : "Every model priced"} />
            </div>

            <ChartCard title="Estimated cost" total={formatUsd(current.costUsd)} data={costSeries} formatValue={formatUsd} formatAxis={formatUsdAxis} />
            <ChartCard title="Tokens" total={formatTokenCount(current.totalTokens)} data={tokenSeries} formatValue={formatTokenCount} formatAxis={formatTokenCount} />

            <SectionLabel>Models</SectionLabel>
            {analytics.modelRows.length === 0 ? <p className="px-4 pb-2 text-xs text-[color:var(--ec-muted)]">No usage in this period.</p> : null}
            {analytics.modelRows.map((row) => (
              <IncludeRow
                key={row.entry.key}
                label={row.entry.label}
                subtitle={modelSubtitle(row)}
                color={row.entry.color}
                value={row.entry.rates ? formatUsd(row.totals.costUsd) : <span className="text-xs font-normal text-[color:var(--ec-faint)]">No price</span>}
                share={row.share}
                excluded={row.excluded}
                onToggle={() => setFilters((state) => ({ ...state, excludedModels: toggled(state.excludedModels, row.entry.key) }))}
              />
            ))}

            {analytics.projectRows.length > 0 ? <SectionLabel>Projects</SectionLabel> : null}
            {analytics.projectRows.map((row: UsageBreakdownRow<UsageProjectEntry>) => (
              <IncludeRow
                key={row.entry.key}
                label={row.entry.label}
                subtitle={`${formatTokenCount(row.totals.totalTokens)} tokens`}
                color={row.entry.color}
                value={formatUsd(row.totals.costUsd)}
                share={row.share}
                excluded={row.excluded}
                onToggle={() => setFilters((state) => ({ ...state, excludedProjects: toggled(state.excludedProjects, row.entry.key) }))}
              />
            ))}

            <p className="px-4 py-4 text-[11px] leading-4 text-[color:var(--ec-faint)]">
              Public per-token API list prices applied to recorded usage. Subscription plans bill differently, so this is an
              API-equivalent estimate, not your bill. Tap a model or project to include or exclude it.
            </p>
          </div>
        )}
      </div>

      <FilterSheet
        open={sheet === "models"}
        title="Models"
        options={modelOptions}
        excluded={filters.excludedModels}
        onChange={(excludedModels) => setFilters((state) => ({ ...state, excludedModels }))}
        onClose={() => setSheet(null)}
      />
      <FilterSheet
        open={sheet === "projects"}
        title="Projects"
        options={projectOptions}
        excluded={filters.excludedProjects}
        onChange={(excludedProjects) => setFilters((state) => ({ ...state, excludedProjects }))}
        onClose={() => setSheet(null)}
      />
      <ActionSheet
        open={sheet === "breakdown"}
        onClose={() => setSheet(null)}
        title="Break down charts by"
        actions={USAGE_BREAKDOWN_OPTIONS.map((option) => ({
          label: option.label,
          icon: option.value === breakdown ? <Check className="size-4" /> : <span className="block size-4" />,
          onSelect: () => setBreakdown(option.value),
        }))}
      />
    </>
  );
};
