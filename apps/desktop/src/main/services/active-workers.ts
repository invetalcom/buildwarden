import { stopWorkerAfterCleanup } from "../worker-shutdown";
import { AppService } from "./app-service";
import { type ActiveWorker, ActiveWorkerMap } from "./worker-payloads";

/** Tracks the live run and chat worker threads and stops them. */
export class ActiveWorkers extends AppService<
  | "automations"
  | "automationWorkflows"
  | "processes"
  | "projectLab"
  | "projectLoops"
  | "providerRuntime"
  | "runEvents"
  | "titles"
> {
  readonly runWorkers = new ActiveWorkerMap(() => this.handleActiveWorkersChanged());
  agentWorkersStopping = false;
  private agentWorkerShutdown: Promise<void> | null = null;
  readonly chatWorkers = new ActiveWorkerMap(() => this.handleActiveWorkersChanged());

  handleActiveWorkersChanged(): void {
    this.services.providerRuntime.providerCliUpdateServiceInstance?.refreshUsage();
    this.lifecycle.onAgentActivityChanged?.(this.runWorkers.size > 0 || this.chatWorkers.size > 0 || this.services.providerRuntime.providerCliStartReservations.size > 0);
  }

  getActiveSessionCounts(): { runs: number; chats: number } {
    return { runs: this.runWorkers.size, chats: this.chatWorkers.size };
  }

  requireAgentWorkersAvailable(): void {
    if (this.agentWorkersStopping) throw new Error("BuildWarden is shutting down. New agent work cannot start.");
  }

  /** Drain provider cleanup before Electron exits; retain checkpoints for startup recovery. */
  stopAgentWorkers(): Promise<void> {
    if (this.agentWorkerShutdown) return this.agentWorkerShutdown;
    this.agentWorkersStopping = true;
    this.services.processes.ownedProcessRegistryInstance?.dispose();
    const titleShutdown = this.services.titles.sessionTitleServiceInstance?.stop();
    if (this.services.automations.automationSchedulerTimer) clearInterval(this.services.automations.automationSchedulerTimer);
    this.services.automations.automationSchedulerTimer = null;
    this.services.automationWorkflows.stopWorkflowTimers();
    const runs = [...this.runWorkers.entries()];
    const chats = [...this.chatWorkers.entries()];
    // Invalidate callbacks before cancellation can synchronously deliver terminal messages.
    for (const [id, active] of runs) {
      active.cancelled = true;
      this.runWorkers.delete(id);
    }
    for (const [id, active] of chats) {
      active.cancelled = true;
      this.chatWorkers.delete(id);
    }
    this.agentWorkerShutdown = Promise.allSettled([
      titleShutdown ?? Promise.resolve(),
      ...runs.map(([, active]) => stopWorkerAfterCleanup(active.worker, () => this.requestRunWorkerStop(active))),
      ...chats.map(([, active]) => stopWorkerAfterCleanup(active.worker, () => active.worker.postMessage({ type: "cancel" }))),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") this.logControllerError("Agent worker did not stop cleanly during shutdown.", result.reason);
      }
    });
    return this.agentWorkerShutdown;
  }

  async cancelRunWorker(runId: string): Promise<void> {
    const active = this.runWorkers.get(runId);

    if (!active) {
      return;
    }

    this.requestRunWorkerStop(active);
    this.db.updateRunStatus(runId, "cancelled", { errorMessage: "Run cancelled by user." });
    await this.services.runEvents.appendRunEvent(runId, "status", "Run cancelled", "Cancellation requested.");
    const run = this.db.getRun(runId);
    if (run.kind === "lab-implementation") {
      this.services.projectLab.cancelProjectLabImplementation(run, "The implementation run was cancelled by the user.");
    }
    if (run.kind === "loop-iteration") {
      const iteration = this.db.getProjectLoopIterationByRunId(runId);
      if (iteration) {
        // Cancelling a loop's implementation run means stopping the whole loop.
        await this.services.projectLoops.loopRunner.cancelLoop(iteration.loopId).catch((error) => {
          this.logControllerError("Could not cancel the loop after its run was cancelled.", error, { runId, loopId: iteration.loopId });
        });
      }
    }
    this.services.runEvents.emitEvent({
      runId,
      type: "status",
      title: "Run cancelled",
      content: "Cancellation requested.",
      createdAt: new Date().toISOString(),
    });
  }

  requestRunWorkerStop(active: ActiveWorker): void {
    active.cancelled = true;
    for (const [runId, entry] of this.runWorkers) {
      if (entry === active) this.lifecycle.onRunBrowserActive?.(runId, false);
    }
    active.verificationAbortController?.abort();
    active.worker.postMessage({ type: "cancel" });
  }
}
