import type { DesktopApi, ShellApprovalDecision } from "@buildwarden/shared";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ShellApprovalRequestState } from "./AppNotifications";

interface UseShellApprovalQueueInput {
  buildwarden: DesktopApi | undefined;
  loadRunDetailForRun: (runId: string) => Promise<unknown>;
  loadSnapshot: () => Promise<unknown>;
  selectedRunId: string | null | undefined;
  setError: Dispatch<SetStateAction<string | null>>;
}

export const useShellApprovalQueue = ({
  buildwarden,
  loadRunDetailForRun,
  loadSnapshot,
  selectedRunId,
  setError,
}: UseShellApprovalQueueInput) => {
  const [queue, setQueue] = useState<ShellApprovalRequestState[]>([]);
  const [visibleStartedAtById, setVisibleStartedAtById] = useState<Partial<Record<string, number>>>({});
  const visible = useMemo(() => queue.slice(0, 3), [queue]);

  const enqueue = useCallback((request: ShellApprovalRequestState) => {
    setQueue((current) => {
      if (current.some((item) => item.requestId === request.requestId && item.runId === request.runId)) {
        return current;
      }
      return [...current, request];
    });
  }, []);

  const removeByRequestId = useCallback((requestId: string) => {
    setQueue((current) => current.filter((item) => item.requestId !== requestId));
  }, []);

  const removeByRunId = useCallback((runId: string) => {
    setQueue((current) => current.filter((item) => item.runId !== runId));
  }, []);

  const submitDecision = useCallback(
    async (request: ShellApprovalRequestState, decision: ShellApprovalDecision) => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.respondToShellApproval(
        request.runId,
        request.requestId,
        decision,
        decision === "allow-always" ? { command: request.command } : undefined,
      );
      removeByRequestId(request.requestId);
      await loadSnapshot();
      await loadRunDetailForRun(request.runId);
      if (selectedRunId && selectedRunId !== request.runId) {
        await loadRunDetailForRun(selectedRunId);
      }
    },
    [buildwarden, loadRunDetailForRun, loadSnapshot, removeByRequestId, selectedRunId],
  );

  const deny = useCallback(
    (request: ShellApprovalRequestState) => {
      void submitDecision(request, "deny").catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Unexpected error");
      });
    },
    [setError, submitDecision],
  );

  useEffect(() => {
    if (visible.length === 0) {
      return;
    }
    const timeoutIds = visible.map((request) =>
      window.setTimeout(
        () => deny(request),
        Math.max(0, (visibleStartedAtById[request.requestId] ?? Date.now()) + 30_000 - Date.now()),
      ),
    );
    return () => timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
  }, [deny, visible, visibleStartedAtById]);

  useEffect(() => {
    const visibleRequestIds = new Set(visible.map((request) => request.requestId));
    const queuedRequestIds = new Set(queue.map((request) => request.requestId));
    const now = Date.now();
    setVisibleStartedAtById((current) => {
      let changed = false;
      const next: Partial<Record<string, number>> = {};
      for (const requestId of queuedRequestIds) {
        const existing = current[requestId];
        if (visibleRequestIds.has(requestId)) {
          next[requestId] = existing ?? now;
          changed ||= existing === undefined;
        } else if (existing !== undefined) {
          changed = true;
        }
      }
      changed ||= Object.keys(current).length !== Object.keys(next).length;
      return changed ? next : current;
    });
  }, [queue, visible]);

  return {
    enqueue,
    pending: queue[0] ?? null,
    queuedCount: Math.max(0, queue.length - visible.length),
    queue,
    removeByRequestId,
    removeByRunId,
    submitDecision,
    visible,
    visibleStartedAtById,
  };
};
