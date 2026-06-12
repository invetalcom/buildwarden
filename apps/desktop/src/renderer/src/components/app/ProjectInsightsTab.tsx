import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { ProjectCodebaseMoodTab } from "./ProjectCodebaseMoodTab";
import { ProjectCuriosityModeTab } from "./ProjectCuriosityModeTab";

interface ProjectInsightsTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

export const ProjectInsightsTab = ({ project, modelOptions, defaultModelId, onGenerateInsight }: ProjectInsightsTabProps) => (
  <div className="space-y-4">
    <ProjectCodebaseMoodTab
      project={project}
      modelOptions={modelOptions}
      defaultModelId={defaultModelId}
      onGenerateInsight={onGenerateInsight}
    />
    <ProjectCuriosityModeTab
      project={project}
      modelOptions={modelOptions}
      defaultModelId={defaultModelId}
      onGenerateInsight={onGenerateInsight}
    />
  </div>
);
