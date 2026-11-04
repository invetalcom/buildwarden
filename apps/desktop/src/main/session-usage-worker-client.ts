import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionUsageRoot, SessionUsageResult } from "./local-session-usage";

/** Parsing and cache serialization belong off the Electron main event loop. */
export class SessionUsageWorkerClient {
  private worker: Worker | undefined;
  private pending: Promise<SessionUsageResult> | undefined;
  constructor(private readonly options: { cacheFilePath: string }) {}
  async load(roots: SessionUsageRoot[], force = false): Promise<SessionUsageResult> {
    while (this.pending) await this.pending.catch(() => undefined);
    if (!this.worker) {
      const instance = new Worker(join(dirname(fileURLToPath(import.meta.url)), "session-usage-worker.js"), { workerData: this.options });
      const clear = () => { if (this.worker === instance) this.worker = undefined; };
      instance.on("error", clear);
      instance.on("exit", clear);
      this.worker = instance;
    }
    const worker = this.worker;
    const task = new Promise<SessionUsageResult>((resolve, reject) => {
      const cleanup = () => { worker.removeListener("message", message); worker.removeListener("error", fail); worker.removeListener("exit", exit); worker.unref(); };
      const fail = (error: Error) => { cleanup(); this.worker = undefined; void worker.terminate(); reject(error); };
      const exit = () => fail(new Error("Usage worker exited before completing the scan."));
      const message = (reply: { result: SessionUsageResult; error?: string }) => { cleanup(); if (reply.error) reject(new Error(reply.error)); else resolve(reply.result); };
      worker.ref();
      worker.once("message", message); worker.once("error", fail); worker.once("exit", exit);
      worker.postMessage({ roots, force });
    });
    this.pending = task;
    try { return await task; } finally { this.pending = undefined; }
  }
}
