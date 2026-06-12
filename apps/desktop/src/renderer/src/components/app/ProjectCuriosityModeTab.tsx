import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";
import {
  formatGeneratedAt,
  getProjectInsight,
  parseProjectInsightData,
  type CuriosityModeInsightData,
} from "./project-insight-utils";

interface ProjectCuriosityModeTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

export const ProjectCuriosityModeTab = ({ project, modelOptions, defaultModelId, onGenerateInsight }: ProjectCuriosityModeTabProps) => {
  const firstModelId = modelOptions[0]?.id ?? "";
  const [modelId, setModelId] = useState(defaultModelId || firstModelId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fallback = defaultModelId || firstModelId;
    setModelId((current) => (modelOptions.some((option) => option.id === current) ? current : fallback));
  }, [defaultModelId, firstModelId, modelOptions]);

  const record = getProjectInsight(project, "curiosity-mode");
  const curiosity = parseProjectInsightData<CuriosityModeInsightData>(record);

  const handleRefresh = async () => {
    if (!modelId) {
      window.alert("Add a model in Settings first.");
      return;
    }
    setBusy(true);
    try {
      await onGenerateInsight("curiosity-mode", modelId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-cyan-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-zinc-100">Curiosity mode</h3>
            <p className="text-xs text-zinc-500">{record?.summary ?? "Surface interesting, confusing, or high-leverage pockets worth exploring."}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </div>
      <p className="mb-3 text-xs text-zinc-500">Updated {formatGeneratedAt(record?.generatedAt)}</p>

      {curiosity ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-2">
            {curiosity.themes.map((theme) => (
              <div key={theme.title} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                <p className="text-sm font-medium text-zinc-100">{theme.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{theme.whyItMatters}</p>
                {theme.evidence.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {theme.evidence.map((entry) => (
                      <span key={entry} className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-1 text-[11px] text-zinc-300">
                        {entry}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
            <p className="text-sm font-medium text-zinc-100">Suggested follow-up prompts</p>
            <div className="mt-3 space-y-2">
              {curiosity.suggestedPrompts.map((prompt) => (
                <div key={prompt} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300">
                  {prompt}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
          Generate curiosity mode to surface interesting and high-leverage areas for later exploration.
        </div>
      )}
    </Card>
  );
};
