import {
  ownedProcessOwnerKey,
  type ManageOwnedProcessesInput,
  type OwnedProcessOutput,
  type OwnedProcessOwnerKind,
  type OwnedProcessesSnapshot,
} from "@buildwarden/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { reportRendererError } from "../../lib/report-renderer-error";

type ProcessActionInput = Omit<ManageOwnedProcessesInput, "owner"> & { processId?: string };

export interface OwnedProcessesState {
  /** False on clients that cannot inspect host processes (the hosted web client). */
  available: boolean;
  /** Whether this client may stop, kill, or restart the owner's processes. */
  canManage: boolean;
  snapshot: OwnedProcessesSnapshot | null;
  error: string | null;
  /** Process id (or bulk action name) currently being acted on. */
  pending: ReadonlySet<string>;
  act: (input: ProcessActionInput) => Promise<void>;
  loadOutput: (processId: string) => Promise<OwnedProcessOutput | null>;
  clearError: () => void;
}

/** Re-renders once a second while something runs, so durations stay current. */
export const useProcessClock = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
};

/** Live view of the processes a run's or chat's agent started, plus the actions on them. */
export const useOwnedProcesses = (kind: OwnedProcessOwnerKind, id: string | null): OwnedProcessesState => {
  const client = useBuildWardenClient();
  // A renderer reloaded against an older desktop bridge lacks these methods; treat it as unavailable.
  const available = client.capabilities.processInspection === true && Boolean(id) &&
    typeof client.getOwnedProcesses === "function" && typeof client.onOwnedProcessesChanged === "function";
  // Read-only remote sessions may watch processes but not stop or restart them.
  const canManage = available && (kind === "run" ? client.capabilities.runMutations : client.capabilities.chatMutations);
  const owner = useMemo(() => (id ? { kind, id } : null), [id, kind]);
  const ownerKey = owner ? ownedProcessOwnerKey(owner) : null;
  const [snapshot, setSnapshot] = useState<OwnedProcessesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  /** Bumped when the client or owner changes; results of older requests are then ignored. */
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setSnapshot(null);
    setError(null);
    setPending(new Set());
    if (!available || !owner) return;
    let disposed = false;
    const unsubscribe = client.onOwnedProcessesChanged((next) => {
      if (!disposed && ownedProcessOwnerKey(next.owner) === ownerKey) setSnapshot(next);
    });
    void client.getOwnedProcesses(owner).then(
      (next) => {
        // A pushed update may already be newer than this initial read.
        if (!disposed) setSnapshot((current) => current ?? next);
      },
      (caught: unknown) => {
        reportRendererError("renderer.owned-processes.load", caught, { owner: ownerKey });
        if (!disposed) setError(caught instanceof Error ? caught.message : "Could not load processes.");
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [available, client, owner, ownerKey]);

  const act = useCallback(async (input: ProcessActionInput) => {
    if (!owner) return;
    const generation = generationRef.current;
    const current = () => generationRef.current === generation;
    const key = input.processId ?? input.action;
    setPending((pendingKeys) => new Set(pendingKeys).add(key));
    setError(null);
    try {
      const next = await client.manageOwnedProcesses({ ...input, owner } as ManageOwnedProcessesInput);
      // Another run or chat may be shown by now; its snapshot must not be replaced by this one.
      if (current()) setSnapshot(next);
    } catch (caught) {
      if (current()) setError(caught instanceof Error ? caught.message : "The process action failed.");
    } finally {
      if (current()) {
        setPending((pendingKeys) => {
          const next = new Set(pendingKeys);
          next.delete(key);
          return next;
        });
      }
    }
  }, [client, owner]);

  const loadOutput = useCallback(async (processId: string) => {
    if (!owner) return null;
    const generation = generationRef.current;
    try {
      const output = await client.getOwnedProcessOutput(owner, processId);
      return generationRef.current === generation ? output : null;
    } catch (caught) {
      if (generationRef.current === generation) setError(caught instanceof Error ? caught.message : "Could not read the output.");
      return null;
    }
  }, [client, owner]);

  const clearError = useCallback(() => setError(null), []);

  return { available, canManage, snapshot, error, pending, act, loadOutput, clearError };
};
