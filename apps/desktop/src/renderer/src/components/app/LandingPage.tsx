import { useMemo } from "react";
import type { AppSnapshot } from "@buildwarden/shared";
import { Activity, Bot, FolderGit2, PlayCircle, Settings2, Sparkles, WalletCards } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

interface LandingPageProps {
  snapshot: AppSnapshot;
  sessionJoke: string;
  onSelectProject: (projectId: string) => void;
  onSelectRun: (projectId: string, runId: string) => void;
  onOpenChats: () => void;
  onOpenSettings: () => void;
}

const formatTokens = (value: number) => value.toLocaleString();

const formatRunDate = (value: string) =>
  new Date(value).toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const LandingPage = ({ snapshot, sessionJoke, onSelectProject, onSelectRun, onOpenChats, onOpenSettings }: LandingPageProps) => {
  const allRuns = useMemo(
    () =>
      snapshot.projects.flatMap((entry) =>
        entry.runs.map((run) => ({
          ...run,
          projectId: entry.project.id,
          projectName: entry.project.name,
        })),
      ),
    [snapshot.projects],
  );

  const totals = useMemo(() => {
    const inputTokens = snapshot.projects.reduce((sum, entry) => sum + entry.project.cumulativeInputTokens, 0);
    const outputTokens = snapshot.projects.reduce((sum, entry) => sum + entry.project.cumulativeOutputTokens, 0);

    return {
      projects: snapshot.projects.length,
      runs: allRuns.length,
      activeRuns: allRuns.filter((run) => ["queued", "preparing", "running"].includes(run.status)).length,
      completedRuns: allRuns.filter((run) => run.status === "completed").length,
      providerAccounts: snapshot.providerAccounts.length,
      models: snapshot.models.length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }, [allRuns, snapshot.models.length, snapshot.projects, snapshot.providerAccounts.length]);

  const recentProjects = useMemo(
    () => snapshot.projects.slice().sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt)).slice(0, 4),
    [snapshot.projects],
  );

  const recentRuns = useMemo(
    () => allRuns.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 5),
    [allRuns],
  );

  const latestRun = recentRuns[0] ?? null;
  const todayActivity = useMemo(() => {
    const today = new Date().toDateString();
    const todaysRuns = allRuns.filter((run) => new Date(run.createdAt).toDateString() === today);

    return {
      runsStarted: todaysRuns.length,
      completedRuns: todaysRuns.filter((run) => run.status === "completed").length,
      activeRuns: todaysRuns.filter((run) => ["queued", "preparing", "running"].includes(run.status)).length,
      tokensUsed: todaysRuns.reduce((sum, run) => sum + run.inputTokens + run.outputTokens, 0),
    };
  }, [allRuns]);

  const metrics = [
    {
      label: "Projects",
      value: totals.projects,
      detail: `${totals.providerAccounts} providers, ${totals.models} models`,
      icon: FolderGit2,
    },
    {
      label: "Runs",
      value: totals.runs,
      detail: `${totals.activeRuns} active, ${totals.completedRuns} completed`,
      icon: PlayCircle,
    },
    {
      label: "Tokens",
      value: formatTokens(totals.totalTokens),
      detail: `${formatTokens(totals.inputTokens)} in, ${formatTokens(totals.outputTokens)} out`,
      icon: WalletCards,
    },
    {
      label: "Workspace",
      value: totals.activeRuns > 0 ? "Busy" : "Idle",
      detail: totals.activeRuns > 0 ? `${totals.activeRuns} runs in progress` : "No runs currently active",
      icon: Sparkles,
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      <section className="grid gap-3">
        <Card className="overflow-hidden">
          <CardHeader className="p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[var(--ec-accent)]">Boot Message</p>
            <CardTitle className="text-lg leading-7">{sessionJoke}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-5 pb-5">
            <div className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-faint)]">Today's Activity</p>
                  <p className="mt-1 text-sm text-[var(--ec-text)]">
                    {todayActivity.runsStarted} runs started, {todayActivity.completedRuns} completed, {todayActivity.activeRuns} active
                  </p>
                </div>
                <p className="font-mono text-sm font-semibold text-[var(--ec-accent)]">{formatTokens(todayActivity.tokensUsed)} tokens</p>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              {latestRun ? (
                <Button variant="secondary" className="justify-center" onClick={() => onSelectRun(latestRun.projectId, latestRun.id)}>
                  <PlayCircle data-icon="inline-start" />
                  Open latest run
                </Button>
              ) : null}
              <Button variant="secondary" className="justify-center" onClick={onOpenChats}>
                <Bot data-icon="inline-start" />
                Open chat
              </Button>
              <Button variant="secondary" className="justify-center" onClick={onOpenSettings}>
                <Settings2 data-icon="inline-start" />
                Settings
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <Card key={metric.label}>
                <CardHeader className="p-4">
                  <div className="flex items-center justify-between gap-2">
                    <CardDescription className="font-semibold uppercase tracking-[0.22em]">{metric.label}</CardDescription>
                    <Icon className="size-4 text-[var(--ec-accent)]" />
                  </div>
                  <CardTitle className="text-2xl">{metric.value}</CardTitle>
                  <CardDescription>{metric.detail}</CardDescription>
                </CardHeader>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-faint)]">Recent Projects</p>
              <CardTitle className="mt-1 text-lg">Repositories</CardTitle>
            </div>
            <CardAction>
              <Activity className="size-4 text-[var(--ec-muted)]" />
            </CardAction>
          </CardHeader>
          <CardContent>
            {recentProjects.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-[var(--ec-border)]">
                {recentProjects.map((entry) => {
                  const totalProjectTokens = entry.project.cumulativeInputTokens + entry.project.cumulativeOutputTokens;

                  return (
                    <button
                      key={entry.project.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-4 py-3 text-left transition last:border-b-0 hover:bg-[var(--ec-hover)]"
                      onClick={() => onSelectProject(entry.project.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{entry.project.name}</p>
                        <p className="mt-1 truncate font-mono text-xs text-[var(--ec-muted)]">{entry.project.repoPath}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge dot tone={entry.activeRuns[0]?.status ?? "neutral"}>
                          {entry.activeRuns.length > 0 ? `${entry.activeRuns.length} active` : `${entry.runs.length} runs`}
                        </Badge>
                        <p className="mt-1 font-mono text-xs text-[var(--ec-muted)]">{formatTokens(totalProjectTokens)} tokens</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <FolderGit2 className="size-8 text-[var(--ec-muted)]" />
                  <EmptyTitle>No repositories yet</EmptyTitle>
                  <EmptyDescription>Add your first project in Settings to start tracking work here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--ec-faint)]">Recent Runs</p>
              <CardTitle className="mt-1 text-lg">Agent activity</CardTitle>
            </div>
            <CardAction>
              <Bot className="size-4 text-[var(--ec-muted)]" />
            </CardAction>
          </CardHeader>
          <CardContent>
            {recentRuns.length > 0 ? (
              <div className="overflow-hidden rounded-md border border-[var(--ec-border)]">
                {recentRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 border-b border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-4 py-3 text-left transition last:border-b-0 hover:bg-[var(--ec-hover)]"
                    onClick={() => onSelectRun(run.projectId, run.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--ec-text)]">{run.prompt}</p>
                      <p className="mt-1 truncate font-mono text-xs text-[var(--ec-muted)]">
                        {run.projectName} - {formatRunDate(run.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge dot tone={run.status}>{run.status}</Badge>
                      <p className="mt-1 font-mono text-xs text-[var(--ec-muted)]">{formatTokens(run.inputTokens + run.outputTokens)} tokens</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <PlayCircle className="size-8 text-[var(--ec-muted)]" />
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>Start one from a project page to populate activity here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
};
