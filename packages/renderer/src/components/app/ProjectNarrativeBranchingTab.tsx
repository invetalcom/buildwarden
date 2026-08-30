import type { ProjectInsightKind, ProjectSnapshot } from "@buildwarden/shared";
import { GitBranch, Loader2, Milestone } from "lucide-react";
import { useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  formatGeneratedAt,
  getProjectInsight,
  parseProjectInsightData,
  type NarrativeBranchingInsightData,
} from "./project-insight-utils";

interface ProjectNarrativeBranchingTabProps {
  project: ProjectSnapshot;
  onGenerateInsight: (kind: ProjectInsightKind, modelId?: string) => Promise<void>;
  onSelectRun: (runId: string) => void;
}

export const ProjectNarrativeBranchingTab = ({ project, onGenerateInsight, onSelectRun }: ProjectNarrativeBranchingTabProps) => {
  const canGenerateInsights = useBuildWardenClient().capabilities.insightMutations;
  const [busy, setBusy] = useState(false);
  const record = getProjectInsight(project, "narrative-branching");
  const narrative = parseProjectInsightData<NarrativeBranchingInsightData>(record);

  const handleRefresh = async () => {
    setBusy(true);
    try {
      await onGenerateInsight("narrative-branching");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-[var(--ec-accent)]" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-[var(--ec-text)]">Narrative branching</h3>
            <p className="text-xs text-[var(--ec-muted)]">{record?.summary ?? "Group project runs into implementation arcs by branch."}</p>
          </div>
        </div>
        {canGenerateInsights ? <Button type="button" size="sm" variant="secondary" onClick={() => void handleRefresh()} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
        </Button> : null}
      </div>
      <p className="mb-3 text-xs text-[var(--ec-muted)]">Updated {formatGeneratedAt(record?.generatedAt)}</p>

      {narrative ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="space-y-2">
            {narrative.branches.map((branch) => (
              <div key={branch.branchName} className="rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Milestone className="h-3.5 w-3.5 text-[var(--ec-accent)]" />
                  <p className="text-sm font-medium text-[var(--ec-text)]">{branch.branchName}</p>
                  <span className="text-xs text-[var(--ec-muted)]">{branch.runCount} runs</span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-[var(--ec-text)]">{branch.summary}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {branch.statuses.map((status) => (
                    <span key={status} className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-1 text-[11px] text-[var(--ec-text)]">
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
          <div className="rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] p-3">
            <p className="text-sm font-medium text-[var(--ec-text)]">Timeline</p>
            <div className="app-scrollbar mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {narrative.timeline.map((entry) => (
                <button
                  key={entry.runId}
                  type="button"
                  className="block w-full rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-left transition hover:border-[var(--ec-border)] hover:bg-[var(--ec-hover)]"
                  onClick={() => onSelectRun(entry.runId)}
                >
                  <p className="text-sm text-[var(--ec-text)]">{entry.title}</p>
                  <p className="mt-1 text-xs text-[var(--ec-muted)]">
                    {entry.branchName} - {entry.status} - {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--ec-border)] bg-[var(--ec-panel)] px-4 py-10 text-center text-sm text-[var(--ec-muted)]">
          {canGenerateInsights ? "Generate narrative branching to turn prior project runs into an explorable branch-by-branch timeline." : "No saved narrative branching report is available on the host."}
        </div>
      )}
    </Card>
  );
};
