import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@easycode/shared";
import { Bot, ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  getProjectInsight,
  parseProjectInsightData,
  type CodebaseMoodInsightData,
  type CuriosityModeInsightData,
} from "./project-insight-utils";

interface ProjectInsightsTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

const formatGeneratedAt = (value: string | undefined) => (value ? new Date(value).toLocaleString() : "Not generated yet");

export const ProjectInsightsTab = ({ project, modelOptions, defaultModelId, onGenerateInsight }: ProjectInsightsTabProps) => {
  const firstModelId = modelOptions[0]?.id ?? "";
  const initialModelId = defaultModelId || firstModelId;
  const [expandedByKind, setExpandedByKind] = useState<Record<"codebase-mood" | "curiosity-mode", boolean>>({
    "codebase-mood": true,
    "curiosity-mode": true,
  });
  const [modelByKind, setModelByKind] = useState<Record<string, string>>({
    "codebase-mood": initialModelId,
    "curiosity-mode": initialModelId,
  });
  const [busyKind, setBusyKind] = useState<ProjectInsightKind | null>(null);

  useEffect(() => {
    setModelByKind((current) => {
      const fallback = defaultModelId || firstModelId;
      return {
        "codebase-mood":
          modelOptions.some((option) => option.id === current["codebase-mood"]) ? current["codebase-mood"] : fallback,
        "curiosity-mode":
          modelOptions.some((option) => option.id === current["curiosity-mode"]) ? current["curiosity-mode"] : fallback,
      };
    });
  }, [defaultModelId, firstModelId, modelOptions]);

  const moodRecord = getProjectInsight(project, "codebase-mood");
  const mood = parseProjectInsightData<CodebaseMoodInsightData>(moodRecord);
  const curiosityRecord = getProjectInsight(project, "curiosity-mode");
  const curiosity = parseProjectInsightData<CuriosityModeInsightData>(curiosityRecord);

  const cards = useMemo(
    () => [
      {
        kind: "codebase-mood" as const,
        title: "Codebase mood",
        subtitle: moodRecord?.summary ?? "Get a structured read on brittleness, inconsistency, and abstraction debt.",
        icon: <Bot className="h-4 w-4 text-cyan-400" />,
      },
      {
        kind: "curiosity-mode" as const,
        title: "Curiosity mode",
        subtitle: curiosityRecord?.summary ?? "Surface interesting, confusing, or high-leverage pockets worth exploring.",
        icon: <Sparkles className="h-4 w-4 text-cyan-400" />,
      },
    ],
    [curiosityRecord?.summary, moodRecord?.summary],
  );

  const handleRefresh = async (kind: ProjectInsightKind) => {
    const modelId = modelByKind[kind] ?? initialModelId;
    if (!modelId) {
      window.alert("Add a model in Settings first.");
      return;
    }
    setBusyKind(kind);
    try {
      await onGenerateInsight(kind, modelId);
    } finally {
      setBusyKind((current) => (current === kind ? null : current));
    }
  };

  return (
    <div className="space-y-4">
      {cards.map((card) => {
        const modelId = modelByKind[card.kind] ?? initialModelId;
        const record = card.kind === "codebase-mood" ? moodRecord : curiosityRecord;
        const expanded = expandedByKind[card.kind];
        return (
          <Card key={card.kind} className="p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <button
                type="button"
                onClick={() =>
                  setExpandedByKind((current) => ({
                    ...current,
                    [card.kind]: !current[card.kind],
                  }))
                }
                className="flex items-center gap-2 rounded-md text-left transition hover:text-zinc-100"
                aria-expanded={expanded}
                aria-label={expanded ? `Collapse ${card.title}` : `Expand ${card.title}`}
                title={expanded ? "Collapse" : "Expand"}
              >
                {expanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
                {card.icon}
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-zinc-100">{card.title}</h3>
                  <p className="text-xs text-zinc-500">{card.subtitle}</p>
                </div>
              </button>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={modelId}
                  onChange={(event) =>
                    setModelByKind((current) => ({
                      ...current,
                      [card.kind]: event.target.value,
                    }))
                  }
                  className="min-w-[14rem] rounded-lg border border-zinc-800 bg-zinc-900/80 px-2 py-1.5 text-[11px] text-zinc-200 outline-none transition focus:border-cyan-500/50"
                >
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh(card.kind)} disabled={busyKind !== null}>
                  {busyKind === card.kind ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
                </Button>
              </div>
            </div>
            <p className="mb-3 text-xs text-zinc-500">Updated {formatGeneratedAt(record?.generatedAt)}</p>

            {expanded && card.kind === "codebase-mood" ? (
              mood ? (
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
              )
            ) : null}

            {expanded && card.kind === "curiosity-mode" ? (
              curiosity ? (
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
              )
            ) : null}
          </Card>
        );
      })}
    </div>
  );
};
