import type { ProjectInsightKind, ProjectSnapshot, ProviderType, UnifiedProviderFamily } from "@buildwarden/shared";
import { ProjectNarrativeBranchingTab } from "./ProjectNarrativeBranchingTab";
import { ProjectRepoHistorianTab } from "./ProjectRepoHistorianTab";

interface ProjectHistoryTabProps {
  project: ProjectSnapshot;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
  onSelectRun: (runId: string) => void;
}

export const ProjectHistoryTab = ({
  project,
  modelOptions,
  defaultModelId,
  onGenerateInsight,
  onSelectRun,
}: ProjectHistoryTabProps) => (
  <div className="space-y-4">
    <ProjectRepoHistorianTab
      project={project}
      modelOptions={modelOptions}
      defaultModelId={defaultModelId}
      onGenerateInsight={onGenerateInsight}
    />
    <ProjectNarrativeBranchingTab project={project} onGenerateInsight={onGenerateInsight} onSelectRun={onSelectRun} />
  </div>
);
