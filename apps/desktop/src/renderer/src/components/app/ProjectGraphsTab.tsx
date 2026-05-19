import type { ProjectInsightKind, ProjectSnapshot } from "@easycode/shared";
import { GitGraph, Loader2, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { reportRendererError, reportRendererLog, reportRendererWarning } from "../../lib/report-renderer-error";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ProjectInsightMermaid } from "./ProjectInsightMermaid";
import {
  getProjectInsight,
  parseProjectInsightData,
  type ArchitectureGraphInsightData,
  type DependencyGravityInsightData,
} from "./project-insight-utils";

interface ProjectGraphsTabProps {
  project: ProjectSnapshot;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
}

const formatGeneratedAt = (value: string | undefined) => (value ? new Date(value).toLocaleString() : "Not generated yet");

export const ProjectGraphsTab = ({ project, onGenerateInsight }: ProjectGraphsTabProps) => {
  const [busyKind, setBusyKind] = useState<ProjectInsightKind | null>(null);
  const architectureRecord = getProjectInsight(project, "architecture-graph");
  const architecture = parseProjectInsightData<ArchitectureGraphInsightData>(architectureRecord);
  const gravityRecord = getProjectInsight(project, "dependency-gravity");
  const gravity = parseProjectInsightData<DependencyGravityInsightData>(gravityRecord);

  const handleRefresh = async (kind: ProjectInsightKind) => {
    setBusyKind(kind);
    try {
      reportRendererLog({
        level: "warn",
        source: "renderer.project-graphs.refresh.start",
        message: "Refreshing project graph insight.",
        metadata: {
          projectId: project.project.id,
          kind,
        },
      });
      await onGenerateInsight(kind);
      reportRendererLog({
        level: "warn",
        source: "renderer.project-graphs.refresh.success",
        message: "Project graph insight refresh completed.",
        metadata: {
          projectId: project.project.id,
          kind,
        },
      });
    } catch (error) {
      reportRendererError("renderer.project-graphs.refresh.failure", error, {
        projectId: project.project.id,
        kind,
      });
      throw error;
    } finally {
      setBusyKind((current) => (current === kind ? null : current));
    }
  };

  useEffect(() => {
    if (!architectureRecord) {
      reportRendererWarning("renderer.project-graphs.architecture.missing-record", "Architecture graph has not been generated yet.", {
        projectId: project.project.id,
      });
      return;
    }
    if (!architecture) {
      reportRendererError("renderer.project-graphs.architecture.parse", new Error("Could not parse architecture graph insight data."), {
        projectId: project.project.id,
        generatedAt: architectureRecord.generatedAt,
      });
    }
  }, [architecture, architectureRecord, project.project.id]);

  useEffect(() => {
    if (gravityRecord && !gravity) {
      reportRendererError("renderer.project-graphs.gravity.parse", new Error("Could not parse dependency gravity insight data."), {
        projectId: project.project.id,
        generatedAt: gravityRecord.generatedAt,
      });
    }
  }, [gravity, gravityRecord, project.project.id]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitGraph className="h-4 w-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Architecture graph</h3>
              <p className="text-xs text-zinc-500">{architectureRecord?.summary ?? "Map module structure, hotspots, and likely ownership."}</p>
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh("architecture-graph")} disabled={busyKind !== null}>
            {busyKind === "architecture-graph" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Updated {formatGeneratedAt(architectureRecord?.generatedAt)}</span>
          {architecture ? <span>{architecture.nodes.length} nodes</span> : null}
          {architecture ? <span>{architecture.edges.length} edges</span> : null}
        </div>
        <ProjectInsightMermaid chart={architecture?.mermaid ?? ""} emptyLabel="Generate the architecture graph to visualize repo structure." />
        {architecture?.hotspots?.length ? (
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {architecture.hotspots.map((hotspot) => (
              <div key={hotspot.path} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 px-3 py-2">
                <p className="text-sm font-medium text-zinc-100">{hotspot.label}</p>
                <p className="mt-1 text-xs text-zinc-500">{hotspot.path}</p>
                <p className="mt-2 text-xs text-zinc-300">
                  {hotspot.commitCount} recent commits
                  {hotspot.ownerLabel ? ` • ${hotspot.ownerLabel}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-cyan-400" />
            <div>
              <h3 className="text-sm font-medium text-zinc-100">Dependency gravity map</h3>
              <p className="text-xs text-zinc-500">{gravityRecord?.summary ?? "Find the files quietly carrying the most structural weight."}</p>
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh("dependency-gravity")} disabled={busyKind !== null}>
            {busyKind === "dependency-gravity" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>Updated {formatGeneratedAt(gravityRecord?.generatedAt)}</span>
          {gravity ? <span>{gravity.summaryStats.totalModules} modules</span> : null}
          {gravity ? <span>{gravity.summaryStats.totalEdges} edges</span> : null}
        </div>
        <ProjectInsightMermaid chart={gravity?.mermaid ?? ""} emptyLabel="Generate the gravity map to see central dependency hubs." />
        {gravity?.nodes?.length ? (
          <div className="mt-3 space-y-2">
            {gravity.nodes.slice(0, 6).map((node) => (
              <div key={node.path} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/50 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-100">{node.path}</p>
                  <p className="text-xs text-zinc-500">{node.group}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-zinc-300">
                  <span>Gravity {node.gravityScore}</span>
                  <span>In {node.inbound}</span>
                  <span>Out {node.outbound}</span>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
};
