import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { Bot, Clock3, GitBranch, Sparkles } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { ProjectCodebaseMoodTab } from "./ProjectCodebaseMoodTab";
import { ProjectCuriosityModeTab } from "./ProjectCuriosityModeTab";
import { ProjectNarrativeBranchingTab } from "./ProjectNarrativeBranchingTab";
import { ProjectRepoHistorianTab } from "./ProjectRepoHistorianTab";

type AiInsightsHistorySubpage = "codebase-mood" | "curiosity-mode" | "repo-historian" | "narrative-branching";

interface ProjectAiInsightsHistoryPageProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
  onSelectRun: (runId: string) => void;
}

const subpages: Array<{ id: AiInsightsHistorySubpage; label: string; icon: typeof Sparkles }> = [
  { id: "codebase-mood", label: "Codebase mood", icon: Bot },
  { id: "curiosity-mode", label: "Curiosity mode", icon: Sparkles },
  { id: "repo-historian", label: "Repo historian", icon: Clock3 },
  { id: "narrative-branching", label: "Narrative branching", icon: GitBranch },
];

export const ProjectAiInsightsHistoryPage = ({
  project,
  modelOptions,
  defaultModelId,
  onGenerateInsight,
  onSelectRun,
}: ProjectAiInsightsHistoryPageProps) => {
  const [activeSubpage, setActiveSubpage] = useState<AiInsightsHistorySubpage>("codebase-mood");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-1">
        {subpages.map((subpage) => {
          const Icon = subpage.icon;
          const active = activeSubpage === subpage.id;
          return (
            <button
              key={subpage.id}
              type="button"
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition",
                active
                  ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                  : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
              )}
              onClick={() => setActiveSubpage(subpage.id)}
              aria-pressed={active}
            >
              <Icon className={cn("size-3.5", active ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]")} />
              <span>{subpage.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">
        {activeSubpage === "codebase-mood" ? (
          <ProjectCodebaseMoodTab
            project={project}
            modelOptions={modelOptions}
            defaultModelId={defaultModelId}
            onGenerateInsight={onGenerateInsight}
          />
        ) : null}

        {activeSubpage === "curiosity-mode" ? (
          <ProjectCuriosityModeTab
            project={project}
            modelOptions={modelOptions}
            defaultModelId={defaultModelId}
            onGenerateInsight={onGenerateInsight}
          />
        ) : null}

        {activeSubpage === "repo-historian" ? (
          <ProjectRepoHistorianTab
            project={project}
            modelOptions={modelOptions}
            defaultModelId={defaultModelId}
            onGenerateInsight={onGenerateInsight}
          />
        ) : null}

        {activeSubpage === "narrative-branching" ? (
          <ProjectNarrativeBranchingTab project={project} onGenerateInsight={onGenerateInsight} onSelectRun={onSelectRun} />
        ) : null}
      </div>
    </div>
  );
};
