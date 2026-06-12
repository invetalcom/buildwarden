import { Activity, FolderGit2, PlayCircle, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

export interface ProjectRunStats {
  total: number;
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ProjectStatisticsCardProps {
  projectRunStats: ProjectRunStats;
  repoPath: string;
}

const StatTile = ({
  icon,
  label,
  value,
  detail,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  className?: string;
}) => (
  <div className={`min-w-0 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3 ${className}`}>
    <div className="flex items-center gap-2 text-xs text-[var(--ec-muted)]">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <p className="mt-2 truncate font-mono text-xl font-semibold text-[var(--ec-text)]">{value}</p>
    {detail ? <p className="mt-1 truncate text-[11px] text-[var(--ec-faint)]">{detail}</p> : null}
  </div>
);

export const ProjectStatisticsCard = ({ projectRunStats, repoPath }: ProjectStatisticsCardProps) => {
  const formatTokens = (value: number) => value.toLocaleString();
  const outcomeSummary = `${projectRunStats.completed} done / ${projectRunStats.failed} failed / ${projectRunStats.cancelled} stopped`;
  const totalRunsLabel =
    projectRunStats.active > 0
      ? `${projectRunStats.total.toLocaleString()} (${projectRunStats.active.toLocaleString()} active)`
      : projectRunStats.total.toLocaleString();

  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="border-b border-[var(--ec-border)] p-4">
        <CardTitle>Statistics</CardTitle>
        <CardDescription>Runs, token usage, and the repository this project controls.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-[0.95fr_1fr_minmax(14rem,1.45fr)]">
        <StatTile
          icon={<PlayCircle className="size-3.5 text-[var(--ec-accent)]" />}
          label="Total runs"
          value={totalRunsLabel}
          detail={outcomeSummary}
        />
        <StatTile
          icon={<WalletCards className="size-3.5 text-[var(--ec-accent)]" />}
          label="Tokens"
          value={formatTokens(projectRunStats.totalTokens)}
          detail={`${formatTokens(projectRunStats.inputTokens)} in / ${formatTokens(projectRunStats.outputTokens)} out`}
        />
        <button
          type="button"
          className="min-w-0 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3 text-left transition hover:bg-[var(--ec-hover)]"
          title={`${repoPath} - open in file manager`}
          onClick={async () => {
            const r = await window.buildwarden.openPathInFileManager(repoPath);
            if (!r.ok && r.error) {
              window.alert(`Could not open folder: ${r.error}`);
            }
          }}
        >
          <div className="flex items-center gap-2 text-xs text-[var(--ec-muted)]">
            <FolderGit2 className="size-3.5 text-[var(--ec-accent)]" />
            <span className="truncate">Repository</span>
            <Activity className="ml-auto size-3 text-[var(--ec-faint)]" />
          </div>
          <p className="mt-2 block w-full truncate font-mono text-xs font-semibold text-[var(--ec-text)]">{repoPath}</p>
          <p className="mt-1 text-[11px] text-[var(--ec-faint)]">Open in file manager</p>
        </button>
      </CardContent>
    </Card>
  );
};
