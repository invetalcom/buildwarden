import type {
  ProjectActivityInsightData,
  ProjectActivityQueryInput,
  ProjectActivityQueryResult,
} from "@buildwarden/shared";
import { CalendarRange, Filter, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { reportRendererError } from "../../lib/report-renderer-error";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

interface ProjectActivityExplorerProps {
  projectId: string;
  activity: ProjectActivityInsightData;
  onScopeActiveChange: (active: boolean) => void;
}

type PeriodPreset = "all" | "30" | "90" | "365" | "custom";

const numberFormatter = new Intl.NumberFormat();
const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

const formatNumber = (value: number): string => numberFormatter.format(value);
const formatCompactNumber = (value: number): string => compactNumberFormatter.format(value);

const formatShortDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
};

const dateKeyDaysAgo = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

const periodFilters = (preset: PeriodPreset, customFrom: string, customTo: string): Pick<ProjectActivityQueryInput, "dateFrom" | "dateTo"> => {
  if (preset === "custom") return { ...(customFrom ? { dateFrom: customFrom } : {}), ...(customTo ? { dateTo: customTo } : {}) };
  if (preset === "all") return {};
  return { dateFrom: dateKeyDaysAgo(Number.parseInt(preset, 10) - 1), dateTo: dateKeyDaysAgo(0) };
};

const ScopeMetric = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="min-w-0 px-3 py-2 first:pl-0 last:pr-0">
    <p className="text-[9px] font-medium uppercase tracking-[0.1em] text-[var(--ec-faint)]">{label}</p>
    <p className="mt-0.5 truncate text-base font-semibold tabular-nums text-[var(--ec-text)]">{value}</p>
    <p className="truncate text-[10px] text-[var(--ec-muted)]">{detail}</p>
  </div>
);

const FilterChip = ({ label, onRemove }: { label: string; onRemove: () => void }) => (
  <button
    type="button"
    className="inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-[10px] text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
    onClick={onRemove}
    title={`Remove ${label} filter`}
  >
    <span className="truncate">{label}</span>
    <X className="size-3 shrink-0 text-[var(--ec-faint)]" />
  </button>
);

const Breakdown = ({
  result,
  onDrilldown,
}: {
  result: ProjectActivityQueryResult;
  onDrilldown: (filters: ProjectActivityQueryResult["groups"][number]["drilldown"]) => void;
}) => {
  const chronological = result.groupBy === "day" || result.groupBy === "week" || result.groupBy === "month";
  const rows = chronological ? result.groups.slice(-18) : result.groups.slice(0, 18);
  const maxCommits = Math.max(1, ...rows.map((row) => row.commits));
  return (
    <section className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">Breakdown</h4>
        <p className="text-[10px] text-[var(--ec-faint)]">
          Grouped by {result.groupBy} · click a row to filter
        </p>
      </div>
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className="group grid w-full grid-cols-[minmax(7rem,1.15fr)_minmax(8rem,2fr)_4rem_5rem] items-center gap-3 py-2 text-left transition hover:bg-[var(--ec-hover)]"
            onClick={() => onDrilldown(row.drilldown)}
          >
            <span className="truncate text-xs text-[var(--ec-text)]" title={row.label}>{row.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
              <span className="block h-full rounded-full bg-[var(--ec-accent)] transition-[width] duration-300" style={{ width: `${Math.max(2, (row.commits / maxCommits) * 100)}%` }} />
            </span>
            <span className="text-right text-xs font-medium tabular-nums text-[var(--ec-text)]">{formatNumber(row.commits)}</span>
            <span className="text-right text-[10px] tabular-nums text-[var(--ec-faint)]">{formatCompactNumber(row.linesChanged)} lines</span>
          </button>
        ))}
        {rows.length === 0 ? <p className="py-8 text-center text-xs text-[var(--ec-muted)]">No matching groups</p> : null}
      </div>
      {result.totalGroups > rows.length ? (
        <p className="mt-1.5 text-right text-[10px] text-[var(--ec-faint)]">Showing {rows.length} of {formatNumber(result.totalGroups)} groups</p>
      ) : null}
    </section>
  );
};

const ScopedRankings = ({
  result,
  onContributor,
  onModule,
}: {
  result: ProjectActivityQueryResult;
  onContributor: (key: string) => void;
  onModule: (path: string) => void;
}) => (
  <div className="grid min-w-0 gap-6 xl:grid-cols-2">
    <section>
      <div className="mb-2 flex items-baseline justify-between"><h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">Contributors in scope</h4><span className="text-[10px] text-[var(--ec-faint)]">Top {Math.min(8, result.contributors.length)}</span></div>
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {result.contributors.slice(0, 8).map((contributor) => (
          <button key={contributor.key} type="button" className="grid w-full grid-cols-[minmax(0,1fr)_4rem_5rem] items-center gap-3 py-2 text-left hover:bg-[var(--ec-hover)]" onClick={() => onContributor(contributor.key)}>
            <span className="truncate text-xs text-[var(--ec-text)]" title={contributor.email}>{contributor.name}</span>
            <span className="text-right text-xs tabular-nums text-[var(--ec-text)]">{formatNumber(contributor.commits)}</span>
            <span className="text-right text-[10px] tabular-nums text-[var(--ec-faint)]">{formatCompactNumber(contributor.linesChanged)} lines</span>
          </button>
        ))}
      </div>
    </section>
    <section>
      <div className="mb-2 flex items-baseline justify-between"><h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">Modules in scope</h4><span className="text-[10px] text-[var(--ec-faint)]">Top {Math.min(8, result.modules.length)}</span></div>
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {result.modules.slice(0, 8).map((module) => (
          <button key={module.path} type="button" className="grid w-full grid-cols-[minmax(0,1fr)_4rem_5rem] items-center gap-3 py-2 text-left hover:bg-[var(--ec-hover)]" onClick={() => onModule(module.path)}>
            <span className="truncate font-mono text-[11px] text-[var(--ec-text)]" title={module.path}>{module.path}</span>
            <span className="text-right text-xs tabular-nums text-[var(--ec-text)]">{formatNumber(module.commits)}</span>
            <span className="text-right text-[10px] tabular-nums text-[var(--ec-faint)]">{formatCompactNumber(module.linesChanged)} lines</span>
          </button>
        ))}
      </div>
    </section>
  </div>
);

const ScopedCommits = ({ result }: { result: ProjectActivityQueryResult }) => (
  <section>
    <div className="mb-2 flex items-baseline justify-between"><h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">Commits in scope</h4><span className="text-[10px] text-[var(--ec-faint)]">Up to {result.commitResultLimit}</span></div>
    <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
      {result.commits.slice(0, 20).map((commit) => (
        <div key={commit.sha} className="grid grid-cols-[4.5rem_minmax(0,1fr)_8rem_5rem] items-center gap-2 py-2">
          <span className="font-mono text-[10px] text-[var(--ec-accent)]">{commit.sha.slice(0, 7)}</span>
          <span className="truncate text-xs text-[var(--ec-text)]" title={commit.title}>{commit.title || "Untitled commit"}</span>
          <span className="truncate text-right text-[10px] text-[var(--ec-faint)]">{commit.author}</span>
          <span className="text-right text-[10px] tabular-nums text-[var(--ec-muted)]">{formatCompactNumber(commit.linesChanged)} lines</span>
        </div>
      ))}
    </div>
  </section>
);

export const ProjectActivityQueryResults = ({
  result,
  scopeActive,
  onDrilldown,
  onWeekday,
  onContributor,
  onModule,
}: {
  result: ProjectActivityQueryResult;
  scopeActive: boolean;
  onDrilldown: (filters: ProjectActivityQueryResult["groups"][number]["drilldown"]) => void;
  onWeekday: (weekday: number) => void;
  onContributor: (key: string) => void;
  onModule: (path: string) => void;
}) => (
  <div className="mt-4 space-y-5">
    {scopeActive ? (
      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)] sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-6">
        <ScopeMetric label="Commits" value={formatNumber(result.summary.commits)} detail={`${result.summary.activeDays} active days`} />
        <ScopeMetric label="Contributors" value={formatNumber(result.summary.contributors)} detail="unique authors" />
        <ScopeMetric label="Lines changed" value={formatCompactNumber(result.summary.linesChanged)} detail={`+${formatCompactNumber(result.summary.linesAdded)} / −${formatCompactNumber(result.summary.linesDeleted)}`} />
        <ScopeMetric label="Net growth" value={`${result.summary.netLines > 0 ? "+" : ""}${formatCompactNumber(result.summary.netLines)}`} detail="added minus deleted" />
        <ScopeMetric label="Median commit" value={formatNumber(result.summary.medianCommitSize)} detail={`${result.summary.megaCommits} mega commits`} />
        <ScopeMetric label="Range" value={formatShortDate(result.summary.firstCommitAt)} detail={`through ${formatShortDate(result.summary.latestCommitAt)}`} />
      </div>
    ) : null}

    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <Breakdown result={result} onDrilldown={onDrilldown} />
      <section>
        <div className="mb-2 flex items-baseline justify-between"><h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">Weekdays</h4><span className="text-[10px] text-[var(--ec-faint)]">click to filter</span></div>
        <div className="grid grid-cols-7 gap-1 xl:grid-cols-1">
          {result.weekdays.map((weekday) => (
            <button key={weekday.weekday} type="button" className="flex min-w-0 flex-col items-center justify-center rounded-md border border-[var(--ec-border)] px-1 py-2 text-[10px] transition hover:border-[var(--ec-accent-ring)] hover:bg-[var(--ec-hover)] xl:flex-row xl:justify-between xl:px-2.5" onClick={() => onWeekday(weekday.weekday)}>
              <span className="text-[var(--ec-muted)]">{weekday.label}</span>
              <span className="font-medium tabular-nums text-[var(--ec-text)]">{weekday.commits}</span>
            </button>
          ))}
        </div>
      </section>
    </div>

    {scopeActive && result.summary.commits > 0 ? (
      <>
        <ScopedRankings result={result} onContributor={onContributor} onModule={onModule} />
        <ScopedCommits result={result} />
      </>
    ) : null}
    {scopeActive && result.summary.commits === 0 ? (
      <div className="rounded-md border border-dashed border-[var(--ec-border)] bg-[var(--ec-panel-soft)] py-10 text-center text-xs text-[var(--ec-muted)]">
        No commits match this filter combination. Remove a filter or widen the date range.
      </div>
    ) : null}
  </div>
);

export const ProjectActivityExplorer = ({ projectId, activity, onScopeActiveChange }: ProjectActivityExplorerProps) => {
  const client = useBuildWardenClient();
  const [contributorKey, setContributorKey] = useState("");
  const [modulePath, setModulePath] = useState("");
  const [period, setPeriod] = useState<PeriodPreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [weekday, setWeekday] = useState("");
  const [groupBy, setGroupBy] = useState<ProjectActivityQueryInput["groupBy"]>("month");
  const [result, setResult] = useState<ProjectActivityQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const dates = useMemo(
    () => periodFilters(period, customFrom, customTo),
    [customFrom, customTo, period],
  );
  const scopeActive = Boolean(contributorKey || modulePath || weekday || dates.dateFrom || dates.dateTo);
  const queryInput = useMemo<ProjectActivityQueryInput>(() => ({
    projectId,
    groupBy,
    ...(contributorKey ? { contributorKey } : {}),
    ...(modulePath ? { modulePath } : {}),
    ...dates,
    ...(weekday ? { weekday: Number.parseInt(weekday, 10) } : {}),
  }), [contributorKey, dates, groupBy, modulePath, projectId, weekday]);

  useEffect(() => onScopeActiveChange(scopeActive), [onScopeActiveChange, scopeActive]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    void client.queryProjectActivity(queryInput)
      .then((nextResult) => {
        if (!cancelled) setResult(nextResult);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        reportRendererError("renderer.project-activity.query", error, { projectId, groupBy });
        setErrorMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, groupBy, projectId, queryInput]);

  const resetFilters = () => {
    setContributorKey("");
    setModulePath("");
    setPeriod("all");
    setCustomFrom("");
    setCustomTo("");
    setWeekday("");
  };

  const applyDrilldown = (filters: ProjectActivityQueryResult["groups"][number]["drilldown"]) => {
    if (filters.contributorKey) setContributorKey(filters.contributorKey);
    if (filters.modulePath) setModulePath(filters.modulePath);
    if (filters.dateFrom || filters.dateTo) {
      setPeriod("custom");
      setCustomFrom(filters.dateFrom ?? "");
      setCustomTo(filters.dateTo ?? "");
    }
  };

  const contributorOptions = [
    { value: "", label: "All contributors" },
    ...activity.contributors.map((contributor) => ({
      value: (contributor.email || contributor.name).trim().toLowerCase(),
      label: contributor.name,
      description: `${formatNumber(contributor.commits)} commits${contributor.email ? ` · ${contributor.email}` : ""}`,
    })),
  ];
  const moduleOptions = [
    { value: "", label: "All modules" },
    ...activity.modules.map((module) => ({ value: module.path, label: module.path, description: `${formatNumber(module.commits)} commits` })),
  ];
  const contributorLabel = contributorOptions.find((option) => option.value === contributorKey)?.label ?? contributorKey;

  return (
    <section className="mt-4">
      <div className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-strong)] p-2.5 shadow-[var(--ec-panel-shadow)]">
        <div className="flex items-center gap-2 px-0.5 pb-2">
          <Filter className="size-3.5 text-[var(--ec-accent)]" />
          <p className="text-xs font-medium text-[var(--ec-text)]">Activity scope</p>
          <p className="text-[10px] text-[var(--ec-faint)]">Combine filters, then group the matching commits.</p>
          {loading ? <Loader2 className="ml-auto size-3.5 animate-spin text-[var(--ec-faint)]" /> : null}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[1.2fr_1.2fr_0.8fr_0.75fr_0.8fr_auto]">
          <Select value={contributorKey} options={contributorOptions} onValueChange={setContributorKey} ariaLabel="Filter by contributor" triggerClassName="h-8 text-xs" maxMenuHeightPx={320} searchable searchPlaceholder="Search contributors…" />
          <Select value={modulePath} options={moduleOptions} onValueChange={setModulePath} ariaLabel="Filter by module" triggerClassName="h-8 font-mono text-xs" maxMenuHeightPx={320} searchable searchPlaceholder="Search modules…" />
          <Select value={period} options={[
            { value: "all", label: "All time" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
            { value: "365", label: "Last year" },
            { value: "custom", label: "Custom dates" },
          ]} onValueChange={(value) => setPeriod(value as PeriodPreset)} ariaLabel="Filter by period" triggerClassName="h-8 text-xs" />
          <Select value={weekday} options={[
            { value: "", label: "Any weekday" },
            ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => ({ value: String(index), label })),
          ]} onValueChange={setWeekday} ariaLabel="Filter by weekday" triggerClassName="h-8 text-xs" />
          <Select value={groupBy} options={[
            { value: "day", label: "Group: day" },
            { value: "week", label: "Group: week" },
            { value: "month", label: "Group: month" },
            { value: "contributor", label: "Group: contributor" },
            { value: "module", label: "Group: module" },
          ]} onValueChange={(value) => setGroupBy(value as ProjectActivityQueryInput["groupBy"])} ariaLabel="Group activity" triggerClassName="h-8 text-xs" />
          <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={resetFilters} disabled={!scopeActive} title="Clear filters">
            <RotateCcw className="size-3.5" /> Clear
          </Button>
        </div>

        {period === "custom" ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--ec-border)] pt-2">
            <CalendarRange className="size-3.5 text-[var(--ec-faint)]" />
            <label className="flex items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
              From
              <input type="date" value={customFrom} max={customTo || undefined} onChange={(event) => setCustomFrom(event.target.value)} className="h-7 rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2 text-xs text-[var(--ec-text)] outline-none focus:border-[var(--ec-accent-ring)]" />
            </label>
            <label className="flex items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
              To
              <input type="date" value={customTo} min={customFrom || undefined} onChange={(event) => setCustomTo(event.target.value)} className="h-7 rounded-md border border-[var(--ec-border)] bg-[var(--ec-input)] px-2 text-xs text-[var(--ec-text)] outline-none focus:border-[var(--ec-accent-ring)]" />
            </label>
          </div>
        ) : null}

        {scopeActive ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-[var(--ec-border)] pt-2">
            <span className="mr-1 text-[9px] uppercase tracking-[0.1em] text-[var(--ec-faint)]">Scoped to</span>
            {contributorKey ? <FilterChip label={contributorLabel} onRemove={() => setContributorKey("")} /> : null}
            {modulePath ? <FilterChip label={modulePath} onRemove={() => setModulePath("")} /> : null}
            {period !== "all" ? <FilterChip label={period === "custom" ? `${customFrom || "…"} → ${customTo || "…"}` : period === "365" ? "Last year" : `Last ${period} days`} onRemove={() => { setPeriod("all"); setCustomFrom(""); setCustomTo(""); }} /> : null}
            {weekday ? <FilterChip label={["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number.parseInt(weekday, 10)] ?? weekday} onRemove={() => setWeekday("")} /> : null}
          </div>
        ) : null}
      </div>

      {errorMessage ? <div className="mt-3 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-xs text-[var(--ec-danger)]">Could not query Activity: {errorMessage}</div> : null}
      {result ? (
        <div className={cn("transition-opacity", loading && "opacity-60")}>
          <ProjectActivityQueryResults
            result={result}
            scopeActive={scopeActive}
            onDrilldown={applyDrilldown}
            onWeekday={(nextWeekday) => setWeekday(String(nextWeekday))}
            onContributor={setContributorKey}
            onModule={setModulePath}
          />
        </div>
      ) : loading ? <div className="flex h-28 items-center justify-center text-xs text-[var(--ec-muted)]"><Loader2 className="mr-2 size-4 animate-spin" /> Loading Activity breakdown…</div> : null}
    </section>
  );
};
