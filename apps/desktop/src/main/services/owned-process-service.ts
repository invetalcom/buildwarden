import type { ManageOwnedProcessesInput, OwnedProcessesSnapshot, OwnedProcessOutput, OwnedProcessOwner, RunRecord } from "@buildwarden/shared";
import { createOwnedProcessRegistry, type OwnedProcessRegistry } from "../owned-processes";
import type { WorkerProcessSpawnedMessage } from "../worker-process-reporting";
import { stopWorkerAfterCleanup } from "../worker-shutdown";
import { AppService } from "./app-service";

/** Lists and stops the processes that runs and chats started. */
export class OwnedProcessService extends AppService<"activeWorkers" | "chatWorkerHost" | "verification" | "workspaceGuard"> {
  ownedProcessRegistryInstance: OwnedProcessRegistry | null = null;

  /** Processes that run and chat workers spawned; created on first use so idle hosts inspect nothing. */
  get ownedProcesses(): OwnedProcessRegistry {
    this.ownedProcessRegistryInstance ??= createOwnedProcessRegistry({
      onChange: (snapshot) => this.events.publish("ownedProcesses", snapshot),
      log: (message, error) => this.logControllerError(message, error),
    });
    return this.ownedProcessRegistryInstance;
  }

  registerRunWorkerProcess(run: RunRecord, message: WorkerProcessSpawnedMessage): void {
    let cwd: string | null = null;
    try {
      cwd = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId));
    } catch {
      cwd = run.worktreePath ?? null;
    }
    this.ownedProcesses.registerSpawn({ kind: "run", id: run.id }, message, cwd);
  }

  /**
   * Agents leave their servers running after a turn; once their run or chat goes away, so do
   * they. Best effort: a process that cannot be stopped must not block the deletion.
   */
  async stopOwnedProcessesForRemoval(owner: OwnedProcessOwner): Promise<void> {
    const registry = this.ownedProcessRegistryInstance;
    if (!registry) return;
    try {
      await registry.manage({ owner, action: "kill-all" });
    } catch (error) {
      this.logControllerError("Could not stop processes before removing their workspace.", error, { owner: `${owner.kind}:${owner.id}` });
    }
  }

  async getOwnedProcesses(owner: OwnedProcessOwner): Promise<OwnedProcessesSnapshot> {
    return this.ownedProcesses.getSnapshot(owner);
  }

  async manageOwnedProcesses(input: ManageOwnedProcessesInput): Promise<OwnedProcessesSnapshot> {
    return this.ownedProcesses.manage(input);
  }

  async getOwnedProcessOutput(owner: OwnedProcessOwner, processId: string): Promise<OwnedProcessOutput> {
    return this.ownedProcesses.getOutput(owner, processId);
  }

  async stopRunOwnedProcesses(runId: string): Promise<void> {
    await this.services.verification.cancelRunVerification(runId);
    this.terminal.killForRunId(runId);
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (active) {
      const stopped = stopWorkerAfterCleanup(active.worker, () => this.services.activeWorkers.requestRunWorkerStop(active));
      this.services.activeWorkers.runWorkers.delete(runId);
      await stopped;
    }
    for (const runChat of this.db.getChatsForRun(runId)) {
      const activeChat = this.services.activeWorkers.chatWorkers.get(runChat.id);
      if (activeChat) {
        activeChat.cancelled = true;
        const stopped = stopWorkerAfterCleanup(activeChat.worker, () => activeChat.worker.postMessage({ type: "cancel" }));
        this.services.activeWorkers.chatWorkers.delete(runChat.id);
        this.services.chatWorkerHost.chatUserInputRequests.delete(runChat.id);
        this.db.closeChatUserInputRequests(runChat.id);
        await stopped;
      }
    }
    // Callers release the workspace next (council children, orchestration cascades); servers the
    // run left running must not outlive it or keep its files open.
    await this.stopOwnedProcessesForRemoval({ kind: "run", id: runId });
  }
}
