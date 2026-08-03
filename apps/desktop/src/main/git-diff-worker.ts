import { parentPort } from "node:worker_threads";
import { computeWorktreeDiff } from "@buildwarden/git-service";

type DiffRequest = { type: "compute"; requestId: number; worktreePath: string };

const port = parentPort;
if (!port) {
  throw new Error("git-diff-worker requires parentPort.");
}

const queue: DiffRequest[] = [];
let activeJobs = 0;
const MAX_CONCURRENT_DIFFS = 2;

const drainQueue = () => {
  while (activeJobs < MAX_CONCURRENT_DIFFS && queue.length > 0) {
    const request = queue.shift()!;
    activeJobs += 1;
    void computeWorktreeDiff(request.worktreePath)
      .then((diff) => {
        port.postMessage({ type: "ok", requestId: request.requestId, diff });
      })
      .catch((error: unknown) => {
        port.postMessage({
          type: "error",
          requestId: request.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        activeJobs -= 1;
        drainQueue();
      });
  }
};

port.on("message", (message: DiffRequest) => {
  if (message.type !== "compute") return;
  queue.push(message);
  drainQueue();
});
