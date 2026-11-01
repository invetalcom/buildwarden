import { GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE, isDetachedHeadProjectErrorMessage } from "@buildwarden/shared";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Select } from "../ui/select";

export interface ErrorNotificationProps {
  error: string | null;
  onDismissError: () => void;
  action?: { label: string; onClick: () => void };
  selectedProjectName?: string | null;
  detachedCheckoutBranch?: string;
  availableRunBranches?: string[];
  projectCheckoutBusy?: boolean;
  onDetachedCheckoutBranchChange?: (branch: string) => void;
  onSubmitCheckoutDetachedProjectBranch?: () => void;
}

export const ErrorNotification = ({ error, selectedProjectName = null, detachedCheckoutBranch = "", availableRunBranches = [], projectCheckoutBusy = false, onDetachedCheckoutBranchChange = () => {}, onSubmitCheckoutDetachedProjectBranch = () => {}, onDismissError, action }: ErrorNotificationProps) => {
  if (!error) {
    return null;
  }
  const detachedHead = isDetachedHeadProjectErrorMessage(error);
  return (
    <div className="fixed right-4 top-14 z-[20050] w-[calc(100vw-2rem)] max-w-md" role="alert">
      <Card className="border-[var(--ec-danger-ring)] bg-[var(--ec-panel)] p-4 shadow-2xl shadow-[var(--ec-danger-soft)] backdrop-blur">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-full border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] p-2 text-[var(--ec-danger)]"><AlertTriangle className="h-4 w-4" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-danger)]">Error</p>
            {detachedHead && selectedProjectName && <p className="mt-1.5 truncate text-sm font-medium text-[var(--ec-text)]" title={selectedProjectName}>Project: {selectedProjectName}</p>}
            <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm text-[var(--ec-danger)]">{detachedHead ? GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE : error}</p>
            {action && <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={action.onClick}>{action.label}</Button>}
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

