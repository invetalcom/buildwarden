import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@easycode/shared";
import { Clock3, GitBranch, Loader2, Milestone } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  getProjectInsight,
  parseProjectInsightData,
  type NarrativeBranchingInsightData,
  type RepoHistorianInsightData,
} from "./project-insight-utils";

interface ProjectHistoryTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
  onSelectRun: (runId: string) => void;
}

const formatGeneratedAt = (value: string | undefined) => (value ? new Date(value).toLocaleString() : "Not generated yet");

export const ProjectHistoryTab = ({
  project,
  modelOptions,
  defaultModelId,
  onGenerateInsight,
  onSelectRun,
}: ProjectHistoryTabProps) => {
  const firstModelId = modelOptions[0]?.id ?? "";
  const [historianModelId, setHistorianModelId] = useState(defaultModelId || firstModelId);
  const [busyKind, setBusyKind] = useState<ProjectInsightKind | null>(null);

  useEffect(() => {
    const fallback = defaultModelId || firstModelId;
    setHistorianModelId((current) => (modelOptions.some((option) => option.id === current) ? current : fallback));
  }, [defaultModelId, firstModelId, modelOptions]);

  const historianRecord = getProjectInsight(project, "repo-historian");
  const historian = parseProjectInsightData<RepoHistorianInsightData>(historianRecord);
  const narrativeRecord = getProjectInsight(project, "narrative-branching");
  const narrative = parseProjectInsightData<NarrativeBranchingInsightData>(narrativeRecord);

  const handleRefresh = async (kind: ProjectInsightKind, modelId?: string) => {
    setBusyKind(kind);
    try {
      await onGenerateInsight(kind, modelId);
    } finally {
      setBusyKind((current) => (current === kind ? null : current));
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Repo historian</h3>
              <p className="text-xs text-zinc-500">{historianRecord?.summary ?? "Use recent history and structural signals to explain how the repo got here."}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={historianModelId}
              onChange={(event) => setHistorianModelId(event.target.value)}
              className="min-w-[14rem] rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1.5 text-[11px] text-zinc-200 outline-none transition focus:border-cyan-500/50"
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh("repo-historian", historianModelId)} disabled={busyKind !== null}>
              {busyKind === "repo-historian" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
            </Button>
          </div>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Updated {formatGeneratedAt(historianRecord?.generatedAt)}</p>
        {historian ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="space-y-3">
              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                <p className="text-sm leading-relaxed text-zinc-200">{historian.synopsis}</p>
              </div>
              <div className="space-y-2">
                {historian.sections.map((section) => (
                  <div key={section.title} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                    <p className="text-sm font-medium text-zinc-100">{section.title}</p>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-300">{section.detail}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
              <p className="text-sm font-medium text-zinc-100">Notable commits</p>
              <div className="mt-3 space-y-2">
                {historian.notableCommits.map((commit) => (
                  <div key={commit.sha} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2">
                    <p className="text-sm text-zinc-100">{commit.title}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {commit.sha.slice(0, 7)} • {commit.author} • {commit.date}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
            Generate the repo historian to summarize architectural turning points and recurring change themes.
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Narrative branching</h3>
              <p className="text-xs text-zinc-500">{narrativeRecord?.summary ?? "Group project runs into implementation arcs by branch."}</p>
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh("narrative-branching")} disabled={busyKind !== null}>
            {busyKind === "narrative-branching" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Updated {formatGeneratedAt(narrativeRecord?.generatedAt)}</p>
        {narrative ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="space-y-2">
              {narrative.branches.map((branch) => (
                <div key={branch.branchName} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Milestone className="h-3.5 w-3.5 text-cyan-400" />
                    <p className="text-sm font-medium text-zinc-100">{branch.branchName}</p>
                    <span className="text-xs text-zinc-500">{branch.runCount} runs</span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-300">{branch.summary}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {branch.statuses.map((status) => (
                      <span key={status} className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-300">
                        {status}
                      </span>
                    ))}
                  </div>
                  {branch.latestRunId ? (
                    <div className="mt-3">
                      <Button type="button" size="sm" variant="ghost" onClick={() => onSelectRun(branch.latestRunId!)}>
                        Open latest run
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
              <p className="text-sm font-medium text-zinc-100">Timeline</p>
              <div className="app-scrollbar mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1">
                {narrative.timeline.map((entry) => (
                  <button
                    key={entry.runId}
                    type="button"
                    className="block w-full rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left transition hover:border-zinc-700 hover:bg-zinc-900"
                    onClick={() => onSelectRun(entry.runId)}
                  >
                    <p className="text-sm text-zinc-100">{entry.title}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {entry.branchName} • {entry.status} • {new Date(entry.createdAt).toLocaleString()}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
            Generate narrative branching to turn prior project runs into an explorable branch-by-branch timeline.
          </div>
        )}
      </Card>
    </div>
  );
};
