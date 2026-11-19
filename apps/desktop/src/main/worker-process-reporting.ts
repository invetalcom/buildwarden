import type { ChildProcess } from "node:child_process";
import { subscribe } from "node:diagnostics_channel";
import { isMarkedAgentProcess } from "@buildwarden/shared";

export interface WorkerProcessSpawnedMessage {
  type: "process-spawned";
  pid: number;
  role: "agent" | "command";
  spawnedAtMs: number;
  commandLine: string;
  /** Exact launch arguments; a process can rewrite what the OS later reports (`process.title`). */
  argv: string[];
}

/**
 * Reports every process this worker thread spawns, whichever provider or tool spawns it, so the
 * host can attribute it (and everything it starts) to the run or chat this worker serves. Node
 * publishes `child_process` before the spawn, so the PID is read once the process started.
 */
export const reportWorkerSpawnedProcesses = (post: (message: WorkerProcessSpawnedMessage) => void): void => {
  subscribe("child_process", (message) => {
    const child = (message as { process?: ChildProcess } | null)?.process;
    if (!child || typeof child.once !== "function") return;
    const spawnedAtMs = Date.now();
    child.once("spawn", () => {
      if (typeof child.pid !== "number") return;
      try {
        post({
          type: "process-spawned",
          pid: child.pid,
          role: isMarkedAgentProcess(child) ? "agent" : "command",
          spawnedAtMs,
          commandLine: child.spawnargs.join(" "),
          argv: [...child.spawnargs],
        });
      } catch {
        // Reporting is best effort; a closed port must not break the spawn.
      }
    });
  });
};
