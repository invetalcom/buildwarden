import type { ProjectActivityInsightData, ProjectInsightKind, ProjectSnapshot } from "@buildwarden/shared";
import { Activity, CalendarDays, GitCommitHorizontal, Loader2, RefreshCw, UsersRound } from "lucide-react";
import { useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { formatGeneratedAt, getProjectInsight, parseProjectInsightData } from "./project-insight-utils";

interface ProjectActivityTabProps {
  project: ProjectSnapshot;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

const numberFormatter = new Intl.NumberFormat();
const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

const formatNumber = (value: number): string => numberFormatter.format(value);
const formatCompactNumber = (value: number): string => compactNumberFormatter.format(value);

const formatShortDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
};

const formatMonth = (value: string): string => {
  const date = new Date(`${value}-01T12:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, { month: "short" }).format(date);
};

const initialsForName = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const Metric = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="min-w-0 px-3 py-2.5 first:pl-0 last:pr-0 sm:px-4">
    <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--ec-faint)]">{label}</p>
    <p className="mt-0.5 truncate text-lg font-semibold tabular-nums text-[var(--ec-text)]">{value}</p>
    <p className="truncate text-[11px] text-[var(--ec-muted)]">{detail}</p>
  </div>
);

const SectionHeading = ({ title, detail }: { title: string; detail: string }) => (
  <div className="mb-3 flex items-baseline justify-between gap-3">
    <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">{title}</h4>
    <p className="text-[11px] text-[var(--ec-faint)]">{detail}</p>
  </div>
);

const ContributorTable = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const maxCommits = activity.contributors[0]?.commits ?? 1;
  return (
    <section className="min-w-0">
      <SectionHeading title="Top contributors" detail={`${formatNumber(activity.contributors.length)} total`} />
      <div className="overflow-hidden rounded-md border border-[var(--ec-border)]">
        <table className="w-full table-fixed text-left">
          <thead className="bg-[var(--ec-panel-soft)] text-[10px] uppercase tracking-[0.1em] text-[var(--ec-faint)]">
            <tr>
              <th className="w-[46%] px-3 py-2 font-medium">Contributor</th>
              <th className="w-[18%] px-2 py-2 text-right font-medium">Commits</th>
              <th className="w-[20%] px-2 py-2 text-right font-medium">Lines</th>
              <th className="w-[16%] px-3 py-2 text-right font-medium">Days</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ec-border)]">
            {activity.contributors.slice(0, 10).map((contributor) => (
              <tr key={`${contributor.email}-${contributor.name}`} className="group transition-colors hover:bg-[var(--ec-hover)]">
                <td className="px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--ec-accent-soft)] text-[10px] font-semibold text-[var(--ec-accent)]">
                      {initialsForName(contributor.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p
                          className="truncate text-xs font-medium text-[var(--ec-text)]"
                          title={contributor.email ? `${contributor.name} <${contributor.email}>` : contributor.name}
                        >
                          {contributor.name}
                        </p>
                        <span className="shrink-0 text-[10px] tabular-nums text-[var(--ec-faint)]">{contributor.commitShare}%</span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
                        <div
                          className="h-full rounded-full bg-[var(--ec-accent)] transition-[width] duration-300"
                          style={{ width: `${Math.max(2, (contributor.commits / maxCommits) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right text-xs font-medium tabular-nums text-[var(--ec-text)]">
                  {formatNumber(contributor.commits)}
                </td>
                <td className="px-2 py-2.5 text-right">
                  <p className="text-xs tabular-nums text-[var(--ec-text)]">{formatCompactNumber(contributor.linesChanged)}</p>
                  <p className="text-[10px] tabular-nums text-[var(--ec-faint)]">
                    <span className="text-[var(--ec-success)]">+{formatCompactNumber(contributor.linesAdded)}</span>{" "}
                    <span className="text-[var(--ec-danger)]">−{formatCompactNumber(contributor.linesDeleted)}</span>
                  </p>
                </td>
                <td className="px-3 py-2.5 text-right text-xs tabular-nums text-[var(--ec-muted)]">{formatNumber(contributor.activeDays)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const CommitRhythm = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const maxWeekdayCommits = Math.max(1, ...activity.weekdays.map((weekday) => weekday.commits));
  const recentMonths = activity.monthlyActivity.slice(-12);
  const maxMonthCommits = Math.max(1, ...recentMonths.map((month) => month.commits));
  const busiestWeekday = [...activity.weekdays].sort((left, right) => right.commits - left.commits)[0];

  return (
    <section className="min-w-0">
      <SectionHeading title="Commit rhythm" detail={busiestWeekday ? `${busiestWeekday.label} is busiest` : "No activity"} />
      <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 pb-3 pt-3.5">
        <div className="flex h-28 items-end justify-between gap-2" aria-label="Commits by weekday">
          {activity.weekdays.map((weekday) => (
            <div key={weekday.weekday} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
              <span className="text-[10px] font-medium tabular-nums text-[var(--ec-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                {weekday.commits}
              </span>
              <div className="flex h-20 w-full items-end justify-center">
                <div
                  className={cn(
                    "w-full max-w-7 rounded-sm bg-[var(--ec-accent-soft)] transition-[height,background-color] duration-300 group-hover:bg-[var(--ec-accent)]",
                    weekday.commits === maxWeekdayCommits && weekday.commits > 0 && "bg-[var(--ec-accent)]",
                  )}
                  style={{ height: weekday.commits ? `${Math.max(6, (weekday.commits / maxWeekdayCommits) * 100)}%` : "2px" }}
                  title={`${weekday.label}: ${formatNumber(weekday.commits)} commits (${weekday.commitShare}%)`}
                />
              </div>
              <span className="text-[10px] text-[var(--ec-faint)]">{weekday.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 border-t border-[var(--ec-border)] pt-3">
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--ec-faint)]">Last 12 active months</p>
            <p className="text-[10px] text-[var(--ec-faint)]">commits</p>
          </div>
          <div className="flex h-14 items-end gap-1" aria-label="Recent monthly commits">
            {recentMonths.map((month, index) => (
              <div key={month.month} className="group flex h-full min-w-0 flex-1 items-end" title={`${month.month}: ${formatNumber(month.commits)} commits`}>
                <div
                  className="relative w-full rounded-[2px] bg-[var(--ec-accent-soft)] transition-colors group-hover:bg-[var(--ec-accent)]"
                  style={{ height: `${Math.max(7, (month.commits / maxMonthCommits) * 100)}%` }}
                >
                  {(index === 0 || index === recentMonths.length - 1) ? (
                    <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[9px] text-[var(--ec-faint)]">{formatMonth(month.month)}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--ec-border)] pb-2">
          <dt className="text-[var(--ec-muted)]">Weekly pace</dt>
          <dd className="font-medium tabular-nums text-[var(--ec-text)]">{activity.summaryStats.averageCommitsPerWeek}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--ec-border)] pb-2">
          <dt className="text-[var(--ec-muted)]">Longest streak</dt>
          <dd className="font-medium tabular-nums text-[var(--ec-text)]">{activity.summaryStats.longestDailyStreak}d</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-[var(--ec-muted)]">Merge commits</dt>
          <dd className="font-medium tabular-nums text-[var(--ec-text)]">{formatNumber(activity.summaryStats.mergeCommits)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-[var(--ec-muted)]">50% bus factor</dt>
          <dd className="font-medium tabular-nums text-[var(--ec-text)]">{activity.summaryStats.busFactor50}</dd>
        </div>
      </dl>
    </section>
  );
};

const ModuleHotspots = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const maxCommits = activity.modules[0]?.commits ?? 1;
  return (
    <section className="min-w-0">
      <SectionHeading title="Most changed modules" detail="Commit reach and line churn" />
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {activity.modules.slice(0, 10).map((module, index) => (
          <div key={module.path} className="group grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 py-2.5 transition-colors hover:bg-[var(--ec-hover)]">
            <span className="text-center text-[10px] tabular-nums text-[var(--ec-faint)]">{index + 1}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-mono text-xs text-[var(--ec-text)]" title={module.path}>{module.path}</p>
                <span className="shrink-0 text-[10px] text-[var(--ec-faint)]">{module.commitShare}%</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
                <div className="h-full rounded-full bg-[var(--ec-accent)]" style={{ width: `${Math.max(2, (module.commits / maxCommits) * 100)}%` }} />
              </div>
            </div>
            <div className="min-w-28 text-right">
              <p className="text-xs font-medium tabular-nums text-[var(--ec-text)]">{formatNumber(module.commits)} commits</p>
              <p className="text-[10px] tabular-nums text-[var(--ec-faint)]">
                {formatCompactNumber(module.linesChanged)} lines · {formatNumber(module.uniqueFiles)} files
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const RecentHistory = ({ activity }: { activity: ProjectActivityInsightData }) => (
  <section className="min-w-0">
    <SectionHeading title="Recent history" detail="Latest reachable commits" />
    <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
      {activity.recentCommits.slice(0, 8).map((commit) => (
        <div key={commit.sha} className="flex min-w-0 items-start gap-2.5 py-2.5">
          <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-[var(--ec-faint)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-[var(--ec-text)]" title={commit.title}>{commit.title || "Untitled commit"}</p>
            <p className="mt-0.5 truncate text-[10px] text-[var(--ec-faint)]">
              <span className="font-mono text-[var(--ec-accent)]">{commit.sha.slice(0, 7)}</span> · {commit.author} · {formatShortDate(commit.date)}
            </p>
          </div>
          <p className="shrink-0 text-[10px] tabular-nums text-[var(--ec-muted)]">{formatCompactNumber(commit.linesChanged)} lines</p>
        </div>
      ))}
    </div>
  </section>
);

export const ProjectActivityTab = ({ project, onGenerateInsight }: ProjectActivityTabProps) => {
  const canGenerateInsights = useBuildWardenClient().capabilities.insightMutations;
  const [busy, setBusy] = useState(false);
  const record = getProjectInsight(project, "activity");
  const activity = parseProjectInsightData<ProjectActivityInsightData>(record);

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await onGenerateInsight("activity");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="h-full min-h-0 overflow-y-auto p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <Activity className="mt-0.5 size-4 shrink-0 text-[var(--ec-accent)]" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-[var(--ec-text)]">Activity</h3>
            <p className="text-xs text-[var(--ec-muted)]">
              {record?.summary ?? "Contributor, cadence, and code-churn patterns across the repository's full reachable history."}
            </p>
          </div>
        </div>
        {canGenerateInsights ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh()} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {busy ? "Analyzing…" : activity ? "Refresh" : "Analyze history"}
          </Button>
        ) : null}
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--ec-faint)]">
        <span>Updated {formatGeneratedAt(record?.generatedAt)}</span>
        {activity ? <span>All reachable refs · mailmap-aware authors</span> : null}
      </div>

      {activity && activity.summaryStats.totalCommits > 0 ? (
        <div className="mt-4 space-y-6">
          <div className="grid grid-cols-2 divide-x divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)] sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-5">
            <Metric label="Commits" value={formatNumber(activity.summaryStats.totalCommits)} detail={`${formatNumber(activity.summaryStats.activeDays)} active days`} />
            <Metric label="Contributors" value={formatNumber(activity.summaryStats.contributorCount)} detail={`${activity.summaryStats.busFactor50} make half the commits`} />
            <Metric label="Lines changed" value={formatCompactNumber(activity.summaryStats.linesAdded + activity.summaryStats.linesDeleted)} detail={`+${formatCompactNumber(activity.summaryStats.linesAdded)} / −${formatCompactNumber(activity.summaryStats.linesDeleted)}`} />
            <Metric label="File touches" value={formatCompactNumber(activity.summaryStats.filesChanged)} detail={`${formatNumber(activity.modules.length)} modules`} />
            <Metric label="History" value={formatShortDate(activity.summaryStats.firstCommitAt)} detail={`through ${formatShortDate(activity.summaryStats.latestCommitAt)}`} />
          </div>

          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(18rem,1fr)]">
            <ContributorTable activity={activity} />
            <CommitRhythm activity={activity} />
          </div>

          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.85fr)]">
            <ModuleHotspots activity={activity} />
            <RecentHistory activity={activity} />
          </div>
        </div>
      ) : (
        <div className="mt-4 flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-5 text-center">
          {project.project.kind === "git" ? <UsersRound className="size-6 text-[var(--ec-faint)]" /> : <CalendarDays className="size-6 text-[var(--ec-faint)]" />}
          <p className="mt-3 text-sm font-medium text-[var(--ec-text)]">
            {project.project.kind === "git" ? "See who changes what—and when" : "Activity needs a Git repository"}
          </p>
          <p className="mt-1 max-w-md text-xs leading-5 text-[var(--ec-muted)]">
            {project.project.kind === "git"
              ? "Analyze every reachable commit to rank contributors and modules, measure line churn, and reveal the repository's working rhythm."
              : "This project is a plain folder, so it has no commit history to analyze."}
          </p>
          {canGenerateInsights && project.project.kind === "git" ? (
            <Button type="button" size="sm" className="mt-4" onClick={() => void handleRefresh()} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
              {busy ? "Analyzing history…" : "Analyze history"}
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
};
