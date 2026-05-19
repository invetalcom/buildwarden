import { useMemo } from "react";
import type { AppSnapshot } from "@easycode/shared";
import { Activity, Bot, FolderGit2, PlayCircle, Settings2, Sparkles, WalletCards } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

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

  return (
    <div className="space-y-3">
      <Card className="app-surface-landing-hero overflow-hidden border p-4 sm:p-5">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.95fr)] xl:items-stretch">
          <div className="flex min-w-0 flex-col xl:h-full">
            <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-400/85">Boot message</p>
            <div className="mt-2 flex min-h-[9.5rem] flex-1 flex-col xl:h-full">
              <p className="max-w-2xl text-sm leading-6 text-zinc-300">{sessionJoke}</p>
              <div className="mt-auto space-y-3 pt-3">
                <div className="app-surface-inset-soft w-full max-w-[34rem] rounded-2xl border px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Today&apos;s activity</p>
                      <p className="mt-1 text-sm text-zinc-300">
                        {todayActivity.runsStarted} runs started, {todayActivity.completedRuns} completed, {todayActivity.activeRuns} active
                      </p>
                    </div>
                    <p className="text-sm font-medium text-cyan-100">{formatTokens(todayActivity.tokensUsed)} tokens</p>
                  </div>
                </div>

                <div className="grid w-full max-w-[34rem] grid-cols-3 gap-2">
                  {latestRun ? (
                    <Button variant="secondary" className="w-full justify-center" onClick={() => onSelectRun(latestRun.projectId, latestRun.id)}>
                      <PlayCircle className="mr-2 h-4 w-4" />
                      Open latest run
                    </Button>
                  ) : null}
                  <Button variant="secondary" className="w-full justify-center" onClick={onOpenChats}>
                    <Bot className="mr-2 h-4 w-4" />
                    Open chat
                  </Button>
                  <Button variant="secondary" className="w-full justify-center" onClick={onOpenSettings}>
                    <Settings2 className="mr-2 h-4 w-4" />
                    Settings
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="app-surface-stat-tile rounded-2xl border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Projects</p>
                <FolderGit2 className="h-4 w-4 text-cyan-400" />
              </div>
              <p className="mt-2 text-2xl font-semibold text-zinc-50">{totals.projects}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {totals.providerAccounts} providers, {totals.models} models
              </p>
            </div>
            <div className="app-surface-stat-tile rounded-2xl border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Runs</p>
                <PlayCircle className="h-4 w-4 text-cyan-400" />
              </div>
              <p className="mt-2 text-2xl font-semibold text-zinc-50">{totals.runs}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {totals.activeRuns} active, {totals.completedRuns} completed
              </p>
            </div>
            <div className="app-surface-stat-tile rounded-2xl border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Tokens</p>
                <WalletCards className="h-4 w-4 text-cyan-400" />
              </div>
              <p className="mt-2 text-2xl font-semibold text-zinc-50">{formatTokens(totals.totalTokens)}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {formatTokens(totals.inputTokens)} in, {formatTokens(totals.outputTokens)} out
              </p>
            </div>
            <div className="app-surface-stat-tile rounded-2xl border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Workspace</p>
                <Sparkles className="h-4 w-4 text-cyan-400" />
              </div>
              <p className="mt-2 text-2xl font-semibold text-zinc-50">{totals.activeRuns > 0 ? "Busy" : "Idle"}</p>
              <p className="mt-1 text-xs text-zinc-400">
                {totals.activeRuns > 0 ? `${totals.activeRuns} runs in progress` : "No runs currently active"}
              </p>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Recent projects</p>
              <h3 className="mt-1 text-lg font-semibold text-zinc-100">Repositories</h3>
            </div>
            <Activity className="h-4 w-4 text-zinc-500" />
          </div>

          <div className="app-surface-list-well mt-3 divide-y divide-zinc-800/80 rounded-2xl border border-zinc-800/90">
            {recentProjects.length > 0 ? (
              recentProjects.map((entry) => {
                const totalProjectTokens = entry.project.cumulativeInputTokens + entry.project.cumulativeOutputTokens;

                return (
                  <button
                    key={entry.project.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-zinc-900/70"
                    onClick={() => onSelectProject(entry.project.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{entry.project.name}</p>
                      <p className="mt-1 truncate text-xs text-zinc-500">{entry.project.repoPath}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <Badge tone={entry.activeRuns[0]?.status ?? "completed"}>
                        {entry.activeRuns.length > 0 ? `${entry.activeRuns.length} active` : `${entry.runs.length} runs`}
                      </Badge>
                      <p className="mt-1 text-xs text-zinc-500">{formatTokens(totalProjectTokens)} tokens</p>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">Add your first project in Settings to start tracking work here.</div>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Recent runs</p>
              <h3 className="mt-1 text-lg font-semibold text-zinc-100">Agent activity</h3>
            </div>
            <Bot className="h-4 w-4 text-zinc-500" />
          </div>

          <div className="app-surface-list-well mt-3 divide-y divide-zinc-800/80 rounded-2xl border border-zinc-800/90">
            {recentRuns.length > 0 ? (
              recentRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-zinc-900/70"
                  onClick={() => onSelectRun(run.projectId, run.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-100">{run.prompt}</p>
                    <p className="mt-1 truncate text-xs text-zinc-500">
                      {run.projectName} • {formatRunDate(run.createdAt)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={run.status}>{run.status}</Badge>
                    <p className="mt-1 text-xs text-zinc-500">{formatTokens(run.inputTokens + run.outputTokens)} tokens</p>
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">No runs yet. Start one from a project page to populate activity here.</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
