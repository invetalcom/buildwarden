import type { RunForgeCheck, RunForgeCheckProgress, RunForgeReadiness } from "@buildwarden/shared";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { runForgeReadinessHex } from "./run-forge-ui";

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds == null) return null;
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
};

const checkStatusLabel = (status: RunForgeCheck["status"]) => ({
  queued: "Queued",
  running: "Running",
  success: "Passed",
  failure: "Failed",
  cancelled: "Cancelled",
  neutral: "Neutral",
  skipped: "Skipped",
})[status];

export const ForgeChecksView = ({
  progress,
  checks,
  readiness,
  className,
  onOpenExternal,
}: {
  progress: RunForgeCheckProgress;
  checks: RunForgeCheck[];
  readiness: RunForgeReadiness;
  className?: string;
  onOpenExternal: (url: string) => unknown | Promise<unknown>;
}) => {
  const ratio = progress.total > 0 ? progress.completed / progress.total : readiness === "ready" ? 1 : 0;
  const ringDegrees = Math.max(0, Math.min(1, ratio)) * 360;
  const allReportedChecksPassed = progress.total > 0
    && progress.completed >= progress.total
    && progress.successful >= progress.total
    && progress.failed === 0
    && progress.running === 0;
  const progressColor = allReportedChecksPassed
    ? runForgeReadinessHex.ready
    : runForgeReadinessHex[readiness];

  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex items-center gap-3 border-b border-zinc-800/70 px-3 py-3">
        <div
          className="relative h-10 w-10 shrink-0 rounded-full"
          style={{ background: `conic-gradient(${progressColor} ${String(ringDegrees)}deg, #27272a 0deg)` }}
          role="progressbar"
          aria-label={`${String(progress.completed)} of ${String(progress.total)} checks complete`}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.completed}
        >
          <div className="absolute inset-[3px] grid place-items-center rounded-full bg-[var(--ec-panel)] text-[10px] font-semibold">
            {progress.completed}/{progress.total}
          </div>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">{progress.completed} of {progress.total} complete</p>
          <p className="truncate text-[11px] text-zinc-500">
            {progress.successful} passed · {progress.failed} failed · {progress.running} running
          </p>
        </div>
      </div>
      <div className="divide-y divide-zinc-800/70">
        {checks.map((check) => {
          const duration = formatDuration(check.durationMs);
          return (
            <div key={check.id} className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
              {check.status === "success" || check.status === "neutral" || check.status === "skipped"
                ? <Check className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
                : check.status === "running" || check.status === "queued"
                  ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" aria-hidden />
                  : <X className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-zinc-200" title={check.name}>{check.name}</p>
                <p className="truncate text-[10px] text-zinc-600" title={check.description ?? undefined}>
                  {checkStatusLabel(check.status)}{duration ? ` · ${duration}` : ""}{check.description ? ` · ${check.description}` : ""}
                </p>
              </div>
              {check.url ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0"
                  onClick={() => void onOpenExternal(check.url!)}
                  title={`Open ${check.name}`}
                  aria-label={`Open ${check.name}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          );
        })}
        {checks.length === 0 ? <p className="px-3 py-8 text-center text-xs text-zinc-600">No checks were reported.</p> : null}
      </div>
    </div>
  );
};
