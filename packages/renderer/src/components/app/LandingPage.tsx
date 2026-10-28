import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppSnapshot, UsageCostReport } from "@buildwarden/shared";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FolderGit2,
  LayoutGrid,
  Loader2,
  PlayCircle,
  WalletCards,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { LandingActivityPanel } from "./LandingActivityPanel";
import { pickRandomLandingJoke } from "./landing-page-jokes";
import {
  buildLandingTotals,
  buildTodayActivity,
  countRunOutcomes,
  formatCompactNumber,
  formatFullNumber,
  RUN_OUTCOME_SERIES,
  successRate,
  type RunOutcomeCounts,
} from "./landing-page-model";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { RUN_DISPLAY_STATUS_LABELS, resolveRunDisplayStatus, runDisplayStatusTone } from "./run-display-status";
import { runHierarchyLabel } from "./run-hierarchy";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import { buildUsageAnalytics, formatDelta, formatTokenCount, formatUsd, usageDelta } from "./usage-analytics";

export type HomeTab = "overview" | "usage";

interface LandingPageProps {
  snapshot: AppSnapshot;
  sessionJoke: string;
  onSelectProject: (projectId: string) => void;
  onSelectRun: (projectId: string, runId: string) => void;
  onOpenAllRuns?: () => void;
  /** Selected Home tab; the Usage tab only exists while cost tracking is on. */
  tab?: HomeTab;
  onTabChange?: (tab: HomeTab) => void;
  /** The Usage & cost dashboard, present only while cost tracking is on. */
  usagePanel?: ReactNode;
}

/** Recent runs stay a glance; the All Runs page holds the full history. */
const RECENT_RUN_LIMIT = 8;
const COST_SUMMARY_RANGE_DAYS = 30;

/** Thin stacked share bar of run outcomes, using the same status tokens as the activity chart. */
const RunOutcomeBar = ({ counts, className }: { counts: RunOutcomeCounts; className?: string }) => {
  const total = counts.completed + counts.failed + counts.active + counts.other;
  if (total === 0) return <span className={cn("block h-1 rounded-full bg-[var(--ec-muted-soft)]", className)} aria-hidden />;
  return (
    <span className={cn("flex h-1 gap-px overflow-hidden rounded-full", className)} aria-hidden>
      {RUN_OUTCOME_SERIES.filter((series) => counts[series.key] > 0).map((series) => (
        <span key={series.key} className="block h-full" style={{ flex: `${String(counts[series.key])} 1 0`, background: series.color }} />
      ))}
    </span>
  );
};

/** The session joke, styled as a boot-log line. Clicking it boots another one. */
const BootLine = ({ initialJoke }: { initialJoke: string }) => {
  const [joke, setJoke] = useState(initialJoke);
  const reboot = () => {
    let next = pickRandomLandingJoke();
    for (let attempt = 0; attempt < 4 && next === joke; attempt += 1) next = pickRandomLandingJoke();
    setJoke(next);
  };
  return (
    <button
      type="button"
      onClick={reboot}
      title="Boot message · click for another"
      aria-label={`Boot message: ${joke}. Show another.`}
      className="group flex min-w-0 flex-[1_1_20rem] rounded-md py-1.5 text-left"
    >
      {/* Font utilities go on a wrapper: the global unlayered `button { font: inherit }` beats them on buttons. */}
      <span className="flex min-w-0 items-center gap-2.5 font-mono text-sm">
        <span className="shrink-0 whitespace-pre text-[var(--ec-faint)]">
          [<span className="font-semibold text-[var(--ec-success)]">  OK  </span>]
        </span>
        <span className="min-w-0 truncate text-[var(--ec-text)] opacity-85 transition-opacity group-hover:opacity-100">{joke}</span>
        <span aria-hidden className="boot-caret -ml-1.5 inline-block h-4 w-2 shrink-0 bg-[var(--ec-accent)]" />
      </span>
    </button>
  );
};

const HOME_TABS: ReadonlyArray<{ value: HomeTab; label: string; icon: typeof LayoutGrid }> = [
  { value: "overview", label: "Overview", icon: LayoutGrid },
  { value: "usage", label: "Usage & cost", icon: CircleDollarSign },
];

const HomeTabs = ({ tab, onChange }: { tab: HomeTab; onChange: (tab: HomeTab) => void }) => (
  <div className="flex items-center gap-0.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1 text-sm" role="tablist" aria-label="Home views">
    {HOME_TABS.map((option) => {
      const Icon = option.icon;
      const selected = tab === option.value;
      return (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={`home-tab-${option.value}`}
          aria-selected={selected}
          aria-controls={`home-panel-${option.value}`}
          className={cn(
            "flex h-8 items-center gap-2 rounded-md px-3.5 transition",
            selected
              ? "bg-[var(--ec-accent-soft)] font-medium text-[color:var(--ec-text)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring)]"
              : "text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]",
          )}
          onClick={() => onChange(option.value)}
        >
          <Icon className="size-4" aria-hidden />
          {option.label}
        </button>
      );
    })}
  </div>
);

type PulseMetric = {
  key: string;
  label: string;
  icon: typeof Activity;
  value: ReactNode;
  valueTitle?: string;
  detail: ReactNode;
  /** Makes the whole cell a link, e.g. into the Usage tab. */
  onClick?: () => void;
  actionLabel?: string;
};

const PulseCell = ({ metric }: { metric: PulseMetric }) => {
  const Icon = metric.icon;
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{metric.label}</span>
        {metric.onClick ? <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-[var(--ec-faint)] transition-colors group-hover:text-[var(--ec-accent)]" aria-hidden /> : null}
      </span>
      <span className="mt-1 block truncate text-2xl font-semibold leading-8 tabular-nums text-[var(--ec-text)]" title={metric.valueTitle}>{metric.value}</span>
      <span className="block truncate text-xs text-[var(--ec-muted)]">{metric.detail}</span>
    </>
  );
  const cellClassName = "min-w-0 border-[var(--ec-border)] px-4 py-3 [&:nth-child(even)]:border-l [&:nth-child(n+3)]:border-t lg:[&:not(:first-child)]:border-l lg:[&:nth-child(n+3)]:border-t-0";
  return metric.onClick ? (
    <button
      type="button"
      className={cn("group text-left transition-colors hover:bg-[var(--ec-hover)]", cellClassName)}
      onClick={metric.onClick}
      title={metric.actionLabel}
    >
      {body}
    </button>
  ) : (
    <div className={cellClassName}>{body}</div>
  );
};

type CostSummary =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; report: UsageCostReport };

/** Loads the 30-day cost total for the overview while cost tracking is on. */
const useCostSummary = (enabled: boolean): CostSummary | null => {
  const buildwarden = useBuildWardenClient();
  const [summary, setSummary] = useState<CostSummary>({ status: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setSummary({ status: "loading" });
    buildwarden.getUsageCostReport({ rangeDays: COST_SUMMARY_RANGE_DAYS }).then(
      (report) => { if (!cancelled) setSummary({ status: "ready", report }); },
      () => { if (!cancelled) setSummary({ status: "error" }); },
    );
    return () => { cancelled = true; };
  }, [buildwarden, enabled]);
  return enabled ? summary : null;
};

const DeltaText = ({ delta, comparison }: { delta: number; comparison: string }) => (
  <span className="inline-flex items-center gap-1">
    <span className="inline-flex items-center font-medium text-[var(--ec-text)]">
      {delta > 0 ? <ArrowUp className="size-3" aria-hidden /> : delta < 0 ? <ArrowDown className="size-3" aria-hidden /> : null}
      {formatDelta(delta)}
    </span>
    {comparison}
  </span>
);

export const LandingPage = ({
  snapshot,
  sessionJoke,
  onSelectProject,
  onSelectRun,
  onOpenAllRuns,
  tab = "overview",
  onTabChange,
  usagePanel,
}: LandingPageProps) => {
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.mutations;
  const usageAvailable = Boolean(usagePanel) && Boolean(onTabChange);
  const activeTab: HomeTab = usageAvailable ? tab : "overview";
  const costSummary = useCostSummary(usageAvailable);

  const allRuns = useMemo(
    () => snapshot.projects.flatMap((entry) => entry.runs),
    [snapshot.projects],
  );
  const providerTypeByAccountId = useMemo(
    () => new Map(snapshot.providerAccounts.map((account) => [account.id, account.providerType])),
    [snapshot.providerAccounts],
  );
  const projectNames = useMemo(
    () => new Map(snapshot.projects.map((entry) => [entry.project.id, entry.project.name])),
    [snapshot.projects],
  );

  const totals = useMemo(() => buildLandingTotals(snapshot, allRuns), [allRuns, snapshot]);
  const todayActivity = useMemo(
    () => buildTodayActivity(allRuns, snapshot.tokenUsage?.today),
    [allRuns, snapshot.tokenUsage?.today],
  );

  const projects = useMemo(
    () => snapshot.projects
      .slice()
      .sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt))
      .map((entry) => ({ entry, outcomes: countRunOutcomes(entry.runs) })),
    [snapshot.projects],
  );

  const recentRuns = useMemo(
    () => allRuns
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, RECENT_RUN_LIMIT),
    [allRuns],
  );

  const costTotals = useMemo(
    () => (costSummary?.status === "ready" ? buildUsageAnalytics(costSummary.report) : null),
    [costSummary],
  );

  const rate = successRate(totals.outcomes);
  const finishedRuns = totals.outcomes.completed + totals.outcomes.failed;
  const activeRuns = totals.outcomes.active;
  const activeProjectCount = snapshot.projects.filter((entry) => entry.activeRuns.length > 0).length;
  const openUsage = onTabChange ? () => onTabChange("usage") : undefined;

  const spendMetric: PulseMetric = costSummary
    ? {
      key: "cost",
      label: `Est. cost · ${String(COST_SUMMARY_RANGE_DAYS)} days`,
      icon: CircleDollarSign,
      value: costTotals
        ? formatUsd(costTotals.current.costUsd)
        : costSummary.status === "loading" ? <Loader2 className="my-1.5 size-5 animate-spin text-[var(--ec-faint)]" aria-label="Loading" /> : "–",
      detail: costTotals
        ? (() => {
          const delta = costTotals.previous ? usageDelta(costTotals.current.costUsd, costTotals.previous.costUsd) : null;
          return delta === null
            ? `${formatTokenCount(costTotals.current.totalTokens)} tokens at list prices`
            : <DeltaText delta={delta} comparison={`vs prior ${String(COST_SUMMARY_RANGE_DAYS)} days`} />;
        })()
        : costSummary.status === "loading" ? "Pricing usage…" : "Prices unavailable right now",
      onClick: openUsage,
      actionLabel: "Open usage & cost",
    }
    : {
      key: "tokens",
      label: "Tokens · all time",
      icon: WalletCards,
      value: formatCompactNumber(totals.totalTokens),
      valueTitle: `${formatFullNumber(totals.totalTokens)} tokens`,
      detail: `${formatCompactNumber(totals.inputTokens)} in · ${formatCompactNumber(totals.outputTokens)} out`,
    };

  const metrics: PulseMetric[] = [
    {
      key: "active",
      label: "Running now",
      icon: Activity,
      value: activeRuns > 0 ? (
        <span className="inline-flex items-center gap-2">
          <span className="running-pulse size-2 rounded-full bg-[var(--ec-accent)]" aria-hidden />
          {formatFullNumber(activeRuns)}
        </span>
      ) : "Idle",
      detail: activeRuns > 0
        ? `across ${String(activeProjectCount)} ${activeProjectCount === 1 ? "project" : "projects"}`
        : "Nothing in progress",
    },
    {
      key: "today",
      label: "Today",
      icon: CalendarDays,
      value: `${formatFullNumber(todayActivity.runsStarted)} ${todayActivity.runsStarted === 1 ? "run" : "runs"}`,
      detail: (
        <>
          {todayActivity.completedRuns} done · {todayActivity.failedRuns} failed ·{" "}
          <span title={`${formatFullNumber(todayActivity.tokensUsed)} tokens today`}>{formatCompactNumber(todayActivity.tokensUsed)} tokens</span>
        </>
      ),
    },
    {
      key: "success",
      label: "Success rate",
      icon: CheckCircle2,
      value: rate === null ? "–" : `${String(Math.round(rate * 100))}%`,
      detail: rate === null ? "No finished runs yet" : `${formatFullNumber(totals.outcomes.completed)} of ${formatFullNumber(finishedRuns)} finished runs`,
    },
    spendMetric,
  ];

  const overview = (
    <div className="flex flex-col gap-3">
      <Card className="grid grid-cols-2 overflow-hidden p-0 lg:grid-cols-4" aria-label="At a glance">
        {metrics.map((metric) => <PulseCell key={metric.key} metric={metric} />)}
      </Card>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="shrink-0 flex-row items-center gap-2 px-4 pt-3 pb-2">
            <Clock3 className="size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
            <CardTitle>Recent runs</CardTitle>
            {onOpenAllRuns ? (
              <CardAction>
                <Button size="xs" variant="ghost" onClick={onOpenAllRuns}>View all</Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
            {recentRuns.length > 0 ? (
              <ul>
                {recentRuns.map((run) => {
                  const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
                  const label = runHierarchyLabel(run);
                  return (
                    <li key={run.id} className="border-t border-[var(--ec-border)]">
                      <button
                        type="button"
                        className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-[var(--ec-hover)]"
                        onClick={() => onSelectRun(run.projectId, run.id)}
                      >
                        <ProviderBrandIcon
                          harnessType={run.harnessType}
                          providerType={providerTypeByAccountId.get(run.providerAccountId)}
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--ec-text)]" title={label}>{label}</span>
                          <span className="block truncate text-xs text-[var(--ec-muted)]" title={new Date(run.createdAt).toLocaleString()}>
                            {projectNames.get(run.projectId) ?? "Unknown project"} · {formatRunRelativeTime(run.createdAt)} · {formatRunDuration(run)}
                          </span>
                        </span>
                        <Badge dot tone={runDisplayStatusTone(displayStatus)}>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Empty className="flex-1">
                <EmptyHeader>
                  <PlayCircle className="size-8 text-[var(--ec-muted)]" />
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>{readOnly ? "No runs are available on the BuildWarden host." : "Start one from a project page to populate activity here."}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col gap-3">
          <LandingActivityPanel runs={allRuns} providerAccounts={snapshot.providerAccounts} className="lg:flex-1" />

          <Card className="flex min-h-0 flex-col">
            <CardHeader className="shrink-0 flex-row items-center gap-2 px-4 pt-3 pb-2">
              <FolderGit2 className="size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
              <CardTitle>Projects</CardTitle>
            </CardHeader>
            <CardContent className="overflow-hidden rounded-b-lg p-0">
              {projects.length > 0 ? (
                <ul className="app-scrollbar max-h-[13.5rem] overflow-y-auto">
                  {projects.map(({ entry, outcomes }) => {
                    const activeCount = entry.activeRuns.length;
                    return (
                      <li key={entry.project.id} className="border-t border-[var(--ec-border)]">
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 px-4 py-2 text-left transition hover:bg-[var(--ec-hover)]"
                          title={entry.project.repoPath}
                          onClick={() => onSelectProject(entry.project.id)}
                        >
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ec-text)]">{entry.project.name}</span>
                          <RunOutcomeBar counts={outcomes} className="w-16 shrink-0" />
                          <span className={cn("w-16 shrink-0 text-right text-xs tabular-nums", activeCount > 0 ? "text-[var(--ec-accent)]" : "text-[var(--ec-muted)]")}>
                            {activeCount > 0 ? `${String(activeCount)} active` : `${String(entry.runs.length)} ${entry.runs.length === 1 ? "run" : "runs"}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="border-t border-[var(--ec-border)] px-4 py-3 text-xs text-[var(--ec-muted)]">
                  {readOnly ? "No projects are configured on the BuildWarden host." : "Add your first project from the sidebar."}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex w-full flex-col gap-3" data-landing-page>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BootLine initialJoke={sessionJoke} />
        {usageAvailable && onTabChange ? <HomeTabs tab={activeTab} onChange={onTabChange} /> : null}
      </div>

      {activeTab === "usage" ? (
        <div role="tabpanel" id="home-panel-usage" aria-labelledby="home-tab-usage">
          <Suspense fallback={<div className="flex h-60 items-center justify-center"><Loader2 className="size-5 animate-spin text-[var(--ec-accent)]" /></div>}>
            {usagePanel}
          </Suspense>
        </div>
      ) : (
        <div role={usageAvailable ? "tabpanel" : undefined} id="home-panel-overview" aria-labelledby={usageAvailable ? "home-tab-overview" : undefined}>
          {overview}
        </div>
      )}
    </div>
  );
};
