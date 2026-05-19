import { parentPort, workerData } from "node:worker_threads";
import { computeWorktreeDiff } from "@easycode/git-service";

const port = parentPort;
if (!port) {
  throw new Error("git-diff-worker requires parentPort.");
}

const { worktreePath } = workerData as { worktreePath: string };

void computeWorktreeDiff(worktreePath)
  .then((diff) => {
    port.postMessage({ type: "ok", diff });
  })
  .catch((error: unknown) => {
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
