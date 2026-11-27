import {
  OrchestrationToolError,
  type OrchestrationRecord,
  type OrchestrationTaskRecord,
  type OrchestrationTaskRemote,
  type OrchestrationTaskStatus,
  type RunRecord,
} from "@buildwarden/shared";
import { AppService } from "./app-service";
import { buildDelegatedTaskPrompt } from "./orchestration-policy";

/** How often running remote tasks are checked; each check is one short call per task. */
export const REMOTE_TASK_POLL_MS = 10_000;

interface RemoteRunSummary {
  id: string;
  status: string;
  summary: string | null;
  error?: string;
}

const remoteStatus = (status: string): OrchestrationTaskStatus =>
  status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";

const describeWaiting = (waitingFor: "approval" | "input", hostLabel: string) => waitingFor === "approval"
  ? `The run on ${hostLabel} waits for a command approval. Only the user can approve it, on that host.`
  : `The run on ${hostLabel} asks the user a question. Answer it on that host.`;

/**
 * Delegated tasks that run on a linked host. Such a task has no local child run: it starts a run
 * on the host through the host's MCP endpoint, is polled until that run's turn ends, and then
 * publishes the run's summary like a local child's result. Its changes stay in the host's run.
 */
export class OrchestrationRemoteService extends AppService<"linkedHosts" | "orchestration" | "orchestrationCoordinator"> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  /** Tasks this process is starting on their host right now. */
  private readonly starting = new Set<string>();
  /**
   * Host runs to stop whose pending stop could not be saved, each with the save to try again. Each
   * poll retries the save and the stop, so a stop becomes durable once storage recovers; only a
   * restart before either succeeds can lose one, which the log says.
   */
  private readonly unsavedStops = new Map<string, { task: OrchestrationTaskRecord; save: () => Promise<boolean> }>();

  /** Whether the orchestration, or one above it in a nested tree, is being deleted. */
  private treeBeingDeleted(orchestrationId: string): boolean {
    let id: string | null = orchestrationId;
    for (let depth = 0; id && depth < 16; depth += 1) {
      let orchestration: OrchestrationRecord;
      try {
        orchestration = this.db.getOrchestration(id);
      } catch {
        return true; // Already gone.
      }
      if (orchestration.status === "deleting" || orchestration.status === "deletion-failed") return true;
      id = this.db.getOrchestrationTaskByChildRunId(orchestration.coordinatorRunId)?.orchestrationId ?? null;
    }
    return false;
  }

  /** Whether this process is asking a host to start the task right now. */
  isStarting(taskId: string): boolean {
    return this.starting.has(taskId);
  }

  /** Where a delegated task runs, from its tool arguments: null for a local task. */
  readRemotePlacement(entry: Record<string, unknown>, index: number): OrchestrationTaskRemote | null {
    const hostId = typeof entry.hostId === "string" ? entry.hostId.trim() : "";
    if (!hostId) return null;
    const host = this.services.linkedHosts.listLinkedHosts().find((candidate) => candidate.id === hostId);
    if (!host) throw new OrchestrationToolError("invalid_arguments", `Task ${index + 1}: linked host "${hostId}" does not exist. buildwarden_orchestration_get lists them.`);
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);
    return { hostId: host.id, hostLabel: host.label, projectId: text(entry.remoteProjectId), modelId: text(entry.remoteModelId), runId: null, waitingFor: null };
  }

  /** Starts the host's run for a remote task that has none yet. Failures settle the task. */
  async startRemoteTask(taskId: string): Promise<void> {
    const task = this.db.getOrchestrationTask(taskId);
    const remote = task.remote;
    if (!remote || remote.runId || task.status !== "pending" || this.starting.has(task.id)) return;
    // Checked in the same step that marks the start: a deletion that began earlier sees no start
    // here, and one that begins later finds this task starting and waits.
    if (this.treeBeingDeleted(task.orchestrationId)) return;
    // Provisioning is saved before the host is asked, so a second pass never starts a second run.
    this.starting.add(task.id);
    try {
      this.db.updateOrchestrationTask(task.id, { status: "provisioning" });
      try {
        await this.db.flushDurable();
      } catch (error) {
        // The host was not asked yet, so the task fails here rather than waiting as provisioning.
        await this.settle(task.id, { status: "failed", summary: null, errorMessage: `BuildWarden could not save the task before starting it on ${remote.hostLabel}: ${error instanceof Error ? error.message : String(error)}` })
          .catch((settleError: unknown) => this.logControllerWarn("Could not record a remote task's failed start.", { taskId: task.id, error: settleError }));
        return;
      }
      await this.startOnHost(task, remote);
    } finally {
      this.starting.delete(task.id);
    }
  }

  private async startOnHost(task: OrchestrationTaskRecord, remote: OrchestrationTaskRemote): Promise<void> {
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
    /** Set once the host created its run: from then on a failure must leave that run an owner. */
    let startedRemote: OrchestrationTaskRemote | null = null;
    try {
      const projectId = remote.projectId ?? await this.matchHostProject(remote, coordinator);
      const role = orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
      const prompt = [
        buildDelegatedTaskPrompt({
          roleName: role?.name ?? task.roleId, roleDescription: role?.description, intent: task.intent,
          task: task.prompt, goalText: coordinator.goalText,
        }),
        "",
        `This task runs on the linked host ${remote.hostLabel}, apart from the coordinator's machine. Your changes stay in this run's workspace there.`,
      ].join("\n");
      const started = await this.services.linkedHosts.callHostTool<{ run: RemoteRunSummary }>(remote.hostId, "start_run", {
        projectId, prompt, mode: task.intent === "inspect" ? "ask" : "code", ...(remote.modelId ? { modelId: remote.modelId } : {}),
      });
      const hostRun: OrchestrationTaskRemote = { ...remote, projectId, runId: started.run.id };
      startedRemote = hostRun;
      const cancelledWhileStarting = await this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
        // A cancellation can commit while start_run is on its way; the task must not come back to
        // life. A task deleted meanwhile is gone; its host run is stopped all the same.
        if (this.db.findOrchestrationTask(task.id)?.status !== "provisioning") return true;
        this.db.updateOrchestrationTask(task.id, { status: "running", startedAt: new Date().toISOString(), remote: hostRun });
        this.db.appendOrchestrationEvent({
          orchestrationId: task.orchestrationId, taskId: task.id, type: "task-started", title: task.title,
          content: `Started on ${remote.hostLabel} as run ${started.run.id}.`, metadata: { remoteHostId: remote.hostId, remoteRunId: started.run.id },
        });
        await this.db.flushDurable();
        this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
        return false;
      });
      if (cancelledWhileStarting) {
        // The cancellation found no host run to stop; stop the one the host created since. The
        // run id and the pending stop are saved first, so a restart while cancel_run is on its
        // way still knows the run; polling stops it until the host confirms.
        const pendingStop = { ...task, remote: { ...hostRun, stopPending: true } };
        const save = () => this.savePendingStop(pendingStop);
        let saved = false;
        try {
          saved = await save();
        } catch (error) {
          this.logControllerWarn("Could not save the pending stop of a remote run started after its task was cancelled. BuildWarden keeps retrying the save and the stop while it runs; a restart before either succeeds would lose the run.", { taskId: task.id, hostRunId: hostRun.runId, error });
        }
        // Without a durable record the obligation stays in memory, so a failed save and an
        // unreachable host together still leave the run an owner.
        if (!saved) this.unsavedStops.set(task.id, { task: pendingStop, save });
        this.ensurePolling();
        await this.retryPendingStop(pendingStop);
        return;
      }
      this.ensurePolling();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!startedRemote) {
        await this.settle(task.id, { status: "failed", summary: null, errorMessage: `${remote.hostLabel} could not start the task: ${message}` });
        return;
      }
      // The host runs the task, but BuildWarden could not record it. The task fails here, and its
      // host run keeps an owner: polling stops it until the host confirms. Polling starts first,
      // and when the failure cannot be saved either, the stop is kept in memory.
      const pendingStop = { ...task, remote: { ...startedRemote, stopPending: true } };
      const failure = {
        status: "failed" as const, summary: null, remote: pendingStop.remote,
        errorMessage: `BuildWarden could not record the run ${remote.hostLabel} started (${message}); it stops that run.`,
      };
      this.ensurePolling();
      try {
        await this.settle(task.id, failure);
      } catch (settleError) {
        // A retried settlement returns early when the failed save had recorded the failure already.
        // The wake and the change it skipped then come with the stop, once that save succeeds.
        this.unsavedStops.set(task.id, {
          task: pendingStop,
          save: async () => this.savePendingStop(pendingStop, { announce: !await this.settle(task.id, failure) }),
        });
        this.logControllerWarn("Could not record a remote task whose host run was started. BuildWarden keeps retrying the save and the stop while it runs; a restart before either succeeds would lose the run.", { taskId: task.id, hostRunId: startedRemote.runId, error: settleError });
      }
    }
  }

  /** The host's project with this project's name, which the coordinator did not name itself. */
  private async matchHostProject(remote: OrchestrationTaskRemote, coordinator: RunRecord): Promise<string> {
    const local = this.db.getProject(coordinator.projectId);
    const { projects = [] } = await this.services.linkedHosts.callHostTool<{ projects?: Array<{ id: string; name: string }> }>(remote.hostId, "list_projects", {});
    const match = projects.find((project) => project.name.toLowerCase() === local.name.toLowerCase());
    if (!match) {
      throw new Error(`it has no project named "${local.name}". Pass remoteProjectId; its projects are ${projects.map((project) => `${project.name} (${project.id})`).join(", ") || "none"}.`);
    }
    return match.id;
  }

  /**
   * Records a remote task's outcome as its published result and wakes the coordinator. False when
   * there was nothing to record: the task is gone, had ended already, or fails `when`, which is
   * checked under the orchestration's lock against the task as it is now.
   */
  private async settle(
    taskId: string,
    outcome: { status: OrchestrationTaskStatus; summary: string | null; errorMessage: string | null; remote?: OrchestrationTaskRemote },
    when?: (task: OrchestrationTaskRecord) => boolean,
  ): Promise<boolean> {
    // A task deleted with its orchestration has nothing left to record.
    const found = this.db.findOrchestrationTask(taskId);
    if (!found) return false;
    const { orchestrationId } = found;
    return this.services.orchestration.withOrchestrationMutation(orchestrationId, async () => {
      const task = this.db.findOrchestrationTask(taskId);
      if (!task || ["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return false;
      if (when && !when(task)) return false;
      this.db.transaction(() => {
        const updated = this.db.updateOrchestrationTask(task.id, {
          status: outcome.status, summary: outcome.summary, errorMessage: outcome.errorMessage,
          attentionReason: outcome.status === "failed" ? outcome.errorMessage : null,
          finishedAt: new Date().toISOString(),
          remote: outcome.remote ?? (task.remote ? { ...task.remote, waitingFor: null } : null),
        });
        const result = this.db.publishOrchestrationTaskResult(task.id, undefined, {});
        this.db.appendOrchestrationEvent({
          orchestrationId, taskId: task.id, type: outcome.status === "completed" ? "task-completed" : "attention", title: updated.title,
          content: outcome.status !== "completed" && outcome.errorMessage
            ? [outcome.errorMessage, outcome.summary].filter(Boolean).join("\n\n")
            : outcome.summary || `Task ${outcome.status}.`,
          metadata: { resultId: result.id, remoteHostId: task.remote?.hostId, remoteRunId: task.remote?.runId },
        });
      });
      await this.db.flushDurable();
      await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationId);
      this.services.orchestration.emitOrchestrationChanged(orchestrationId, taskId);
      return true;
    });
  }

  /** Checks every remote task that is still going. Overlapping calls share one pass. */
  pollRemoteTasks(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const tasks = this.db.listActiveRemoteOrchestrationTasks();
    const awaitingStop = this.db.listRemoteOrchestrationTasksAwaitingStop();
    if (tasks.length === 0 && awaitingStop.length === 0 && this.unsavedStops.size === 0) {
      this.stopPolling();
      return;
    }
    for (const task of awaitingStop) await this.retryPendingStop(task);
    for (const [taskId, unsaved] of [...this.unsavedStops]) {
      // Once saved, the stop is a durable obligation like any other and survives a restart.
      if (await this.retrySave(unsaved.save, taskId)) this.unsavedStops.delete(taskId);
      await this.retryPendingStop(unsaved.task);
    }
    for (const task of tasks) {
      const remote = task.remote!;
      if (await this.retryPendingCancellation(task)) continue;
      if (!remote.runId) {
        if (task.status === "pending") await this.startRemoteTask(task.id);
        else if (task.status === "provisioning" && !this.starting.has(task.id)) {
          // The app stopped while asking the host; whether the host started a run is unknown. The
          // pass read the task earlier, and a start may have recorded its host run since.
          await this.settle(task.id, {
            status: "failed", summary: null,
            errorMessage: `BuildWarden stopped while starting this task on ${remote.hostLabel}. Check that host for a run before delegating it again.`,
          }, (current) => current.status === "provisioning" && !current.remote?.runId && !this.starting.has(current.id));
        }
        continue;
      }
      let state: { run: RemoteRunSummary; finished: boolean; waitingFor: "approval" | "input" | null };
      try {
        state = await this.services.linkedHosts.callHostTool(remote.hostId, "wait_for_run", { runId: remote.runId, timeoutMs: 1_000 });
      } catch (error) {
        // A host that is offline for a while is not a failed task; the next pass tries again.
        this.logControllerWarn("A linked host did not answer for a remote task.", { taskId: task.id, hostId: remote.hostId, error });
        continue;
      }
      if (state.finished) {
        await this.settle(task.id, { status: remoteStatus(state.run.status), summary: state.run.summary, errorMessage: state.run.error ?? null });
        continue;
      }
      if ((state.waitingFor ?? null) !== (remote.waitingFor ?? null)) await this.recordWaiting(task, state.waitingFor ?? null);
    }
  }

  /** A host run that waits for the user needs the coordinator's attention, and the user's. */
  private async recordWaiting(task: OrchestrationTaskRecord, waitingFor: "approval" | "input" | null): Promise<void> {
    await this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
      // The task may have ended or been cancelled since the poll read it.
      const current = this.db.getOrchestrationTask(task.id);
      if (current.status !== "running" && current.status !== "waiting-input") return;
      const remote = current.remote!;
      const reason = waitingFor ? describeWaiting(waitingFor, remote.hostLabel) : null;
      this.db.updateOrchestrationTask(task.id, { status: waitingFor ? "waiting-input" : "running", attentionReason: reason, remote: { ...remote, waitingFor } });
      if (reason) {
        this.db.appendOrchestrationEvent({ orchestrationId: task.orchestrationId, taskId: task.id, type: "attention", title: task.title, content: reason });
      }
      await this.db.flushDurable();
      if (reason) await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(task.orchestrationId);
      this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
    });
  }

  /**
   * Stops the host's run for a cancelled task. Throws while the host cannot confirm it: the task
   * then stays as it is, its cancellation stays pending, and polling tries again.
   */
  async cancelRemoteRun(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.remote?.runId) return;
    try {
      await this.services.linkedHosts.callHostTool(task.remote.hostId, "cancel_run", { runId: task.remote.runId });
    } catch (error) {
      throw new Error(`${task.remote.hostLabel} did not confirm that it stopped run ${task.remote.runId}; BuildWarden keeps trying: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Saves a host run's pending stop on its task. False when the task is gone and cannot hold it.
   * With `announce`, the task's recorded outcome also wakes the coordinator once it is durable.
   */
  private savePendingStop(task: OrchestrationTaskRecord, options: { announce?: boolean } = {}): Promise<boolean> {
    return this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
      if (!this.db.findOrchestrationTask(task.id)) return false;
      this.db.updateOrchestrationTask(task.id, { remote: task.remote });
      await this.db.flushDurable();
      if (options.announce) {
        await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(task.orchestrationId);
        this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
      }
      return true;
    });
  }

  private async retrySave(save: () => Promise<boolean>, taskId: string): Promise<boolean> {
    try {
      return await save();
    } catch (error) {
      this.logControllerWarn("Still cannot save the pending stop of a remote task's host run.", { taskId, error });
      return false;
    }
  }

  /**
   * Stops the host run of a task whose pending stop is held only in memory, as the task's row may
   * not know that run. Throws while the host cannot confirm, so a deletion that needs it waits.
   */
  async stopUnsavedHostRun(taskId: string): Promise<void> {
    const unsaved = this.unsavedStops.get(taskId);
    if (!unsaved) return;
    await this.cancelRemoteRun(unsaved.task);
    this.unsavedStops.delete(taskId);
  }

  /** Stops the host run of a task that already ended here, until the host confirms. */
  private async retryPendingStop(task: OrchestrationTaskRecord): Promise<void> {
    try {
      await this.cancelRemoteRun(task);
    } catch (error) {
      this.logControllerWarn("A linked host has not confirmed that it stopped an ended task's run yet.", { taskId: task.id, error });
      return;
    }
    this.unsavedStops.delete(task.id);
    try {
      await this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
        const current = this.db.findOrchestrationTask(task.id);
        if (!current?.remote) return;
        this.db.updateOrchestrationTask(task.id, { remote: { ...current.remote, stopPending: false } });
        await this.db.flushDurable();
      });
    } catch (error) {
      // The run is stopped; a flag left set only asks the host once more, which it answers again.
      this.logControllerWarn("Could not record that a linked host stopped an ended task's run.", { taskId: task.id, error });
    }
  }

  /** Retries a cancellation that the host could not confirm before. */
  private async retryPendingCancellation(task: OrchestrationTaskRecord): Promise<boolean> {
    if (this.db.listPendingOrchestrationEffects({ taskId: task.id, kind: "cancel-child" }).length === 0) return false;
    try {
      await this.services.orchestration.orchestrationRuntimeActions.cancel([task]);
      this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
    } catch (error) {
      this.logControllerWarn("A linked host has not confirmed a remote task's cancellation yet.", { taskId: task.id, error });
    }
    return true;
  }

  /** Called at startup: remote tasks outlive the app, so their polling starts again. */
  resumeRemoteTasks(): void {
    if (this.db.listActiveRemoteOrchestrationTasks().length > 0 || this.db.listRemoteOrchestrationTasksAwaitingStop().length > 0) this.ensurePolling();
  }

  ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.pollRemoteTasks(); }, REMOTE_TASK_POLL_MS);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
