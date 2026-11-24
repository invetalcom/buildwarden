import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  APP_SETTING_KEYS,
  DEFAULT_HOME_LAYOUT,
  parseAttentionInboxSettings,
  type AppSnapshot,
  type HomeChartMetric,
  type HomeLayout,
  type HomeSection,
  type HomeStat,
  type UsageCostReport,
} from "@buildwarden/shared";
import { CircleDollarSign, Gauge, LayoutGrid } from "lucide-react";
import { LiveDot, Spinner, StatusDot } from "../ui/motion";
import { Button } from "../ui/button";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { HomeActivityChart } from "./HomeActivityChart";
import { pickRandomLandingJoke } from "./landing-page-jokes";
import {
  buildHomeChartDays,
  buildHomeSummary,
  buildLandingTotals,
  buildProviderUsage,
  buildTodayActivity,
  countRunOutcomes,
  formatCompactNumber,
  formatFullNumber,
  homeGreeting,
  RUN_OUTCOME_SERIES,
  successRate,
  type RunOutcomeCounts,
} from "./landing-page-model";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { RUN_DISPLAY_STATUS_LABELS, resolveRunDisplayStatus, runStatusDotClassName, runThemeState } from "./run-display-status";
import { runHierarchyLabel } from "./run-hierarchy";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import { buildUsageAnalytics, buildUsageBucketTotals, formatDelta, formatTokenCount, formatUsd, usageDelta } from "./usage-analytics";

export type HomeTab = "overview" | "usage" | "limits";

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
  limitsPanel?: ReactNode;
  /** What the overview shows. The default layout when omitted. */
  layout?: HomeLayout;
  /**
   * Saves a change made on the page itself (chart metrics and range). Without it the change lasts
   * until the page closes. A returned promise that rejects means the save failed.
   */
  onLayoutChange?: (layout: HomeLayout) => void | Promise<void>;
}

const COST_SUMMARY_RANGE_DAYS = 30;
const MAX_PROVIDER_ROWS = 5;

/** Thin stacked share bar of run outcomes, using the theme's status tokens. */
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
      data-ui="home-boot"
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
  { value: "limits", label: "Limits", icon: Gauge },
];

const HomeTabs = ({ tab, onChange, available }: { tab: HomeTab; onChange: (tab: HomeTab) => void; available: HomeTab[] }) => (
  <div className="flex items-center gap-0.5 rounded-md bg-[var(--ec-control)] p-0.5 text-xs" role="tablist" aria-label="Home views">
    {HOME_TABS.filter((option) => available.includes(option.value)).map((option) => {
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
            "flex h-7 items-center gap-1.5 rounded-sm px-2.5 transition",
            selected
              ? "bg-[var(--ec-bg-elevated)] font-medium text-[color:var(--ec-text)] shadow-[0_0_0_1px_var(--ec-border)]"
              : "text-[color:var(--ec-muted)] hover:text-[color:var(--ec-text)]",
          )}
          onClick={() => onChange(option.value)}
        >
          <Icon className="size-3.5" aria-hidden />
          {option.label}
        </button>
      );
    })}
  </div>
);

type StatView = {
  key: HomeStat;
  value: ReactNode;
  label: string;
  /** Detail for the tooltip, such as the full numbers behind a rounded one. */
  title?: string;
  /** Makes the whole figure a link, e.g. into the Usage tab. */
  onClick?: () => void;
};

const StatCell = ({ stat }: { stat: StatView }) => {
  const body = (
    <>
      <span data-ui="home-stat-value" className="flex items-center justify-center gap-2 truncate text-2xl font-semibold leading-8 tabular-nums text-[var(--ec-text)]">{stat.value}</span>
      <span className="block truncate text-xs text-[var(--ec-muted)]">{stat.label}</span>
    </>
  );
  return stat.onClick ? (
    <button type="button" data-ui="home-stat" data-stat={stat.key} title={stat.title} className="min-w-0 rounded-md px-2 py-1 text-center transition-colors hover:bg-[var(--ec-hover)]" onClick={stat.onClick}>
      {body}
    </button>
  ) : (
    <div data-ui="home-stat" data-stat={stat.key} title={stat.title} className="min-w-0 px-2 py-1 text-center">{body}</div>
  );
};

type CostSummary =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; report: UsageCostReport };

/** How long after the first sign of new usage the report is loaded again. Changes within that time share one request. */
const COST_REFRESH_DELAY_MS = 10_000;

/**
 * Loads the 30-day cost report for the overview while cost tracking is on, and again after
 * `usageSignal` changed, so the token and cost lanes follow the runs lane while the page stays open.
 */
const useCostSummary = (enabled: boolean, usageSignal: string): CostSummary | null => {
  const buildwarden = useBuildWardenClient();
  const [summary, setSummary] = useState<CostSummary>({ status: "loading" });
  const reload = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let generation = 0;
    const load = (first: boolean) => {
      const current = ++generation;
      if (first) setSummary({ status: "loading" });
      buildwarden.getUsageCostReport({ rangeDays: COST_SUMMARY_RANGE_DAYS }).then(
        (report) => { if (!cancelled && current === generation) setSummary({ status: "ready", report }); },
        // A refresh that fails keeps the report that is on screen. Only a first load can end without one.
        () => { if (!cancelled && current === generation) setSummary((previous) => (previous.status === "ready" ? previous : { status: "error" })); },
      );
    };
    load(true);
    reload.current = () => load(false);
    return () => { cancelled = true; reload.current = null; };
  }, [buildwarden, enabled]);

  const seenSignal = useRef(usageSignal);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (seenSignal.current === usageSignal) return;
    seenSignal.current = usageSignal;
    if (!enabled) return;
    // The report stays on screen until the new one arrives, so the chart never jumps back to loading.
    timer.current ??= setTimeout(() => { timer.current = undefined; reload.current?.(); }, COST_REFRESH_DELAY_MS);
  }, [enabled, usageSignal]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return enabled ? summary : null;
};

const WAITING_EVENTS = new Set(["status", "approval-requested", "approval-resolved", "user-input-requested", "user-input-resolved"]);

/**
 * Number of approvals and questions that wait for the user, from the attention inbox. Null while
 * it is unknown: the inbox is off or leaves these kinds out, the count has not loaded, or it failed.
 */
const useWaitingRequests = (enabled: boolean): number | null => {
  const buildwarden = useBuildWardenClient();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only the latest request counts: a remote client can answer an older one after a newer one.
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      // Wrapped so a client without an inbox ends up in the same "unknown" state as a failed request.
      Promise.resolve().then(() => buildwarden.getAttentionInbox()).then(
        (items) => { if (alive && current === generation) setCount(items.filter((item) => item.kind === "approval" || item.kind === "input").length); },
        () => { if (alive && current === generation) setCount(null); },
      );
    };
    const schedule = () => { timer ??= setTimeout(() => { timer = undefined; refresh(); }, 1_000); };
    refresh();
    let dispose: (() => void) | undefined;
    try {
      dispose = buildwarden.onRunEvent((event) => { if (WAITING_EVENTS.has(event.type)) schedule(); });
    } catch {
      // No live events on this client: the count is the one from when the page opened.
    }
    return () => { alive = false; dispose?.(); clearTimeout(timer); };
  }, [buildwarden, enabled]);
  return enabled ? count : null;
};

const SectionHeading = ({ children }: { children: ReactNode }) => (
  <h2 className="mb-1 px-1 text-xs font-medium text-[var(--ec-muted)]">{children}</h2>
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
  limitsPanel,
  layout = DEFAULT_HOME_LAYOUT,
  onLayoutChange,
}: LandingPageProps) => {
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.mutations;
  const usageAvailable = Boolean(usagePanel) && Boolean(onTabChange);
  const available: HomeTab[] = ["overview", ...(usageAvailable ? ["usage" as const] : []), ...(limitsPanel && onTabChange ? ["limits" as const] : [])];
  const tabsAvailable = available.length > 1;
  const activeTab: HomeTab = available.includes(tab) ? tab : "overview";
  // Changes when a run starts or tokens are used, which is when the loaded cost report goes out of date.
  const usageSignal = useMemo(() => {
    let runs = 0;
    let tokens = (snapshot.tokenUsage?.today.inputTokens ?? 0) + (snapshot.tokenUsage?.today.outputTokens ?? 0);
    for (const entry of snapshot.projects) {
      runs += entry.runs.length;
      for (const run of entry.runs) tokens += run.inputTokens + run.outputTokens;
    }
    return `${String(runs)}:${String(tokens)}`;
  }, [snapshot.projects, snapshot.tokenUsage?.today]);
  const costSummary = useCostSummary(usageAvailable, usageSignal);

  // A change on the page shows at once and stays while its own save runs, so the answer to an earlier
  // save cannot bring the earlier choice back in between. After that the saved layout replaces it when it arrives.
  const [chartDraft, setChartDraft] = useState<{ base: HomeLayout["chart"]; chart: HomeLayout["chart"]; saving: boolean } | null>(null);
  const chart = chartDraft && (chartDraft.saving || chartDraft.base === layout.chart) ? chartDraft.chart : layout.chart;
  const changeChart = (next: HomeLayout["chart"]) => {
    const saved = onLayoutChange?.({ ...layout, chart: next });
    const saving = saved instanceof Promise;
    setChartDraft({ base: layout.chart, chart: next, saving });
    if (!saving) return;
    // A newer choice has its own save, so this one's outcome no longer decides what shows. The app
    // reports a failed save; the chart then goes back to what is saved.
    const settle = (failed: boolean) => setChartDraft((draft) => (draft?.chart !== next ? draft : failed ? null : { ...draft, saving: false }));
    saved.then(() => settle(false), () => settle(true));
  };

  const sections = layout.sections;
  const shows = (section: HomeSection) => sections.includes(section);
  const inboxSettings = useMemo(
    () => parseAttentionInboxSettings(snapshot.settings[APP_SETTING_KEYS.attentionInbox]),
    [snapshot.settings],
  );
  const waiting = useWaitingRequests(
    activeTab === "overview" && (shows("summary") || (shows("stats") && layout.stats.includes("waiting")))
      && inboxSettings.enabled && inboxSettings.kinds.approval && inboxSettings.kinds.input,
  );

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
      .slice(0, layout.recentRuns),
    [allRuns, layout.recentRuns],
  );

  const costReport = costSummary?.status === "ready" ? costSummary.report : null;
  const costTotals = useMemo(() => (costReport ? buildUsageAnalytics(costReport) : null), [costReport]);
  // Hosts report days for this range; anything else cannot be laid over the chart's days.
  const dailyUsage = useMemo(() => (costReport?.bucketSize === "day" ? buildUsageBucketTotals(costReport) : null), [costReport]);
  const chartDays = useMemo(() => buildHomeChartDays(allRuns, chart.range, dailyUsage), [allRuns, chart.range, dailyUsage]);
  const chartMetrics: HomeChartMetric[] = costSummary ? ["runs", "tokens", "cost"] : ["runs", "tokens"];

  // Provider usage follows the chart's range, so both describe the same window.
  const providers = useMemo(() => {
    const windowStart = chartDays[0]?.date.getTime() ?? 0;
    return buildProviderUsage(allRuns.filter((run) => new Date(run.createdAt).getTime() >= windowStart), snapshot.providerAccounts);
  }, [allRuns, chartDays, snapshot.providerAccounts]);
  const maxProviderRuns = Math.max(1, ...providers.map((provider) => provider.runs));

  const rate = successRate(totals.outcomes);
  const finishedRuns = totals.outcomes.completed + totals.outcomes.failed;
  const activeRuns = totals.outcomes.active;
  const openUsage = onTabChange ? () => onTabChange("usage") : undefined;

  const tokensStat = (key: HomeStat): StatView => ({
    key,
    value: formatCompactNumber(totals.totalTokens),
    label: "tokens · all time",
    title: `${formatFullNumber(totals.totalTokens)} tokens: ${formatCompactNumber(totals.inputTokens)} in, ${formatCompactNumber(totals.outputTokens)} out`,
  });

  const costStat = (): StatView => {
    if (!costSummary) return tokensStat("cost");
    const delta = costTotals?.previous ? usageDelta(costTotals.current.costUsd, costTotals.previous.costUsd) : null;
    let title = "Prices are unavailable right now";
    if (costTotals) {
      title = delta === null
        ? `${formatTokenCount(costTotals.current.totalTokens)} tokens at list prices`
        : `${formatDelta(delta)} vs the ${String(COST_SUMMARY_RANGE_DAYS)} days before`;
    } else if (costSummary.status === "loading") {
      title = "Pricing usage…";
    }
    return {
      key: "cost",
      value: costTotals
        ? formatUsd(costTotals.current.costUsd)
        : costSummary.status === "loading" ? <Spinner className="my-1.5 size-5 text-[var(--ec-faint)]" aria-label="Loading" /> : "–",
      label: `est. cost · ${String(COST_SUMMARY_RANGE_DAYS)} days`,
      title: openUsage ? `${title}. Open usage & cost` : title,
      onClick: openUsage,
    };
  };

  const statViews: Record<HomeStat, () => StatView> = {
    running: () => ({
      key: "running",
      value: activeRuns > 0 ? (
        <>
          <LiveDot active className="running-pulse size-2 shrink-0 rounded-full bg-[var(--ec-accent)]" />
          {formatFullNumber(activeRuns)}
        </>
      ) : "Idle",
      label: "running now",
    }),
    today: () => ({
      key: "today",
      value: `${formatFullNumber(todayActivity.runsStarted)} ${todayActivity.runsStarted === 1 ? "run" : "runs"}`,
      label: `today · ${formatCompactNumber(todayActivity.tokensUsed)} tokens`,
      title: `${String(todayActivity.completedRuns)} done · ${String(todayActivity.failedRuns)} failed · ${formatFullNumber(todayActivity.tokensUsed)} tokens today`,
    }),
    success: () => ({
      key: "success",
      value: rate === null ? "–" : `${String(Math.round(rate * 100))}%`,
      label: rate === null ? "no finished runs yet" : `success · ${formatFullNumber(totals.outcomes.completed)} of ${formatFullNumber(finishedRuns)}`,
    }),
    cost: costStat,
    tokens: () => tokensStat("tokens"),
    waiting: () => ({
      key: "waiting",
      value: waiting === null ? "–" : formatFullNumber(waiting),
      label: "waiting for you",
      title: waiting === null ? "Approvals and questions are counted by the attention inbox, which is off or still loading" : "Approvals and questions in the attention inbox",
    }),
  };
  // While cost tracking is off, "cost" shows all-time tokens; a layout that lists both would repeat them.
  const stats = layout.stats
    .filter((key, _index, list) => !(key === "tokens" && !costSummary && list.includes("cost")))
    .map((key) => statViews[key]());

  const sectionViews: Record<HomeSection, () => ReactNode> = {
    greeting: () => (
      <h1 data-ui="home-greeting" className="text-center text-3xl font-semibold leading-tight tracking-tight text-[var(--ec-text)]">
        {layout.greetingText || homeGreeting()}
      </h1>
    ),
    summary: () => (
      <p className="text-center text-sm text-[var(--ec-muted)]">
        {buildHomeSummary({ activeRuns, today: todayActivity, waiting })}
      </p>
    ),
    stats: () => (
      <div className="grid w-full gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(6.5rem, 1fr))" }} aria-label="At a glance">
        {stats.map((stat) => <StatCell key={stat.key} stat={stat} />)}
      </div>
    ),
    runs: () => (
      recentRuns.length > 0 ? (
        <>
          <ul aria-label="Recent runs">
            {recentRuns.map((run) => {
              const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
              const waitingForInput = run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1;
              const label = runHierarchyLabel(run);
              return (
                <li key={run.id} className="border-t border-[var(--ec-border)] first:border-t-0">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-sm px-1 py-2 text-left transition hover:bg-[var(--ec-hover)]"
                    onClick={() => onSelectRun(run.projectId, run.id)}
                  >
                    <ProviderBrandIcon
                      harnessType={run.harnessType}
                      providerType={providerTypeByAccountId.get(run.providerAccountId)}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--ec-text)]" title={label}>{label}</span>
                    <span className="min-w-0 max-w-[55%] shrink-0 truncate text-xs text-[var(--ec-muted)]" title={new Date(run.createdAt).toLocaleString()}>
                      {projectNames.get(run.projectId) ?? "Unknown project"} · {formatRunRelativeTime(run.createdAt)} · {formatRunDuration(run)}
                    </span>
                    <span className="flex shrink-0 items-center" title={RUN_DISPLAY_STATUS_LABELS[displayStatus]}>
                      <StatusDot state={runThemeState(displayStatus, waitingForInput)} className={cn("size-1.5 rounded-full", runStatusDotClassName(displayStatus))} />
                      <span className="sr-only">{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {onOpenAllRuns ? (
            <div className="mt-1 flex justify-center">
              <Button size="xs" variant="ghost" onClick={onOpenAllRuns}>View all runs</Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-center text-sm text-[var(--ec-muted)]">
          {readOnly ? "No runs are available on the BuildWarden host." : "No runs yet. Start one from a project page."}
        </p>
      )
    ),
    projects: () => (
      <>
        <SectionHeading>Projects</SectionHeading>
        {projects.length > 0 ? (
          <ul className="app-scrollbar max-h-[13.5rem] overflow-y-auto">
            {projects.map(({ entry, outcomes }) => {
              const activeCount = entry.activeRuns.length;
              return (
                <li key={entry.project.id} className="border-t border-[var(--ec-border)] first:border-t-0">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 rounded-sm px-1 py-2 text-left transition hover:bg-[var(--ec-hover)]"
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
          <p className="px-1 text-xs text-[var(--ec-muted)]">
            {readOnly ? "No projects are configured on the BuildWarden host." : "Add your first project from the sidebar."}
          </p>
        )}
      </>
    ),
    providers: () => (
      <>
        <SectionHeading>By provider · {chart.range} days</SectionHeading>
        {providers.length > 0 ? (
          <ul className="flex flex-col gap-1.5 px-1">
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
                  {provider.runs} {provider.runs === 1 ? "run" : "runs"} · {formatCompactNumber(provider.tokens)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 text-xs text-[var(--ec-muted)]">No runs in the last {chart.range} days.</p>
        )}
      </>
    ),
  };

  const overview = (
    <>
      {sections.length > 0 ? (
        <div
          className={cn("mx-auto flex flex-col gap-6", layout.position === "center" ? "my-auto" : "mt-4")}
          // Never narrower than four figures need side by side, unless the page itself is.
          style={{ width: `min(100%, max(30rem, ${String(layout.width)}%))` }}
        >
          {sections.map((section, index) => (
            <section
              key={section}
              data-ui="home-section"
              data-section={section}
              // The sentence belongs to the greeting above it, so the two sit closer than other sections.
              className={cn("min-w-0", section === "summary" && sections[index - 1] === "greeting" && "-mt-4")}
            >
              {sectionViews[section]()}
            </section>
          ))}
        </div>
      ) : null}
      {chart.show ? (
        <HomeActivityChart
          className="mt-auto"
          days={chartDays}
          metrics={chart.metrics}
          available={chartMetrics}
          range={chart.range}
          costPending={costSummary?.status === "loading"}
          onMetricsChange={(metrics) => changeChart({ ...chart, metrics })}
          onRangeChange={(range) => changeChart({ ...chart, range })}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-full w-full flex-col gap-3" data-ui="home" data-landing-page>
      {layout.bootMessage || tabsAvailable ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {layout.bootMessage ? <BootLine initialJoke={sessionJoke} /> : <span className="flex-1" />}
          {tabsAvailable && onTabChange ? <HomeTabs tab={activeTab} onChange={onTabChange} available={available} /> : null}
        </div>
      ) : null}

      {activeTab !== "overview" ? (
        <div role="tabpanel" id={`home-panel-${activeTab}`} aria-labelledby={`home-tab-${activeTab}`}>
          <Suspense fallback={<div className="flex h-60 items-center justify-center"><Spinner className="size-5 text-[var(--ec-accent)]" /></div>}>
            {activeTab === "usage" ? usagePanel : limitsPanel}
          </Suspense>
        </div>
      ) : (
        <div
          role={tabsAvailable ? "tabpanel" : undefined}
          id="home-panel-overview"
          aria-labelledby={tabsAvailable ? "home-tab-overview" : undefined}
          className="flex min-h-0 flex-1 flex-col gap-6"
        >
          {overview}
        </div>
      )}
    </div>
  );
};
