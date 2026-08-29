import { useEffect, useState } from "react";
import {
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  isDetachedHeadProjectErrorMessage,
  type AutomationStartedNotificationPayload,
  type AppWarning,
  type ProjectForgeRequestNotificationPayload,
  type RunRecord,
  type ShellApprovalDecision,
} from "@buildwarden/shared";
import { AlertTriangle, CalendarClock, ChevronRight, GitPullRequest, Loader2, ShieldCheck, SquareTerminal, X } from "lucide-react";
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
  automationStartedToasts: AutomationStartedNotificationPayload[];
  onDismissAutomationStartedToast: (runId: string) => void;
  projectForgeRequestToasts: ProjectForgeRequestToast[];
  onOpenProjectForgeRequest: (toast: ProjectForgeRequestToast) => void;
  onDismissProjectForgeRequestToast: (id: string) => void;
}

type ShellApprovalNotificationsProps = Pick<AppNotificationsProps,
  | "busy"
  | "visibleShellApprovals"
  | "shellApprovalQueueLength"
  | "queuedShellApprovalCount"
  | "visibleShellApprovalStartedAtById"
  | "getShellApprovalTarget"
  | "onOpenShellApprovalRun"
  | "onRespondToShellApproval"
> & { now: number };

const ShellApprovalNotifications = ({ busy, visibleShellApprovals, shellApprovalQueueLength, queuedShellApprovalCount, visibleShellApprovalStartedAtById, getShellApprovalTarget, onOpenShellApprovalRun, onRespondToShellApproval, now }: ShellApprovalNotificationsProps) => {
  if (visibleShellApprovals.length === 0) {
    return null;
  }
  return (
    <div className="fixed bottom-4 right-4 z-[20040] flex w-[calc(100vw-2rem)] max-w-xl flex-col gap-2" role="region" aria-live="assertive" aria-label="Shell command approvals">
      {visibleShellApprovals.map((request, index) => {
        const target = getShellApprovalTarget(request);
        const visibleStartedAt = visibleShellApprovalStartedAtById[request.requestId] ?? now;
        const secondsRemaining = Math.max(0, Math.ceil((visibleStartedAt + 30_000 - now) / 1000));
        return (
          <Card key={request.requestId} className="border-[var(--ec-warning-ring)] bg-[var(--ec-panel)] p-3 shadow-2xl shadow-[var(--ec-warning-soft)] backdrop-blur">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-start gap-2.5">
                <div className="rounded-md border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] p-1.5 text-[var(--ec-warning)]"><SquareTerminal className="h-3.5 w-3.5" aria-hidden /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-warning)]">Shell approval needed</p>
                    <span className="shrink-0 rounded-full border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ec-warning)]">{secondsRemaining}s left</span>
                    {visibleShellApprovals.length > 1 && <span className="shrink-0 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1.5 py-0.5 text-[10px] text-[var(--ec-muted)]">{index + 1}/{shellApprovalQueueLength}</span>}
                  </div>
                  <p className="mt-0.5 truncate text-sm font-medium text-[var(--ec-text)]" title={target?.run.prompt ?? undefined}>{target?.run.prompt ?? "Agent run is waiting for a command decision"}</p>
                </div>
              </div>
              <pre className="app-scrollbar max-h-20 overflow-auto rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--ec-text)]">{request.command}</pre>
              <div className="flex flex-col gap-2">
                <p className="text-[11px] leading-snug text-[var(--ec-muted)]">Outside the safe allowlist. Auto-denies if no decision is made.</p>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button type="button" variant="secondary" size="sm" className="h-8 gap-1.5 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2.5 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-accent-soft)]" onClick={() => onOpenShellApprovalRun(request)} disabled={busy}><ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />Go to run</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={() => onRespondToShellApproval(request, "deny")} disabled={busy}>Deny</Button>
                  <Button type="button" variant="secondary" size="sm" className="h-8 px-2.5 text-xs" onClick={() => onRespondToShellApproval(request, "allow-once")} disabled={busy}>Allow once</Button>
                  <Button type="button" variant="secondary" size="sm" className="h-8 px-2.5 text-xs" onClick={() => onRespondToShellApproval(request, "allow-for-run")} disabled={busy} title="Remember this exact command until the run ends">For this run</Button>
                  <Button type="button" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => onRespondToShellApproval(request, "allow-always")} disabled={busy} title="Adds an exact-match regex for this command to Settings"><ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />Always allow</Button>
                </div>
              </div>
            </div>
          </Card>
        );
      })}
      {queuedShellApprovalCount > 0 && (
        <div className="self-end rounded-full border border-[var(--ec-warning-ring)] bg-[var(--ec-panel)] px-3 py-1 text-[11px] font-medium text-[var(--ec-warning)] shadow-lg backdrop-blur">
          {queuedShellApprovalCount} more approval{queuedShellApprovalCount === 1 ? "" : "s"} queued
        </div>
      )}
    </div>
  );
};

type ErrorNotificationProps = Pick<AppNotificationsProps,
  | "error"
  | "selectedProjectName"
  | "detachedCheckoutBranch"
  | "availableRunBranches"
  | "projectCheckoutBusy"
  | "onDetachedCheckoutBranchChange"
  | "onSubmitCheckoutDetachedProjectBranch"
  | "onDismissError"
>;

const ErrorNotification = ({ error, selectedProjectName, detachedCheckoutBranch, availableRunBranches, projectCheckoutBusy, onDetachedCheckoutBranchChange, onSubmitCheckoutDetachedProjectBranch, onDismissError }: ErrorNotificationProps) => {
  if (!error) {
    return null;
  }
  const detachedHead = isDetachedHeadProjectErrorMessage(error);
  return (
    <div className="fixed right-4 top-14 z-[20050] w-[calc(100vw-2rem)] max-w-md">
      <Card className="border-[var(--ec-danger-ring)] bg-[var(--ec-panel)] p-4 shadow-2xl shadow-[var(--ec-danger-soft)] backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] p-2 text-[var(--ec-danger)]"><AlertTriangle className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-danger)]">Error</p>
            {detachedHead && selectedProjectName && <p className="mt-1.5 truncate text-sm font-medium text-[var(--ec-text)]" title={selectedProjectName}>Project: {selectedProjectName}</p>}
            <p className="mt-2 text-sm text-[var(--ec-danger)]">{detachedHead ? GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE : error}</p>
            {detachedHead && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <label className="sr-only" htmlFor="error-detached-branch">Branch to check out</label>
                <Select
                  id="error-detached-branch"
                  className="min-w-0 flex-1"
                  triggerClassName="min-h-10 border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] hover:border-[var(--ec-danger-ring)]"
                  menuClassName="border-[var(--ec-danger-ring)] ring-[var(--ec-danger-ring)]"
                  value={detachedCheckoutBranch}
                  onValueChange={onDetachedCheckoutBranchChange}
                  disabled={projectCheckoutBusy || availableRunBranches.length === 0}
                  options={availableRunBranches.map((name) => ({ value: name, label: name }))}
                />
                <Button type="button" variant="secondary" className="shrink-0 border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)] hover:bg-[var(--ec-danger-soft)]" disabled={projectCheckoutBusy || !detachedCheckoutBranch.trim()} onClick={onSubmitCheckoutDetachedProjectBranch}>
                  {projectCheckoutBusy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />Checking out...</> : "Check out branch"}
                </Button>
              </div>
            )}
          </div>
          <button type="button" className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onDismissError} aria-label="Dismiss error notification"><X className="h-4 w-4" /></button>
        </div>
      </Card>
    </div>
  );
};

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
  automationStartedToasts,
  onDismissAutomationStartedToast,
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
        className="fixed bottom-6 left-1/2 z-[65] flex max-w-[min(90vw,24rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-panel)] px-4 py-2 text-sm text-[var(--ec-accent)] shadow-lg backdrop-blur"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ec-accent)]" aria-hidden />
        <span>{pendingDeleteRunCount === 1 ? "Deleting run..." : `Deleting ${pendingDeleteRunCount} runs...`}</span>
      </div>
    ) : null}

    <ShellApprovalNotifications
      busy={busy}
      visibleShellApprovals={visibleShellApprovals}
      shellApprovalQueueLength={shellApprovalQueueLength}
      queuedShellApprovalCount={queuedShellApprovalCount}
      visibleShellApprovalStartedAtById={visibleShellApprovalStartedAtById}
      getShellApprovalTarget={getShellApprovalTarget}
      onOpenShellApprovalRun={onOpenShellApprovalRun}
      onRespondToShellApproval={onRespondToShellApproval}
      now={shellApprovalNow}
    />

    <ErrorNotification
      error={error}
      selectedProjectName={selectedProjectName}
      detachedCheckoutBranch={detachedCheckoutBranch}
      availableRunBranches={availableRunBranches}
      projectCheckoutBusy={projectCheckoutBusy}
      onDetachedCheckoutBranchChange={onDetachedCheckoutBranchChange}
      onSubmitCheckoutDetachedProjectBranch={onSubmitCheckoutDetachedProjectBranch}
      onDismissError={onDismissError}
    />

    {appWarning ? (
      <div className="fixed right-4 top-14 z-[20040] w-[calc(100vw-2rem)] max-w-md">
        <Card className="border-[var(--ec-warning-ring)] bg-[var(--ec-panel)] p-4 shadow-2xl shadow-[var(--ec-warning-soft)] backdrop-blur">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-full border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] p-2 text-[var(--ec-warning)]">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-warning)]">Warning</p>
              <p className="mt-1.5 text-sm font-medium text-[var(--ec-text)]">{appWarning.title}</p>
              <p className="mt-2 text-sm text-[var(--ec-warning)]">{appWarning.message}</p>
              {appWarning.detail ? (
                <pre className="app-scrollbar mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--ec-warning-ring)] bg-[var(--ec-panel)] p-2 text-xs text-[var(--ec-warning)]">
                  {appWarning.detail}
                </pre>
              ) : null}
            </div>
            <button
              type="button"
              className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              onClick={onDismissAppWarning}
              aria-label="Dismiss warning notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      </div>
    ) : null}

    {automationStartedToasts.length > 0 || projectForgeRequestToasts.length > 0 ? (
      <div
        className={cn(
          "fixed right-4 z-[20039] flex w-[calc(100vw-2rem)] max-w-md flex-col gap-2",
          appWarning || error ? "top-64" : "top-14",
        )}
        role="region"
        aria-live="polite"
        aria-label="Application notifications"
      >
        {automationStartedToasts.map((toast) => (
          <Card key={toast.runId} className="border-[var(--ec-accent-ring)] bg-[var(--ec-panel)] p-3 shadow-2xl shadow-[var(--ec-accent-soft)] backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] p-2 text-[var(--ec-accent)]">
                <CalendarClock className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ec-accent)]">Automation started</p>
                <p className="mt-1 truncate text-sm font-semibold text-[var(--ec-text)]" title={toast.automationName}>{toast.automationName}</p>
                <p className="mt-1 truncate text-xs text-[var(--ec-muted)]">{toast.projectName} · Agent run is active</p>
              </div>
              <button
                type="button"
                className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
                onClick={() => onDismissAutomationStartedToast(toast.runId)}
                aria-label={`Dismiss ${toast.automationName} automation notification`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Card>
        ))}
        {projectForgeRequestToasts.map((toast) => (
          <Card key={toast.id} className="border-[var(--ec-accent-ring)] bg-[var(--ec-panel)] p-3 shadow-2xl shadow-[var(--ec-accent-soft)] backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] p-2 text-[var(--ec-accent)]">
                <GitPullRequest className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ec-accent)]">
                  New {toast.providerLabel}
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-[var(--ec-text)]" title={toast.title}>
                  {toast.title}
                </p>
                <p className="mt-1 truncate text-xs text-[var(--ec-muted)]">
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
                className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
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
