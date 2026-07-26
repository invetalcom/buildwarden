import { useState } from "react";
import type { ShellApprovalDecision } from "@buildwarden/shared";
import { ShieldAlert } from "lucide-react";
import { useMobileApp } from "../data/mobile-app-context";
import { errorMessage, runTitle } from "../lib/format";
import { findProjectRun } from "@buildwarden/renderer/logic";
import { Sheet } from "./Sheet";
import { Button } from "./primitives";

/**
 * Shell approvals are the one thing that hard-blocks a run, so on mobile they get a sheet that
 * raises itself over whatever screen is open rather than a toast that can scroll away.
 */
export const ApprovalSheet = () => {
  const { approvals, snapshot, client, router } = useMobileApp();
  const [busy, setBusy] = useState<ShellApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = approvals.pending[0] ?? null;
  const queued = Math.max(0, approvals.pending.length - 1);

  if (!request) return null;

  const target = findProjectRun(snapshot.projects, request.runId);
  const canRespond = client.capabilities.approvalResponses;

  const respond = async (decision: ShellApprovalDecision) => {
    setBusy(decision);
    setError(null);
    try {
      await approvals.respond(request, decision);
    } catch (caught) {
      setError(errorMessage(caught, "The host did not accept that decision."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      open
      dismissable={false}
      onClose={() => approvals.dismiss(request.requestId)}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-[var(--ec-warning)]" />
          Approve command
          {queued > 0 ? <span className="text-xs font-normal text-[var(--ec-faint)]">+{queued} waiting</span> : null}
        </span>
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        {target ? (
          <button
            type="button"
            onClick={() => router.push({ name: "run", runId: request.runId, segment: "activity" })}
            className="text-left text-xs text-[var(--ec-accent)] underline"
          >
            {target.project.project.name} · {runTitle(target.run)}
          </button>
        ) : null}

        <pre className="m-scroll-thin m-mono max-h-56 overflow-auto rounded-md border border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] px-3 py-2.5 text-[12px] leading-5 text-[var(--ec-text)]">
          {request.command}
        </pre>

        {error ? (
          <p className="m-wrap-anywhere rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-3 py-2 text-xs text-[var(--ec-danger)]">
            {error}
          </p>
        ) : null}

        {canRespond ? (
          <div className="flex flex-col gap-2">
            <Button block busy={busy === "allow-once"} onClick={() => void respond("allow-once")}>
              Allow once
            </Button>
            <div className="flex gap-2">
              <Button tone="neutral" className="flex-1" busy={busy === "allow-for-run"} onClick={() => void respond("allow-for-run")}>
                Allow for this run
              </Button>
              <Button tone="neutral" className="flex-1" busy={busy === "allow-always"} onClick={() => void respond("allow-always")}>
                Always allow
              </Button>
            </div>
            <Button tone="danger" block busy={busy === "deny"} onClick={() => void respond("deny")}>
              Deny
            </Button>
          </div>
        ) : (
          <p className="text-xs leading-5 text-[var(--ec-muted)]">
            This browser session was paired without the approval scope. Approve on the desktop app, or pair again with
            approval permissions.
          </p>
        )}
      </div>
    </Sheet>
  );
};
