import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type WorktreeDiffWorkerOutcome = { ok: true; diff: string } | { ok: false };

/** Runs `computeWorktreeDiff` from `@buildwarden/git-service` in a dedicated thread (non-blocking main process). */
export function runWorktreeDiffInWorker(worktreePath: string): Promise<WorktreeDiffWorkerOutcome> {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), "git-diff-worker.js");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: WorktreeDiffWorkerOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };

    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        workerData: { worktreePath },
      });
    } catch {
      finish({ ok: false });
      return;
    }

    worker.on(
      "message",
      (msg: { type: string; diff?: string; message?: string }) => {
        if (msg.type === "ok" && typeof msg.diff === "string") {
          void worker.terminate().catch(() => {});
          finish({ ok: true, diff: msg.diff });
          return;
        }
        if (msg.type === "error") {
          void worker.terminate().catch(() => {});
          finish({ ok: false });
        }
      },
    );

    worker.on("error", () => {
      void worker.terminate().catch(() => {});
      finish({ ok: false });
    });

    worker.on("exit", () => {
      if (!settled) {
        finish({ ok: false });
      }
    });
  });
}
