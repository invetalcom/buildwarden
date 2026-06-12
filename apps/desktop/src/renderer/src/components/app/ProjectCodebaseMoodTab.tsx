import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";
import {
  formatGeneratedAt,
  getProjectInsight,
  parseProjectInsightData,
  type CodebaseMoodInsightData,
} from "./project-insight-utils";

interface ProjectCodebaseMoodTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

export const ProjectCodebaseMoodTab = ({ project, modelOptions, defaultModelId, onGenerateInsight }: ProjectCodebaseMoodTabProps) => {
  const firstModelId = modelOptions[0]?.id ?? "";
  const [modelId, setModelId] = useState(defaultModelId || firstModelId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fallback = defaultModelId || firstModelId;
    setModelId((current) => (modelOptions.some((option) => option.id === current) ? current : fallback));
  }, [defaultModelId, firstModelId, modelOptions]);

  const record = getProjectInsight(project, "codebase-mood");
  const mood = parseProjectInsightData<CodebaseMoodInsightData>(record);

  const handleRefresh = async () => {
    if (!modelId) {
      window.alert("Add a model in Settings first.");
      return;
    }
    setBusy(true);
    try {
      await onGenerateInsight("codebase-mood", modelId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-400" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-zinc-100">Codebase mood</h3>
            <p className="text-xs text-zinc-500">{record?.summary ?? "Get a structured read on brittleness, inconsistency, and abstraction debt."}</p>
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

      {mood ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-200">
            <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-cyan-100">Score {mood.overallScore}</span>
            <span>{mood.posture}</span>
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            {mood.sections.map((section) => (
              <div key={section.label} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                <p className="text-sm font-medium text-zinc-100">{section.label}</p>
                <p className="mt-1 text-xs text-cyan-100">Score {section.score}</p>
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{section.summary}</p>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            {mood.findings.map((finding) => (
              <div key={`${finding.title}-${finding.filePath ?? ""}`} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
                <p className="text-sm font-medium text-zinc-100">{finding.title}</p>
                {finding.filePath ? <p className="mt-1 text-xs text-zinc-500">{finding.filePath}</p> : null}
                <p className="mt-2 text-sm leading-relaxed text-zinc-300">{finding.detail}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
          Generate a codebase mood report to see structural weak spots and likely maintenance pressure.
        </div>
      )}
    </Card>
  );
};
