import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { AppSnapshot } from "@buildwarden/shared";
import {
  Activity,
  CheckCircle2,
  Clock3,
  FolderGit2,
  MessagesSquare,
  PlayCircle,
  Terminal,
  WalletCards,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { LandingActivityPanel } from "./LandingActivityPanel";
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
import { buildRunHierarchyRows, findRunHierarchyScopeRoots, runHierarchyLabel } from "./run-hierarchy";
import { RunHierarchyIndent, RunHierarchyToggle } from "./RunHierarchy";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";

interface LandingPageProps {
  snapshot: AppSnapshot;
  sessionJoke: string;
  onSelectProject: (projectId: string) => void;
  onSelectRun: (projectId: string, runId: string) => void;
  onOpenAllRuns?: () => void;
}

/** Root rows shown in the recent-run list; the list scrolls inside its card, so this only bounds render cost. */
const RECENT_RUN_LIMIT = 60;

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-faint)]">{children}</p>
);

type LandingStat = {
  label: string;
  value: string;
  valueTitle?: string;
  detail: string;
  icon: typeof FolderGit2;
  highlight?: boolean;
};

const LandingStatTile = ({ stat }: { stat: LandingStat }) => {
  const Icon = stat.icon;
  return (
    <Card className="min-w-0 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{stat.label}</SectionLabel>
        <Icon className={cn("size-3.5 shrink-0", stat.highlight ? "text-[var(--ec-accent)]" : "text-[var(--ec-muted)]")} aria-hidden />
      </div>
      <p className="mt-1 truncate text-xl font-semibold tabular-nums leading-7 text-[var(--ec-text)]" title={stat.valueTitle}>
        {stat.value}
      </p>
      <p className="truncate text-xs text-[var(--ec-muted)]" title={stat.detail}>{stat.detail}</p>
    </Card>
  );
};

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

const TodayChip = ({ value, label, tone }: { value: string | number; label: string; tone?: string }) => (
  <span className="inline-flex items-baseline gap-1 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-0.5 text-xs">
    <span className="font-semibold tabular-nums" style={tone ? { color: tone } : undefined}>{value}</span>
    <span className="text-[var(--ec-muted)]">{label}</span>
  </span>
);

export const LandingPage = ({
  snapshot,
  sessionJoke,
  onSelectProject,
  onSelectRun,
  onOpenAllRuns,
}: LandingPageProps) => {
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.mutations;
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const allRuns = useMemo(
    () => snapshot.projects.flatMap((entry) => entry.runs),
    [snapshot.projects],
  );
  const allSubagentRuns = useMemo(
    () => snapshot.projects.flatMap((entry) => entry.orchestratedRuns),
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

  const recentActivityRuns = useMemo(
    () => [...allRuns, ...allSubagentRuns]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, RECENT_RUN_LIMIT),
    [allRuns, allSubagentRuns],
  );
  const recentRunRows = useMemo(() => {
    const knownPrimaryRuns = snapshot.projects.flatMap((entry) => [...entry.runs, ...entry.forLaterRuns]);
    const hierarchyRoots = findRunHierarchyScopeRoots(recentActivityRuns, allRuns, allSubagentRuns, knownPrimaryRuns);
    return buildRunHierarchyRows(hierarchyRoots, allSubagentRuns, { expandedRunIds });
  }, [allRuns, allSubagentRuns, expandedRunIds, recentActivityRuns, snapshot.projects]);
  const toggleRunHierarchy = useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const rate = successRate(totals.outcomes);
  const activeRuns = totals.outcomes.active;
  const activeProjectCount = snapshot.projects.filter((entry) => entry.activeRuns.length > 0).length;

  const stats: LandingStat[] = [
    {
      label: "Projects",
      value: formatFullNumber(totals.projects),
      detail: `${String(totals.providerAccounts)} providers · ${String(totals.models)} models`,
      icon: FolderGit2,
    },
    {
      label: "Runs",
      value: formatFullNumber(totals.runs),
      detail: `${String(totals.outcomes.completed)} done · ${String(totals.outcomes.failed)} failed`,
      icon: PlayCircle,
    },
    {
      label: "Success rate",
      value: rate === null ? "–" : `${String(Math.round(rate * 100))}%`,
      detail: rate === null ? "No finished runs yet" : "of finished runs",
      icon: CheckCircle2,
    },
    {
      label: "Active now",
      value: activeRuns > 0 ? formatFullNumber(activeRuns) : "Idle",
      detail: activeRuns > 0
        ? `across ${String(activeProjectCount)} ${activeProjectCount === 1 ? "project" : "projects"}`
        : "No runs in progress",
      icon: Activity,
      highlight: activeRuns > 0,
    },
    {
      label: "Tokens",
      value: formatCompactNumber(totals.totalTokens),
      valueTitle: `${formatFullNumber(totals.totalTokens)} tokens`,
      detail: `${formatCompactNumber(totals.inputTokens)} in · ${formatCompactNumber(totals.outputTokens)} out`,
      icon: WalletCards,
    },
    {
      label: "Chats",
      value: formatFullNumber(totals.chats),
      detail: "standalone conversations",
      icon: MessagesSquare,
    },
  ];

  return (
    <div className="flex w-full flex-col gap-3 lg:h-full lg:min-h-[47rem] xl:min-h-[41rem]" data-landing-page>
      <Card className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-[1_1_24rem] items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--ec-accent-soft)] text-[var(--ec-accent)] ring-1 ring-inset ring-[var(--ec-accent-ring)]">
            <Terminal className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-accent)]">Boot message</p>
            <p className="mt-0.5 text-sm font-medium leading-6 text-[var(--ec-text)]">{sessionJoke}</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5" aria-label="Today's activity">
          <SectionLabel>Today</SectionLabel>
          <TodayChip value={todayActivity.runsStarted} label="started" />
          <TodayChip value={todayActivity.completedRuns} label="done" tone={todayActivity.completedRuns > 0 ? "var(--ec-success)" : undefined} />
          <TodayChip value={todayActivity.failedRuns} label="failed" tone={todayActivity.failedRuns > 0 ? "var(--ec-danger)" : undefined} />
          <TodayChip value={todayActivity.activeRuns} label="active" tone={todayActivity.activeRuns > 0 ? "var(--ec-accent)" : undefined} />
          <span title={`${formatFullNumber(todayActivity.tokensUsed)} tokens today`}>
            <TodayChip value={formatCompactNumber(todayActivity.tokensUsed)} label="tokens" />
          </span>
        </div>
      </Card>

      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((stat) => <LandingStatTile key={stat.label} stat={stat} />)}
      </div>

      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <Card className="flex min-h-0 flex-col">
          <CardHeader className="shrink-0 flex-row items-start gap-2 px-4 pt-3 pb-2">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
            <div className="min-w-0">
              <CardTitle>Recent runs</CardTitle>
              <CardDescription>Latest agent activity across all projects.</CardDescription>
            </div>
            {onOpenAllRuns ? (
              <CardAction>
                <Button size="xs" variant="ghost" onClick={onOpenAllRuns}>View all</Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
            {recentRunRows.length > 0 ? (
              <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto max-lg:max-h-[28rem]">
                {recentRunRows.map(({ run, depth, descendantCount, expanded }) => {
                  const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
                  const label = runHierarchyLabel(run);
                  return (
                    <RunHierarchyIndent
                      key={run.id}
                      depth={depth}
                      indentPx={18}
                      className={cn("border-t border-[var(--ec-border)]", depth > 0 && "bg-[var(--ec-panel-soft)]")}
                    >
                      <div data-run-hierarchy-run={run.id} className="flex items-center gap-3 px-4 py-2 transition hover:bg-[var(--ec-hover)]">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                          onClick={() => onSelectRun(run.projectId, run.id)}
                        >
                          <ProviderBrandIcon
                            harnessType={run.harnessType}
                            providerType={providerTypeByAccountId.get(run.providerAccountId)}
                            className="size-4 shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-sm font-semibold text-[var(--ec-text)]" title={label}>{label}</span>
                              {depth > 0 ? <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--ec-accent)]">Subagent</span> : null}
                            </span>
                            <span className="mt-0.5 block truncate font-mono text-xs text-[var(--ec-muted)]" title={new Date(run.createdAt).toLocaleString()}>
                              {projectNames.get(run.projectId) ?? "Unknown project"} · {formatRunRelativeTime(run.createdAt)} · {formatRunDuration(run)}
                            </span>
                          </span>
                        </button>
                        <div className="flex shrink-0 items-center gap-2">
                          {descendantCount > 0 ? (
                            <RunHierarchyToggle
                              runId={run.id}
                              runLabel={label}
                              descendantCount={descendantCount}
                              expanded={expanded}
                              onToggle={toggleRunHierarchy}
                            />
                          ) : null}
                          <Badge dot tone={runDisplayStatusTone(displayStatus)}>{RUN_DISPLAY_STATUS_LABELS[displayStatus]}</Badge>
                          <span
                            className="hidden w-14 text-right font-mono text-xs tabular-nums text-[var(--ec-muted)] sm:inline"
                            title={`${formatFullNumber(run.inputTokens + run.outputTokens)} tokens`}
                          >
                            {formatCompactNumber(run.inputTokens + run.outputTokens)}
                          </span>
                        </div>
                      </div>
                    </RunHierarchyIndent>
                  );
                })}
              </div>
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
          {/* Projects size to their content (up to half the column) and give way first, so Activity keeps a readable chart. */}
          <Card className="flex min-h-0 flex-col lg:max-h-[50%] lg:min-h-[9rem]">
            <CardHeader className="shrink-0 flex-row items-start gap-2 px-4 pt-3 pb-2">
              <FolderGit2 className="mt-0.5 size-4 shrink-0 text-[var(--ec-muted)]" aria-hidden />
              <div className="min-w-0">
                <CardTitle>Projects</CardTitle>
                <CardDescription>Most recently updated first.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-lg p-0">
              {projects.length > 0 ? (
                <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto max-lg:max-h-[22rem]">
                  {projects.map(({ entry, outcomes }) => {
                    const projectTokens = entry.project.cumulativeInputTokens + entry.project.cumulativeOutputTokens;
                    const activeCount = entry.activeRuns.length;
                    return (
                      <button
                        key={entry.project.id}
                        type="button"
                        className="flex w-full items-center gap-3 border-t border-[var(--ec-border)] px-4 py-2 text-left transition hover:bg-[var(--ec-hover)]"
                        onClick={() => onSelectProject(entry.project.id)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-[var(--ec-text)]">{entry.project.name}</span>
                          <span className="mt-0.5 block truncate font-mono text-xs text-[var(--ec-muted)]" title={entry.project.repoPath}>{entry.project.repoPath}</span>
                          <RunOutcomeBar counts={outcomes} className="mt-1.5" />
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <Badge dot tone={activeCount > 0 ? "running" : "neutral"}>
                            {activeCount > 0 ? `${String(activeCount)} active` : `${String(entry.runs.length)} runs`}
                          </Badge>
                          <span className="font-mono text-xs tabular-nums text-[var(--ec-muted)]" title={`${formatFullNumber(projectTokens)} tokens`}>
                            {formatCompactNumber(projectTokens)} tokens
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty className="flex-1">
                  <EmptyHeader>
                    <FolderGit2 className="size-8 text-[var(--ec-muted)]" />
                    <EmptyTitle>No projects yet</EmptyTitle>
                    <EmptyDescription>{readOnly ? "No projects are configured on the BuildWarden host." : "Add your first project from the sidebar to start tracking work here."}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>

          <LandingActivityPanel runs={allRuns} providerAccounts={snapshot.providerAccounts} className="lg:min-h-[20rem] lg:flex-1" />
        </div>
      </div>
    </div>
  );
};
