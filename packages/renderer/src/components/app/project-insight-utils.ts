import type {
  ArchitectureGraphInsightData,
  CodebaseMoodInsightData,
  CuriosityModeInsightData,
  DependencyGravityInsightData,
  NarrativeBranchingInsightData,
  ProjectInsightData,
  ProjectInsightKind,
  ProjectInsightRecord,
  ProjectSnapshot,
  RepoHistorianInsightData,
} from "@buildwarden/shared";
import { reportRendererError } from "../../lib/report-renderer-error";

export const getProjectInsight = (project: ProjectSnapshot, kind: ProjectInsightKind): ProjectInsightRecord | null =>
  project.insights.find((insight) => insight.kind === kind) ?? null;

export const parseProjectInsightData = <T extends ProjectInsightData>(record: ProjectInsightRecord | null): T | null => {
  if (!record) {
    return null;
  }
  try {
    return JSON.parse(record.dataJson) as T;
  } catch {
    reportRendererError("renderer.project-insight.parse-json", new Error("Failed to parse project insight JSON payload."), {
      insightId: record.id,
      kind: record.kind,
      generatedAt: record.generatedAt,
      dataLength: record.dataJson.length,
    });
    return null;
  }
};

export const formatGeneratedAt = (value: string | undefined) => (value ? new Date(value).toLocaleString() : "Not generated yet");

export type {
  ArchitectureGraphInsightData,
  CodebaseMoodInsightData,
  CuriosityModeInsightData,
  DependencyGravityInsightData,
  NarrativeBranchingInsightData,
  RepoHistorianInsightData,
};
