import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Clock3, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";
import {
  formatGeneratedAt,
  getProjectInsight,
  parseProjectInsightData,
  type RepoHistorianInsightData,
} from "./project-insight-utils";

interface ProjectRepoHistorianTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

export const ProjectRepoHistorianTab = ({ project, modelOptions, defaultModelId, onGenerateInsight }: ProjectRepoHistorianTabProps) => {
  const canGenerateInsights = useBuildWardenClient().capabilities.platform === "electron";
  const firstModelId = modelOptions[0]?.id ?? "";
  const [modelId, setModelId] = useState(defaultModelId || firstModelId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fallback = defaultModelId || firstModelId;
    setModelId((current) => (modelOptions.some((option) => option.id === current) ? current : fallback));
  }, [defaultModelId, firstModelId, modelOptions]);

  const record = getProjectInsight(project, "repo-historian");
  const historian = parseProjectInsightData<RepoHistorianInsightData>(record);

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await onGenerateInsight("repo-historian", modelId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-cyan-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-zinc-100">Repo historian</h3>
            <p className="text-xs text-zinc-500">{record?.summary ?? "Use recent history and structural signals to explain how the repo got here."}</p>
          </div>
        </div>
        {canGenerateInsights ? <div className="flex flex-wrap items-center gap-2">
          <Select
            value={modelId}
            onValueChange={setModelId}
            options={modelOptions.map((option) => ({ value: option.id, label: option.label }))}
            className="min-w-[14rem]"
            triggerClassName="h-8 text-xs"
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh()} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </div> : null}
      </div>
      <p className="mb-3 text-xs text-zinc-500">Updated {formatGeneratedAt(record?.generatedAt)}</p>

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
                    {commit.sha.slice(0, 7)} - {commit.author} - {commit.date}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
          {canGenerateInsights ? "Generate the repo historian to summarize architectural turning points and recurring change themes." : "No saved repository history report is available on the host."}
        </div>
      )}
    </Card>
  );
};
