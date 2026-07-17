import type { ProjectActivityInsightData } from "@buildwarden/shared";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus, Tag } from "lucide-react";
import { cn } from "../../lib/cn";

const numberFormatter = new Intl.NumberFormat();
const compactNumberFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

const formatNumber = (value: number): string => numberFormatter.format(value);
const formatCompactNumber = (value: number): string => compactNumberFormatter.format(value);

const formatShortDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
};

const formatDuration = (days: number): string => {
  if (days < 31) return `${formatNumber(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
};

const SectionHeading = ({ title, detail }: { title: string; detail: string }) => (
  <div className="mb-3 flex items-baseline justify-between gap-3">
    <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--ec-text)]">{title}</h4>
    <p className="text-right text-[11px] text-[var(--ec-faint)]">{detail}</p>
  </div>
);

const Delta = ({ value }: { value: number | null }) => {
  const Icon = value === null || value === 0 ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const label = value === null ? "new" : `${value > 0 ? "+" : ""}${value}%`;
  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 text-[10px] font-medium tabular-nums",
      value !== null && value > 0 ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]",
    )}>
      <Icon className="size-3" />
      {label}
    </span>
  );
};

const MomentumPanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const windows = activity.momentum ?? [];
  return (
    <section className="min-w-0">
      <SectionHeading title="Momentum" detail="Current window vs previous window" />
      <div className="overflow-hidden rounded-md border border-[var(--ec-border)]">
        <div className="grid grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] bg-[var(--ec-panel-soft)] px-3 py-2 text-[10px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">
          <span>Window</span>
          <span className="text-right">Commits</span>
          <span className="text-right">People</span>
          <span className="text-right">Churn</span>
        </div>
        <div className="divide-y divide-[var(--ec-border)]">
          {windows.map((window) => (
            <div key={window.days} className="grid grid-cols-[4.5rem_repeat(3,minmax(0,1fr))] items-center px-3 py-3">
              <div>
                <p className="text-xs font-semibold text-[var(--ec-text)]">{window.days} days</p>
                <p className="text-[10px] text-[var(--ec-faint)]">rolling</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums text-[var(--ec-text)]">{formatNumber(window.current.commits)}</p>
                <Delta value={window.changePercent.commits} />
              </div>
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums text-[var(--ec-text)]">{formatNumber(window.current.contributors)}</p>
                <Delta value={window.changePercent.contributors} />
              </div>
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums text-[var(--ec-text)]">{formatCompactNumber(window.current.linesChanged)}</p>
                <Delta value={window.changePercent.linesChanged} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const GrowthPanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const growth = activity.codeGrowth;
  const months = activity.monthlyActivity.slice(-8);
  const maxNetLines = Math.max(1, ...months.map((month) => Math.abs(month.netLines ?? 0)));
  return (
    <section className="min-w-0">
      <SectionHeading title="Code growth" detail="Net text change across analyzed history" />
      <div className="border-y border-[var(--ec-border)] py-3">
        <div className="grid grid-cols-3 divide-x divide-[var(--ec-border)]">
          <div className="pr-3">
            <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">Net lines</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--ec-text)]">
              {(growth?.netLines ?? 0) > 0 ? "+" : ""}{formatCompactNumber(growth?.netLines ?? 0)}
            </p>
          </div>
          <div className="px-3">
            <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">Files created</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--ec-success)]">+{formatNumber(growth?.filesCreated ?? 0)}</p>
          </div>
          <div className="pl-3">
            <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">Files deleted</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--ec-danger)]">−{formatNumber(growth?.filesDeleted ?? 0)}</p>
          </div>
        </div>
        <div className="mt-4 space-y-1.5">
          {months.map((month) => {
            const netLines = month.netLines ?? 0;
            const width = Math.max(1, (Math.abs(netLines) / maxNetLines) * 48);
            return (
              <div key={month.month} className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-2">
                <span className="text-[10px] tabular-nums text-[var(--ec-faint)]">{month.month.slice(2)}</span>
                <div className="relative h-1.5 rounded-full bg-[var(--ec-muted-soft)]">
                  <div className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--ec-border-strong)]" />
                  <div
                    className={cn("absolute h-full rounded-full", netLines >= 0 ? "left-1/2 bg-[var(--ec-success)]" : "right-1/2 bg-[var(--ec-danger)]")}
                    style={{ width: `${width}%` }}
                  />
                </div>
                <span className="text-right text-[10px] tabular-nums text-[var(--ec-muted)]">{netLines > 0 ? "+" : ""}{formatCompactNumber(netLines)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export const ProjectActivityMomentumGrowth = ({ activity }: { activity: ProjectActivityInsightData }) => {
  if (!activity.momentum || !activity.codeGrowth) return null;
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <MomentumPanel activity={activity} />
      <GrowthPanel activity={activity} />
    </div>
  );
};

const HotspotPanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const hotspots = activity.hotspots;
  if (!hotspots) return null;
  const rows = [
    ...hotspots.files.slice(0, 5).map((hotspot) => ({ ...hotspot, kind: "file" })),
    ...hotspots.modules.slice(0, 3).map((hotspot) => ({ ...hotspot, kind: "module" })),
  ].sort((left, right) => right.score - left.score).slice(0, 7);
  const maxScore = rows[0]?.score ?? 1;
  return (
    <section className="min-w-0">
      <SectionHeading title="Change hotspots" detail="Frequency × churn × recency" />
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {rows.map((hotspot) => (
          <div key={`${hotspot.kind}-${hotspot.path}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 hover:bg-[var(--ec-hover)]">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-mono text-xs text-[var(--ec-text)]" title={hotspot.path}>{hotspot.path}</p>
                <span className="rounded-sm bg-[var(--ec-muted-soft)] px-1 py-0.5 text-[9px] uppercase text-[var(--ec-faint)]">{hotspot.kind}</span>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--ec-muted-soft)]">
                <div className="h-full rounded-full bg-[var(--ec-accent)]" style={{ width: `${Math.max(2, (hotspot.score / maxScore) * 100)}%` }} />
              </div>
              <p className="mt-1 text-[10px] text-[var(--ec-faint)]">
                {formatNumber(hotspot.commits)} commits · {formatCompactNumber(hotspot.linesChanged)} lines · {formatShortDate(hotspot.lastChangedAt)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums text-[var(--ec-text)]">{hotspot.score}</p>
              <p className="text-[9px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">score</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

const OwnershipPanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const ownership = activity.moduleOwnership ?? [];
  const siloCount = ownership.filter((module) => module.risk === "silo").length;
  const rows = [...ownership]
    .sort((left, right) => {
      const riskRank = { silo: 2, concentrated: 1, shared: 0 } as const;
      return riskRank[right.risk] - riskRank[left.risk] || right.commits - left.commits;
    })
    .slice(0, 7);
  return (
    <section className="min-w-0">
      <SectionHeading title="Ownership risk" detail={`${siloCount} knowledge ${siloCount === 1 ? "silo" : "silos"} at ≥80%`} />
      <div className="divide-y divide-[var(--ec-border)] border-y border-[var(--ec-border)]">
        {rows.map((module) => (
          <div key={module.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate font-mono text-xs text-[var(--ec-text)]" title={module.path}>{module.path}</p>
                {module.risk === "concentrated" ? (
                  <span className="rounded-sm bg-[var(--ec-warning-soft)] px-1 py-0.5 text-[9px] uppercase text-[var(--ec-warning)]">
                    concentrated
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-[10px] text-[var(--ec-faint)]" title={module.primaryOwnerEmail}>
                {module.primaryOwnerName} · {module.ownershipShare}% of module commits · {module.contributorCount} contributors
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold tabular-nums text-[var(--ec-text)]">{module.ownershipShare}%</p>
              <p className="text-[9px] uppercase tracking-[0.08em] text-[var(--ec-faint)]">bus {module.busFactor50}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export const ProjectActivityRiskSections = ({ activity }: { activity: ProjectActivityInsightData }) => {
  if (!activity.hotspots || !activity.moduleOwnership) return null;
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <HotspotPanel activity={activity} />
      <OwnershipPanel activity={activity} />
    </div>
  );
};

const CommitSizePanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const size = activity.commitSize;
  if (!size) return null;
  return (
    <section className="min-w-0">
      <SectionHeading title="Commit size" detail={`Mega commit: ≥${formatNumber(size.megaCommitThreshold)} lines`} />
      <div className="grid grid-cols-3 divide-x divide-[var(--ec-border)] border-y border-[var(--ec-border)] py-2.5">
        <div className="pr-3"><p className="text-[10px] text-[var(--ec-faint)]">Median</p><p className="text-base font-semibold tabular-nums text-[var(--ec-text)]">{formatNumber(size.medianLinesChanged)}</p></div>
        <div className="px-3"><p className="text-[10px] text-[var(--ec-faint)]">90th pct.</p><p className="text-base font-semibold tabular-nums text-[var(--ec-text)]">{formatNumber(size.p90LinesChanged)}</p></div>
        <div className="pl-3"><p className="text-[10px] text-[var(--ec-faint)]">Mega share</p><p className="text-base font-semibold tabular-nums text-[var(--ec-text)]">{size.megaCommitShare}%</p></div>
      </div>
      <div className="mt-2 divide-y divide-[var(--ec-border)]">
        {size.largestCommits.slice(0, 4).map((commit) => (
          <div key={commit.sha} className="flex min-w-0 items-center gap-2 py-2">
            <span className="w-14 shrink-0 font-mono text-[10px] text-[var(--ec-accent)]">{commit.sha.slice(0, 7)}</span>
            <p className="min-w-0 flex-1 truncate text-xs text-[var(--ec-muted)]" title={commit.title}>{commit.title || "Untitled commit"}</p>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--ec-text)]">{formatCompactNumber(commit.linesChanged)} lines</span>
          </div>
        ))}
      </div>
    </section>
  );
};

const FileAgePanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const age = activity.fileAge;
  if (!age) return null;
  return (
    <section className="min-w-0">
      <SectionHeading title="File age" detail={`${formatNumber(age.trackedFileCount)} currently tracked`} />
      <div className="grid grid-cols-2 divide-x divide-[var(--ec-border)] border-y border-[var(--ec-border)] py-2.5">
        <div className="pr-3"><p className="text-[10px] text-[var(--ec-faint)]">Median age</p><p className="text-base font-semibold text-[var(--ec-text)]">{formatDuration(age.medianAgeDays)}</p></div>
        <div className="pl-3"><p className="text-[10px] text-[var(--ec-faint)]">Median untouched</p><p className="text-base font-semibold text-[var(--ec-text)]">{formatDuration(age.medianDaysSinceChange)}</p></div>
      </div>
      <div className="mt-2 divide-y divide-[var(--ec-border)]">
        {age.oldestUntouchedFiles.slice(0, 5).map((file) => (
          <div key={file.path} className="flex min-w-0 items-center gap-2 py-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--ec-muted)]" title={file.path}>{file.path}</p>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--ec-text)]">{formatDuration(file.daysSinceChange)} untouched</span>
          </div>
        ))}
      </div>
      {age.staleModules.length > 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--ec-warning)]">
          <AlertTriangle className="size-3" /> {age.staleModules.length} modules untouched for at least {age.staleThresholdDays} days
        </p>
      ) : null}
    </section>
  );
};

const ReleasePanel = ({ activity }: { activity: ProjectActivityInsightData }) => {
  const cadence = activity.releaseCadence;
  if (!cadence) return null;
  const releases = cadence.releases.slice(-8);
  const maxLines = Math.max(1, ...releases.map((release) => release.linesChanged ?? 0));
  return (
    <section className="min-w-0">
      <SectionHeading title="Release cadence" detail={`${cadence.totalReleases} tags · sizes ${cadence.sizeTrend.replace("-", " ")}`} />
      {releases.length > 0 ? (
        <>
          <div className="grid grid-cols-3 divide-x divide-[var(--ec-border)] border-y border-[var(--ec-border)] py-2.5">
            <div className="pr-3"><p className="text-[10px] text-[var(--ec-faint)]">Avg cadence</p><p className="text-base font-semibold text-[var(--ec-text)]">{formatDuration(cadence.averageDaysBetweenReleases)}</p></div>
            <div className="px-3"><p className="text-[10px] text-[var(--ec-faint)]">Median cadence</p><p className="text-base font-semibold text-[var(--ec-text)]">{formatDuration(cadence.medianDaysBetweenReleases)}</p></div>
            <div className="pl-3"><p className="text-[10px] text-[var(--ec-faint)]">Commits/release</p><p className="text-base font-semibold tabular-nums text-[var(--ec-text)]">{cadence.averageCommitsPerRelease}</p></div>
          </div>
          <div className="mt-3 flex h-20 items-end gap-1.5">
            {releases.map((release) => (
              <div key={`${release.name}-${release.date}`} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${release.name}: ${formatNumber(release.commitsSincePrevious)} commits, ${formatNumber(release.linesChanged ?? 0)} changed lines`}>
                <div className="flex h-14 w-full items-end">
                  <div className="w-full rounded-[2px] bg-[var(--ec-accent-soft)] transition-colors group-hover:bg-[var(--ec-accent)]" style={{ height: `${Math.max(5, ((release.linesChanged ?? 0) / maxLines) * 100)}%` }} />
                </div>
                <span className="max-w-full truncate text-[9px] text-[var(--ec-faint)]">{release.name}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="flex min-h-28 flex-col items-center justify-center border-y border-dashed border-[var(--ec-border)] text-center">
          <Tag className="size-4 text-[var(--ec-faint)]" />
          <p className="mt-2 text-xs text-[var(--ec-muted)]">No Git tags found</p>
        </div>
      )}
    </section>
  );
};

export const ProjectActivityRepositoryHealth = ({ activity }: { activity: ProjectActivityInsightData }) => {
  if (!activity.commitSize || !activity.fileAge || !activity.releaseCadence) return null;
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-3">
      <CommitSizePanel activity={activity} />
      <FileAgePanel activity={activity} />
      <ReleasePanel activity={activity} />
    </div>
  );
};
