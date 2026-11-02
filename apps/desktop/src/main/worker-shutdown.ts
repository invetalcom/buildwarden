import type { Worker } from "node:worker_threads";

/** Let provider finally blocks reap their subprocesses before destroying the worker. */
export async function stopWorkerAfterCleanup(worker: Worker, requestStop: () => void): Promise<void> {
  if (worker.threadId === -1) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", finish);
      worker.off("error", finish);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message)) return;
      // These terminal messages are sent only after harness.run has settled,
      // including its awaited provider cleanup.
      if (message.type === "done" || message.type === "error") finish();
    };
    const timer = setTimeout(finish, 12_000);
    worker.on("message", onMessage);
    worker.once("exit", finish);
    worker.once("error", finish);
    try { requestStop(); } catch (error) { cleanup(); reject(error); }
  });
  await worker.terminate();
}
