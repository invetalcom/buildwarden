import { useEffect, useState } from "react";
import {
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  isDetachedHeadProjectErrorMessage,
  type AppWarning,
  type ProjectForgeRequestNotificationPayload,
  type RunRecord,
  type ShellApprovalDecision,
} from "@buildwarden/shared";
import { AlertTriangle, ChevronRight, GitPullRequest, Loader2, ShieldCheck, SquareTerminal, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";

export interface ShellApprovalRequestState {
  runId: string;
  requestId: string;
  command: string;
  requestedAt: number;
}

export type ProjectForgeRequestToast = ProjectForgeRequestNotificationPayload & {
  id: string;
};

type ShellApprovalTarget = {
  run: Pick<RunRecord, "prompt">;
} | null;

interface AppNotificationsProps {
  busy: boolean;
  pendingDeleteRunCount: number;
  visibleShellApprovals: ShellApprovalRequestState[];
  shellApprovalQueueLength: number;
  queuedShellApprovalCount: number;
  visibleShellApprovalStartedAtById: Partial<Record<string, number>>;
  getShellApprovalTarget: (request: ShellApprovalRequestState) => ShellApprovalTarget;
  onOpenShellApprovalRun: (request: ShellApprovalRequestState) => void;
  onRespondToShellApproval: (request: ShellApprovalRequestState, decision: ShellApprovalDecision) => void;
  error: string | null;
  selectedProjectName: string | null;
  detachedCheckoutBranch: string;
  availableRunBranches: string[];
  projectCheckoutBusy: boolean;
  onDetachedCheckoutBranchChange: (branch: string) => void;
  onSubmitCheckoutDetachedProjectBranch: () => void;
  onDismissError: () => void;
  appWarning: AppWarning | null;
  onDismissAppWarning: () => void;
  projectForgeRequestToasts: ProjectForgeRequestToast[];
  onOpenProjectForgeRequest: (toast: ProjectForgeRequestToast) => void;
  onDismissProjectForgeRequestToast: (id: string) => void;
}

export const AppNotifications = ({
  busy,
  pendingDeleteRunCount,
  visibleShellApprovals,
  shellApprovalQueueLength,
  queuedShellApprovalCount,
  visibleShellApprovalStartedAtById,
  getShellApprovalTarget,
  onOpenShellApprovalRun,
  onRespondToShellApproval,
  error,
  selectedProjectName,
  detachedCheckoutBranch,
  availableRunBranches,
  projectCheckoutBusy,
  onDetachedCheckoutBranchChange,
  onSubmitCheckoutDetachedProjectBranch,
  onDismissError,
  appWarning,
  onDismissAppWarning,
  projectForgeRequestToasts,
  onOpenProjectForgeRequest,
  onDismissProjectForgeRequestToast,
}: AppNotificationsProps) => {
  // 1Hz countdown ticker scoped here so it does not re-render the whole app;
  // it only runs while shell-approval toasts are actually visible.
  const [shellApprovalNow, setShellApprovalNow] = useState(() => Date.now());
  const approvalsVisible = visibleShellApprovals.length > 0;
  useEffect(() => {
    if (!approvalsVisible) {
      return;
    }
    setShellApprovalNow(Date.now());
    const intervalId = window.setInterval(() => setShellApprovalNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [approvalsVisible]);

  return (
  <>
    {pendingDeleteRunCount > 0 ? (
      <div
        className="fixed bottom-6 left-1/2 z-[65] flex max-w-[min(90vw,24rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-500/35 bg-zinc-950/95 px-4 py-2 text-sm text-cyan-100 shadow-lg backdrop-blur"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" aria-hidden />
        <span>{pendingDeleteRunCount === 1 ? "Deleting run..." : `Deleting ${pendingDeleteRunCount} runs...`}</span>
      </div>
    ) : null}

    {visibleShellApprovals.length > 0 ? (
      <div
        className="fixed bottom-4 right-4 z-[20040] flex w-[calc(100vw-2rem)] max-w-xl flex-col gap-2"
        role="region"
        aria-live="assertive"
        aria-label="Shell command approvals"
      >
        {visibleShellApprovals.map((request, index) => {
          const target = getShellApprovalTarget(request);
          const visibleStartedAt = visibleShellApprovalStartedAtById[request.requestId] ?? shellApprovalNow;
          const secondsRemaining = Math.max(0, Math.ceil((visibleStartedAt + 30_000 - shellApprovalNow) / 1000));

          return (
            <Card
              key={request.requestId}
              className="border-amber-500/35 bg-zinc-950/96 p-3 shadow-2xl shadow-amber-950/25 backdrop-blur"
            >
              <div className="flex flex-col gap-2.5">
                <div className="flex items-start gap-2.5">
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-1.5 text-amber-300">
                    <SquareTerminal className="h-3.5 w-3.5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/90">
                        Shell approval needed
                      </p>
                      <span className="shrink-0 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-100">
                        {secondsRemaining}s left
                      </span>
                      {visibleShellApprovals.length > 1 ? (
                        <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
                          {index + 1}/{shellApprovalQueueLength}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm font-medium text-zinc-100" title={target?.run.prompt ?? undefined}>
                      {target?.run.prompt ?? "Agent run is waiting for a command decision"}
                    </p>
                  </div>
                </div>

                <pre className="app-scrollbar max-h-20 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/90 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-200">
                  {request.command}
                </pre>

                <div className="flex flex-col gap-2">
                  <p className="text-[11px] leading-snug text-zinc-500">
                    Outside the safe allowlist. Auto-denies if no decision is made.
                  </p>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 gap-1.5 border-cyan-500/25 bg-cyan-500/10 px-2.5 text-xs text-cyan-100 hover:bg-cyan-500/15"
                      onClick={() => onOpenShellApprovalRun(request)}
                      disabled={busy}
                    >
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      Go to run
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => onRespondToShellApproval(request, "deny")}
                      disabled={busy}
                    >
                      Deny
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => onRespondToShellApproval(request, "allow-once")}
                      disabled={busy}
                    >
                      Allow once
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      onClick={() => onRespondToShellApproval(request, "allow-for-run")}
                      disabled={busy}
                      title="Remember this exact command until the run ends"
                    >
                      For this run
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 gap-1.5 px-2.5 text-xs"
                      onClick={() => onRespondToShellApproval(request, "allow-always")}
                      disabled={busy}
                      title="Adds an exact-match regex for this command to Settings"
                    >
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      Always allow
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
        {queuedShellApprovalCount > 0 ? (
          <div className="self-end rounded-full border border-amber-500/25 bg-zinc-950/95 px-3 py-1 text-[11px] font-medium text-amber-100 shadow-lg backdrop-blur">
            {queuedShellApprovalCount} more approval{queuedShellApprovalCount === 1 ? "" : "s"} queued
          </div>
        ) : null}
      </div>
    ) : null}

    {error ? (
      <div className="fixed right-4 top-14 z-[20050] w-[calc(100vw-2rem)] max-w-md">
        <Card className="border-rose-500/40 bg-zinc-950/95 p-4 shadow-2xl shadow-rose-950/30 backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.25em] text-rose-300/80">Error</p>
              {isDetachedHeadProjectErrorMessage(error) && selectedProjectName ? (
                <p className="mt-1.5 truncate text-sm font-medium text-zinc-100" title={selectedProjectName}>
                  Project: {selectedProjectName}
                </p>
              ) : null}
              <p className="mt-2 text-sm text-rose-100">
                {isDetachedHeadProjectErrorMessage(error) ? GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE : error}
              </p>
              {isDetachedHeadProjectErrorMessage(error) ? (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                  <label className="sr-only" htmlFor="error-detached-branch">
                    Branch to check out
                  </label>
                  <Select
                    id="error-detached-branch"
                    className="min-w-0 flex-1"
                    triggerClassName="min-h-10 border-rose-500/25 bg-rose-950/20 text-rose-50 hover:border-rose-400/50"
                    menuClassName="border-rose-500/25 ring-rose-500/30"
                    value={detachedCheckoutBranch}
                    onValueChange={onDetachedCheckoutBranchChange}
                    disabled={projectCheckoutBusy || availableRunBranches.length === 0}
                    options={availableRunBranches.map((name) => ({ value: name, label: name }))}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0 border-rose-500/30 bg-rose-950/50 text-rose-100 hover:bg-rose-950/80"
                    disabled={projectCheckoutBusy || !detachedCheckoutBranch.trim()}
                    onClick={onSubmitCheckoutDetachedProjectBranch}
                  >
                    {projectCheckoutBusy ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                        Checking out...
                      </>
                    ) : (
                      "Check out branch"
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              onClick={onDismissError}
              aria-label="Dismiss error notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      </div>
    ) : null}

    {appWarning ? (
      <div className="fixed right-4 top-14 z-[20040] w-[calc(100vw-2rem)] max-w-md">
        <Card className="border-amber-500/40 bg-zinc-950/95 p-4 shadow-2xl shadow-amber-950/30 backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.25em] text-amber-300/80">Warning</p>
              <p className="mt-1.5 text-sm font-medium text-zinc-100">{appWarning.title}</p>
              <p className="mt-2 text-sm text-amber-100">{appWarning.message}</p>
              {appWarning.detail ? (
                <pre className="app-scrollbar mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-500/20 bg-zinc-900/80 p-2 text-xs text-amber-50/90">
                  {appWarning.detail}
                </pre>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              onClick={onDismissAppWarning}
              aria-label="Dismiss warning notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      </div>
    ) : null}

    {projectForgeRequestToasts.length > 0 ? (
      <div
        className={cn(
          "fixed right-4 z-[20039] flex w-[calc(100vw-2rem)] max-w-md flex-col gap-2",
          appWarning ? "top-64" : "top-14",
        )}
        role="region"
        aria-live="polite"
        aria-label="Pull request notifications"
      >
        {projectForgeRequestToasts.map((toast) => (
          <Card key={toast.id} className="border-cyan-500/35 bg-zinc-950/95 p-3 shadow-2xl shadow-cyan-950/20 backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-cyan-500/30 bg-cyan-500/10 p-2 text-cyan-300">
                <GitPullRequest className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-300/80">
                  New {toast.providerLabel}
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-zinc-100" title={toast.title}>
                  {toast.title}
                </p>
                <p className="mt-1 truncate text-xs text-zinc-400">
                  {toast.projectName}
                  {toast.author ? ` by ${toast.author}` : ""} - <span className="font-mono">{toast.repoLabel}</span>
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" size="xs" onClick={() => onOpenProjectForgeRequest(toast)}>
                    Open project and {toast.providerLabel}
                  </Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => onDismissProjectForgeRequestToast(toast.id)}>
                    Dismiss
                  </Button>
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => onDismissProjectForgeRequestToast(toast.id)}
                aria-label="Dismiss pull request notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
      </div>
    ) : null}
  </>
  );
};
