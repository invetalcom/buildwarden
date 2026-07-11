import type { RunRecord } from "@buildwarden/shared";
import { Archive, ArchiveRestore } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

interface ProjectForLaterTabProps {
  runs: RunRecord[];
  onSelectRun: (runId: string) => void;
  onRestoreRunFromForLater: (runId: string) => void | Promise<void>;
}

const formatRunMeta = (run: RunRecord) => {
  let workspaceLabel = run.branchName;
  if (run.workspaceVcs === "folder") {
    workspaceLabel = run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  }
  return `${workspaceLabel} - ${new Date(run.createdAt).toLocaleString()}`;
};

export const ProjectForLaterTab = ({ runs, onSelectRun, onRestoreRunFromForLater }: ProjectForLaterTabProps) => (
  <Card className="p-4">
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-cyan-400" />
        <h3 className="text-sm font-medium text-zinc-200">For later</h3>
      </div>
      <span className="text-xs text-zinc-500">{runs.length} hidden from sidebar</span>
    </div>
    <div className="app-scrollbar max-h-[520px] space-y-3 overflow-y-auto pr-1">
      {runs.length > 0 ? (
        runs.map((run) => (
          <div key={run.id} className="rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <button type="button" className="min-w-0 text-left" onClick={() => onSelectRun(run.id)}>
                  <p className="truncate text-sm font-medium text-zinc-100">{run.prompt}</p>
                  <p className="mt-1 text-[11px] text-zinc-500">{formatRunMeta(run)}</p>
                </button>
              </div>
              <div className="flex items-center gap-2">
                <Badge dot tone={run.status}>{run.status}</Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-8 px-2 text-xs"
                  onClick={() => void onRestoreRunFromForLater(run.id)}
                >
                  <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                  Reactivate
                </Button>
              </div>
            </div>
          </div>
        ))
      ) : (
        <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/40 px-4 text-center text-sm text-zinc-500">
          No runs are currently tagged For later.
        </div>
      )}
    </div>
  </Card>
);
