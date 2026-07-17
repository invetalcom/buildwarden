import type { ProjectActivityInsightData, ProjectInsightKind, ProjectSnapshot } from "@buildwarden/shared";
import { Activity, CalendarDays, GitCommitHorizontal, Loader2, RefreshCw, UsersRound } from "lucide-react";
import { useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  ProjectActivityMomentumGrowth,
  ProjectActivityRepositoryHealth,
  ProjectActivityRiskSections,
} from "./ProjectActivityAdvancedSections";
import { ProjectActivityExplorer } from "./ProjectActivityExplorer";
import { getProjectInsight, parseProjectInsightData } from "./project-insight-utils";

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

const ActivitySummaryMetrics = ({ activity }: { activity: ProjectActivityInsightData }) => (
  <div className="grid min-w-0 flex-1 grid-cols-2 divide-x divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)] sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-5">
    <Metric label="Commits" value={formatNumber(activity.summaryStats.totalCommits)} detail={`${formatNumber(activity.summaryStats.activeDays)} active days`} />
    <Metric label="Contributors" value={formatNumber(activity.summaryStats.contributorCount)} detail={`${activity.summaryStats.busFactor50} make half the commits`} />
    <Metric label="Lines changed" value={formatCompactNumber(activity.summaryStats.linesAdded + activity.summaryStats.linesDeleted)} detail={`+${formatCompactNumber(activity.summaryStats.linesAdded)} / −${formatCompactNumber(activity.summaryStats.linesDeleted)}`} />
    <Metric label="File touches" value={formatCompactNumber(activity.summaryStats.filesChanged)} detail={`${formatNumber(activity.modules.length)} modules`} />
    <Metric label="History" value={formatShortDate(activity.summaryStats.firstCommitAt)} detail={`through ${formatShortDate(activity.summaryStats.latestCommitAt)}`} />
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
  const [scopeActive, setScopeActive] = useState(false);
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
      <header className="flex items-center gap-3">
        {activity && activity.summaryStats.totalCommits > 0 && !scopeActive
          ? <ActivitySummaryMetrics activity={activity} />
          : <div className="min-w-0 flex-1" />}
        {canGenerateInsights ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 text-[var(--ec-accent)] hover:bg-[var(--ec-accent-soft)] hover:text-[var(--ec-accent-strong)]"
            onClick={() => void handleRefresh()}
            disabled={busy}
            aria-label={busy ? "Refreshing Activity" : activity ? "Refresh Activity" : "Analyze Activity history"}
            title={busy ? "Refreshing Activity…" : activity ? "Refresh Activity" : "Analyze Activity history"}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        ) : null}
      </header>
      {activity && activity.summaryStats.totalCommits > 0 ? (
        <>
          <ProjectActivityExplorer projectId={project.project.id} activity={activity} onScopeActiveChange={setScopeActive} />
          {!scopeActive ? <div className="mt-10 space-y-10">
          {!activity.hotspots ? (
            <div className="rounded-md border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-3 py-2 text-xs text-[var(--ec-muted)]">
              Refresh this saved report to calculate hotspots, ownership risk, momentum, file age, and release cadence.
            </div>
          ) : null}

          <ContributorTable activity={activity} />

          <ProjectActivityMomentumGrowth activity={activity} />

          <ProjectActivityRiskSections activity={activity} />

          <ProjectActivityRepositoryHealth activity={activity} />

          <RecentHistory activity={activity} />
          </div> : null}
        </>
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
