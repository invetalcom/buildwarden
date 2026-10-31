import { useState } from "react";
import { GitPullRequest, GitPullRequestDraft } from "lucide-react";
import type { OpenExternalUrlResult, RunForgeRequestSummary } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { runForgeReadinessColor, runForgeReadinessLabel } from "./run-forge-ui";

export function RunForgeBadge({ request, onOpen }: {
  request: RunForgeRequestSummary | null | undefined;
  onOpen: (url: string) => Promise<OpenExternalUrlResult>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (request?.state !== "open") return null;
  const label = `${request.provider === "github" ? "PR" : "MR"} #${String(request.number)}`;
  const Icon = request.draft ? GitPullRequestDraft : GitPullRequest;
  const title = [
    `${label}: ${request.title}`,
    request.draft ? "Draft" : "Open",
    request.statusLastSyncedAt === null ? "Detailed status not checked" : runForgeReadinessLabel[request.readiness],
    request.statusLastSyncedAt === null ? null : `${String(request.checks.completed)}/${String(request.checks.total)} checks`,
    request.stale ? "Status may be outdated" : null,
    `Refreshed ${new Date(request.lastSyncedAt).toLocaleString()}`,
    error,
  ].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className={cn("mr-1 inline-flex shrink-0 rounded p-1 hover:bg-[var(--ec-control)] focus-visible:outline-2 focus-visible:outline-[var(--ec-accent)]", runForgeReadinessColor[request.readiness])}
      title={title}
      aria-label={`Open ${request.draft ? "draft " : ""}${label}: ${request.title}${request.stale ? " (status may be outdated)" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        setError(null);
        void onOpen(request.url).then((result) => {
          if (!result.ok) setError("Could not open the request. Try again.");
        }).catch(() => setError("Could not open the request. Try again."));
      }}
    >
      <Icon className="size-3" aria-hidden />
    </button>
  );
}
