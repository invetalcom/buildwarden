import { useCallback, useEffect, useState } from "react";
import type { ShellApprovalDecision } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";

export interface PendingShellApproval {
  runId: string;
  requestId: string;
  command: string;
  requestedAt: number;
}

export interface ApprovalQueue {
  pending: readonly PendingShellApproval[];
  respond: (request: PendingShellApproval, decision: ShellApprovalDecision) => Promise<void>;
  dismiss: (requestId: string) => void;
}

/**
 * Shell approvals block a run, so on mobile they are a first-class surface: a badge on the Home
 * tab plus a sheet that raises itself.
 *
 * Unlike the desktop queue this never auto-denies after a timeout. A desktop user is sitting in
 * front of the toast; a phone user may not look at it for ten minutes, and silently denying would
 * kill their run. Leaving the request pending keeps the decision with the human.
 */
export const useApprovalQueue = (client: BuildWardenClient): ApprovalQueue => {
  const [pending, setPending] = useState<PendingShellApproval[]>([]);

  const dismiss = useCallback((requestId: string) => {
    setPending((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  useEffect(() => {
    const unsubscribe = client.onRunEvent((event) => {
      const requestId = typeof event.metadata?.approvalRequestId === "string" ? event.metadata.approvalRequestId : null;
      const command = typeof event.metadata?.command === "string" ? event.metadata.command : null;

      if (event.metadata?.shellApprovalRequest === true && requestId && command) {
        setPending((current) =>
          current.some((item) => item.requestId === requestId && item.runId === event.runId)
            ? current
            : [...current, { runId: event.runId, requestId, command, requestedAt: Date.now() }],
        );
      }
      // Resolved elsewhere (desktop app, another browser) or the run went away.
      if (requestId && event.metadata?.shellApprovalDecision) {
        setPending((current) => current.filter((item) => item.requestId !== requestId));
      }
      if (event.title === "Run cancelled") {
        setPending((current) => current.filter((item) => item.runId !== event.runId));
      }
    });
    return unsubscribe;
  }, [client]);

  const respond = useCallback(
    async (request: PendingShellApproval, decision: ShellApprovalDecision) => {
      await client.respondToShellApproval(
        request.runId,
        request.requestId,
        decision,
        decision === "allow-always" ? { command: request.command } : undefined,
      );
      setPending((current) => current.filter((item) => item.requestId !== request.requestId));
    },
    [client],
  );

  return { pending, respond, dismiss };
};
