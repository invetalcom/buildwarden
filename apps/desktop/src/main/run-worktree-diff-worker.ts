import { Worker } from "node:worker_threads";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type WorktreeDiffWorkerOutcome = { ok: true; diff: string } | { ok: false; message?: string };

type PendingRequest = { resolve: (outcome: WorktreeDiffWorkerOutcome) => void };
type WorkerMessage = { type: "ok"; requestId: number; diff: string } | { type: "error"; requestId: number; message?: string };

let worker: Worker | null = null;
let nextRequestId = 0;
let disposing = false;
const pending = new Map<number, PendingRequest>();
const inFlightByPath = new Map<string, Promise<WorktreeDiffWorkerOutcome>>();

const failPending = (message?: string) => {
  for (const request of pending.values()) request.resolve({ ok: false, message });
  pending.clear();
  inFlightByPath.clear();
};

const resetWorker = (message?: string) => {
  worker = null;
  failPending(message);
};

const getWorker = (): Worker | null => {
  if (worker) return worker;
  if (disposing) return null;
  try {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), "git-diff-worker.js");
    const instance = new Worker(workerPath);
    instance.on("message", (message: WorkerMessage) => {
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      request.resolve(message.type === "ok" ? { ok: true, diff: message.diff } : { ok: false, message: message.message });
    });
    instance.on("error", (error) => {
      if (worker === instance) resetWorker(error.message);
    });
    instance.on("exit", (code) => {
      if (worker === instance) resetWorker(code === 0 ? undefined : `Diff worker exited with code ${code}.`);
    });
    worker = instance;
    return instance;
  } catch (error) {
    resetWorker(error instanceof Error ? error.message : String(error));
    return null;
  }
};

/** Runs a full worktree diff in a persistent worker and coalesces duplicate in-flight paths. */
export function runWorktreeDiffInWorker(worktreePath: string): Promise<WorktreeDiffWorkerOutcome> {
  const normalizedPath = resolve(worktreePath);
  const existing = inFlightByPath.get(normalizedPath);
  if (existing) return existing;

  const request = new Promise<WorktreeDiffWorkerOutcome>((resolveRequest) => {
    const instance = getWorker();
    if (!instance) {
      resolveRequest({ ok: false, message: "The diff worker is unavailable." });
      return;
    }
    const requestId = ++nextRequestId;
    pending.set(requestId, { resolve: resolveRequest });
    instance.postMessage({ type: "compute", requestId, worktreePath: normalizedPath });
  }).finally(() => {
    inFlightByPath.delete(normalizedPath);
  });
  inFlightByPath.set(normalizedPath, request);
  return request;
}

export const disposeWorktreeDiffWorker = async (): Promise<void> => {
  disposing = true;
  const instance = worker;
  worker = null;
  failPending("The application is shutting down.");
  if (instance) await instance.terminate().catch(() => {});
};
