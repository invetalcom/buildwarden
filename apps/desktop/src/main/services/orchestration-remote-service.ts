import {
  OrchestrationToolError,
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
    // Provisioning is saved before the host is asked, so a second pass never starts a second run.
    this.starting.add(task.id);
    this.db.updateOrchestrationTask(task.id, { status: "provisioning" });
    await this.db.flushDurable();
    try {
      await this.startOnHost(task, remote);
    } finally {
      this.starting.delete(task.id);
    }
  }

  private async startOnHost(task: OrchestrationTaskRecord, remote: OrchestrationTaskRemote): Promise<void> {
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
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
      await this.services.orchestration.withOrchestrationMutation(task.orchestrationId, async () => {
        this.db.updateOrchestrationTask(task.id, { status: "running", startedAt: new Date().toISOString(), remote: { ...remote, projectId, runId: started.run.id } });
        this.db.appendOrchestrationEvent({
          orchestrationId: task.orchestrationId, taskId: task.id, type: "task-started", title: task.title,
          content: `Started on ${remote.hostLabel} as run ${started.run.id}.`, metadata: { remoteHostId: remote.hostId, remoteRunId: started.run.id },
        });
        await this.db.flushDurable();
        this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
      });
      this.ensurePolling();
    } catch (error) {
      await this.settle(task.id, { status: "failed", summary: null, errorMessage: `${remote.hostLabel} could not start the task: ${error instanceof Error ? error.message : String(error)}` });
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

  /** Records a remote task's outcome as its published result and wakes the coordinator. */
  private async settle(taskId: string, outcome: { status: OrchestrationTaskStatus; summary: string | null; errorMessage: string | null }): Promise<void> {
    const { orchestrationId } = this.db.getOrchestrationTask(taskId);
    await this.services.orchestration.withOrchestrationMutation(orchestrationId, async () => {
      const task = this.db.getOrchestrationTask(taskId);
      if (["completed", "failed", "cancelled", "interrupted"].includes(task.status)) return;
      this.db.transaction(() => {
        const updated = this.db.updateOrchestrationTask(task.id, {
          status: outcome.status, summary: outcome.summary, errorMessage: outcome.errorMessage,
          attentionReason: outcome.status === "failed" ? outcome.errorMessage : null,
          finishedAt: new Date().toISOString(), remote: task.remote ? { ...task.remote, waitingFor: null } : null,
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
    });
  }

  /** Checks every remote task that is still going. Overlapping calls share one pass. */
  pollRemoteTasks(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const tasks = this.db.listActiveRemoteOrchestrationTasks();
    if (tasks.length === 0) {
      this.stopPolling();
      return;
    }
    for (const task of tasks) {
      const remote = task.remote!;
      if (!remote.runId) {
        if (task.status === "pending") await this.startRemoteTask(task.id);
        else if (task.status === "provisioning" && !this.starting.has(task.id)) {
          // The app stopped while asking the host; whether the host started a run is unknown.
          await this.settle(task.id, {
            status: "failed", summary: null,
            errorMessage: `BuildWarden stopped while starting this task on ${remote.hostLabel}. Check that host for a run before delegating it again.`,
          });
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
      const remote = task.remote!;
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

  /** Stops the host's run for a cancelled task. The task is cancelled here even when the host cannot be reached. */
  async cancelRemoteRun(task: OrchestrationTaskRecord): Promise<void> {
    if (!task.remote?.runId) return;
    try {
      await this.services.linkedHosts.callHostTool(task.remote.hostId, "cancel_run", { runId: task.remote.runId });
    } catch (error) {
      this.logControllerWarn("Could not cancel a remote task's run on its host.", { taskId: task.id, error });
    }
  }

  /** Called at startup: remote tasks outlive the app, so their polling starts again. */
  resumeRemoteTasks(): void {
    if (this.db.listActiveRemoteOrchestrationTasks().length > 0) this.ensurePolling();
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
