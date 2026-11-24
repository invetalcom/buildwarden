import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { QueuedFollowUpEntry } from "@buildwarden/db";
import {
  type ChatAttachmentPayload,
  effectiveHarnessCapabilities,
  type FollowUpChatOptions,
  type FollowUpDelivery,
  type FollowUpQueueAction,
  type FollowUpQueueOutcome,
  type FollowUpQueueOwnerKind,
  type FollowUpQueueResult,
  isSteerOutcomeUnknownError,
  MAX_QUEUED_FOLLOW_UPS,
  OrchestrationToolError,
  providerSupportsFollowUpSteering,
  type ProviderType,
  type RunFollowUpOptions,
  type RunRecord,
  SteerOutcomeUnknownError,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";
import { latestRunExecutionSettings, resolveProviderExecutionOptions, steerKeepsExecutionSettings } from "./run-execution-settings";
import type { WorkerSteerResultPayload } from "./worker-payloads";

/** Host-side wait for a worker to deliver steered input into its running turn. */
const FOLLOW_UP_STEER_TIMEOUT_MS = 20_000;

const UNCERTAIN_FOLLOW_UP_MESSAGE =
  "It stays queued but will not send on its own, so it cannot reach the agent twice. Send it again or remove it.";

/** Queues, steers and delivers follow-up messages. */
export class FollowUpQueueService extends AppService<
  | "activeWorkers"
  | "chats"
  | "providerRuntime"
  | "runEvents"
  | "runTurns"
  | "turnState"
  | "workspaceGuard"
> {
  /** Live steering this run's integration implements, narrowed by what its session reported. */
  acceptsLiveSteering(runId: string | null, providerType: ProviderType | null | undefined): boolean {
    if (!providerType || !providerSupportsFollowUpSteering(providerType)) return false;
    return effectiveHarnessCapabilities(providerType, runId ? this.services.providerRuntime.runSessionCapabilities.get(runId) : null).liveSteering;
  }

  /** Owners (`kind:id`) whose follow-up queue is currently starting its next entry. */
  private readonly followUpQueueDispatches = new Set<string>();
  private readonly pendingFollowUpSteers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  async queueRunFollowUp(
    runId: string,
    prompt: string,
    options?: RunFollowUpOptions,
    delivery: FollowUpDelivery = "queue",
  ): Promise<FollowUpQueueResult> {
    this.db.getRun(runId);
    this.services.workspaceGuard.requireWorkspaceNotRestoring(this.db.getRun(runId).worktreePath);
    return this.queueFollowUp("run", runId, prompt, options ?? {}, delivery);
  }

  async updateRunFollowUpQueue(runId: string, action: FollowUpQueueAction): Promise<FollowUpQueueResult> {
    this.db.getRun(runId);
    return this.updateFollowUpQueue("run", runId, action);
  }

  async queueChatFollowUp(
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
    delivery: FollowUpDelivery = "queue",
  ): Promise<FollowUpQueueResult> {
    this.db.getChat(chatId);
    return this.queueFollowUp("chat", chatId, prompt, options ?? {}, delivery);
  }

  async updateChatFollowUpQueue(chatId: string, action: FollowUpQueueAction): Promise<FollowUpQueueResult> {
    this.db.getChat(chatId);
    return this.updateFollowUpQueue("chat", chatId, action);
  }

  private async queueFollowUp(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    prompt: string,
    options: RunFollowUpOptions | FollowUpChatOptions,
    delivery: FollowUpDelivery,
  ): Promise<FollowUpQueueResult> {
    const { attachments = [], ...executionOptions } = options;
    const text = prompt.trim();
    const updatesGoal = kind === "run" && Object.prototype.hasOwnProperty.call(executionOptions, "goalText");
    if (!text && attachments.length === 0 && !updatesGoal) {
      throw new Error(kind === "run" ? "Enter a follow-up command or attach at least one file." : "Enter a message or attach at least one file.");
    }
    validateChatAttachmentPayloads(attachments);
    if (executionOptions.modelId) this.db.getModel(executionOptions.modelId);
    if (this.db.listQueuedFollowUps(kind, ownerId).length >= MAX_QUEUED_FOLLOW_UPS) {
      throw new Error(`At most ${MAX_QUEUED_FOLLOW_UPS} follow-ups can wait in the queue. Send or remove one first.`);
    }
    const entry = this.db.enqueueFollowUp({
      ownerKind: kind,
      ownerId,
      prompt: text,
      options: JSON.parse(JSON.stringify(executionOptions)) as Record<string, unknown>,
      attachments,
    });
    this.emitFollowUpQueueChanged(kind, ownerId);

    let steerError: string | undefined;
    let steerOutcomeUnknown = false;
    if (delivery === "steer" && this.isFollowUpOwnerActive(kind, ownerId)) {
      try {
        const notice = await this.steerQueuedFollowUp(entry);
        return { queue: this.db.listQueuedFollowUps(kind, ownerId), outcome: "steered", ...(notice ? { notice } : {}) };
      } catch (error) {
        steerError = error instanceof Error ? error.message : String(error);
        steerOutcomeUnknown = isSteerOutcomeUnknownError(error);
      }
    }
    // An idle owner starts its queue right away, oldest entry first, so ordering holds.
    const started = await this.dispatchQueuedFollowUps(kind, ownerId);
    return {
      queue: this.db.listQueuedFollowUps(kind, ownerId),
      outcome: started.includes(entry.record.id) ? "started" : "queued",
      ...(steerError ? { steerError } : {}),
      ...(steerOutcomeUnknown ? { steerOutcomeUnknown } : {}),
    };
  }

  private async updateFollowUpQueue(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    action: FollowUpQueueAction,
  ): Promise<FollowUpQueueResult> {
    let outcome: FollowUpQueueOutcome = "updated";
    let steerError: string | undefined;
    let steerOutcomeUnknown = false;
    let notice: string | undefined;
    switch (action.type) {
      case "edit": {
        const entry = this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        const text = action.prompt.trim();
        if (!text && entry.attachments.length === 0 && !entry.record.updatesGoal) {
          throw new Error("A queued follow-up needs text or at least one attachment.");
        }
        this.db.updateQueuedFollowUpPrompt(entry.record.id, text);
        break;
      }
      case "move":
        this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        this.db.moveQueuedFollowUp(action.queuedFollowUpId, action.direction === "up" ? "up" : "down");
        break;
      case "delete":
        this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        this.db.deleteQueuedFollowUp(action.queuedFollowUpId);
        break;
      case "send-now": {
        const entry = this.requireQueuedFollowUp(kind, ownerId, action.queuedFollowUpId);
        // Sending an uncertain entry again is the user's explicit decision.
        if (entry.deliveryState === "uncertain") {
          this.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
          entry.deliveryState = null;
        }
        if (this.isFollowUpOwnerActive(kind, ownerId)) {
          try {
            notice = await this.steerQueuedFollowUp(entry);
            outcome = "steered";
          } catch (error) {
            steerError = error instanceof Error ? error.message : String(error);
            steerOutcomeUnknown = isSteerOutcomeUnknownError(error);
            this.db.moveQueuedFollowUp(entry.record.id, "front");
            outcome = "moved-to-front";
          }
          break;
        }
        this.db.moveQueuedFollowUp(entry.record.id, "front");
        const started = await this.dispatchQueuedFollowUps(kind, ownerId, { rethrow: true });
        outcome = started.includes(entry.record.id) ? "started" : "moved-to-front";
        break;
      }
      case "resume": {
        const started = await this.dispatchQueuedFollowUps(kind, ownerId, { rethrow: true });
        if (started.length > 0) outcome = "started";
        break;
      }
      default:
        throw new Error("Unsupported follow-up queue action.");
    }
    this.emitFollowUpQueueChanged(kind, ownerId);
    return {
      queue: this.db.listQueuedFollowUps(kind, ownerId),
      outcome,
      ...(steerError ? { steerError } : {}),
      ...(steerOutcomeUnknown ? { steerOutcomeUnknown } : {}),
      ...(notice ? { notice } : {}),
    };
  }

  private requireQueuedFollowUp(kind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): QueuedFollowUpEntry {
    const entry = typeof queuedFollowUpId === "string" ? this.db.getQueuedFollowUpEntry(queuedFollowUpId) : null;
    const delivering = entry?.deliveryState === "starting" || entry?.deliveryState === "steering";
    if (!entry || delivering || entry.ownerKind !== kind || entry.ownerId !== ownerId) {
      throw new Error("This queued follow-up was already sent or removed.");
    }
    return entry;
  }

  private isFollowUpOwnerActive(kind: FollowUpQueueOwnerKind, ownerId: string): boolean {
    if (kind === "run") {
      if (this.services.activeWorkers.runWorkers.has(ownerId) || this.services.workspaceGuard.manualVerifications.has(ownerId)) return true;
      return ACTIVE_RUN_STATUSES.has(this.db.getRun(ownerId).status);
    }
    if (this.services.activeWorkers.chatWorkers.has(ownerId)) return true;
    return ACTIVE_RUN_STATUSES.has(this.db.getChat(ownerId).status);
  }

  private followUpOwnerExists(kind: FollowUpQueueOwnerKind, ownerId: string): boolean {
    try {
      if (kind === "run") this.db.getRun(ownerId);
      else this.db.getChat(ownerId);
      return true;
    } catch {
      return false;
    }
  }

  dispatchQueuedFollowUpsInBackground(kind: FollowUpQueueOwnerKind, ownerId: string): void {
    void this.dispatchQueuedFollowUps(kind, ownerId).catch((error) => {
      this.logControllerError("Could not start a queued follow-up.", error, { ownerKind: kind, ownerId });
    });
  }

  /**
   * Starts queued follow-ups, oldest first, while the owner is idle. An entry is marked
   * `starting` (and hidden) while its turn starts and is deleted only once the turn runs; a
   * failed start returns it to the queue, which holds until the user resumes. An entry whose
   * steering could not be confirmed also holds the queue. Returns the ids that started.
   */
  private async dispatchQueuedFollowUps(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    options: { rethrow?: boolean } = {},
  ): Promise<string[]> {
    const key = `${kind}:${ownerId}`;
    if (this.followUpQueueDispatches.has(key)) return [];
    this.followUpQueueDispatches.add(key);
    const started: string[] = [];
    try {
      while (!this.services.activeWorkers.agentWorkersStopping && this.followUpOwnerExists(kind, ownerId) && !this.isFollowUpOwnerActive(kind, ownerId)) {
        const next = this.db.listQueuedFollowUpEntries(kind, ownerId)[0];
        if (!next) break;
        if (next.deliveryState === "uncertain") {
          if (options.rethrow) {
            throw new Error(`The next queued follow-up may already have reached the agent. ${UNCERTAIN_FOLLOW_UP_MESSAGE}`);
          }
          break;
        }
        this.db.setQueuedFollowUpDeliveryState(next.record.id, "starting");
        this.emitFollowUpQueueChanged(kind, ownerId);
        try {
          await this.startQueuedFollowUp(next);
          // Follow-ups that only update the goal finish without a worker to accept them.
          this.db.deleteQueuedFollowUp(next.record.id);
          this.emitFollowUpQueueChanged(kind, ownerId);
          started.push(next.record.id);
        } catch (error) {
          if (!this.followUpOwnerExists(kind, ownerId)) break;
          // Another caller may hold the owner's worker, so only this attempt's acceptance counts.
          if (!this.db.getQueuedFollowUpEntry(next.record.id)) {
            this.emitFollowUpQueueChanged(kind, ownerId);
            started.push(next.record.id);
            this.logControllerWarn("A queued follow-up started but reported an error.", { ownerKind: kind, ownerId, error });
            break;
          }
          // The turn did not start: withdraw the user step this attempt wrote so a retry does
          // not repeat it, and keep the entry queued for another attempt.
          this.withdrawQueuedFollowUpSteps(kind, ownerId, next.record.id);
          this.db.setQueuedFollowUpDeliveryState(next.record.id, null);
          this.emitFollowUpQueueChanged(kind, ownerId);
          await this.reportQueuedFollowUpFailure(kind, ownerId, error);
          if (options.rethrow) throw error;
          break;
        }
      }
    } finally {
      this.followUpQueueDispatches.delete(key);
    }
    return started;
  }

  /**
   * Called in the tick a worker registers for a follow-up. A queued entry is deleted here, so
   * its absence proves that this attempt, not another caller, delivered the message.
   */
  acceptQueuedFollowUp(extraLogMetadata: Record<string, unknown> | undefined): void {
    const queuedFollowUpId = extraLogMetadata?.queuedFollowUpId;
    if (typeof queuedFollowUpId === "string") this.db.deleteQueuedFollowUp(queuedFollowUpId);
  }

  private async startQueuedFollowUp(entry: QueuedFollowUpEntry): Promise<void> {
    const options = {
      ...entry.options,
      ...(entry.attachments.length ? { attachments: entry.attachments } : {}),
    };
    const metadata = { queuedFollowUpId: entry.record.id };
    if (entry.ownerKind === "run") {
      await this.services.runTurns.followUpRun(entry.ownerId, entry.record.prompt, options as RunFollowUpOptions, metadata);
    } else {
      await this.services.chats.followUpChat(entry.ownerId, entry.record.prompt, options as FollowUpChatOptions, metadata);
    }
  }

  /**
   * Settles queue entries whose delivery was cut off by an app restart.
   *
   * - Starting: a worker deletes the entry when it accepts the turn, so a surviving entry
   *   never reached the agent. Its user step is withdrawn and it waits for another attempt.
   * - Steering: the step is written only after the provider confirmed the input, so it is
   *   proof; without it the agent may or may not have the message, so it waits for the user.
   */
  reconcileInterruptedFollowUpDeliveries(): void {
    for (const entry of this.db.listQueuedFollowUpEntriesInDelivery()) {
      const { ownerKind: kind, ownerId } = entry;
      if (!this.followUpOwnerExists(kind, ownerId)) {
        this.db.deleteQueuedFollowUp(entry.record.id);
        continue;
      }
      if (entry.deliveryState === "steering") {
        if (this.db.hasStepForQueuedFollowUp(kind, ownerId, entry.record.id)) this.db.deleteQueuedFollowUp(entry.record.id);
        else this.db.setQueuedFollowUpDeliveryState(entry.record.id, "uncertain");
        continue;
      }
      this.db.deleteStepsForQueuedFollowUp(kind, ownerId, entry.record.id);
      this.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
    }
  }

  /** Drops the steps of an undelivered attempt and tells clients to reload the transcript. */
  private withdrawQueuedFollowUpSteps(kind: FollowUpQueueOwnerKind, ownerId: string, queuedFollowUpId: string): void {
    if (this.db.deleteStepsForQueuedFollowUp(kind, ownerId, queuedFollowUpId) === 0) return;
    const event = {
      runId: ownerId,
      type: "status" as const,
      title: "Follow-up withdrawn",
      content: "",
      metadata: { silent: true, queuedFollowUpWithdrawn: queuedFollowUpId },
      createdAt: new Date().toISOString(),
    };
    if (kind === "run") this.services.runEvents.emitEvent(event);
    else this.services.runEvents.emitChatEvent(ownerId, event);
  }

  private async reportQueuedFollowUpFailure(kind: FollowUpQueueOwnerKind, ownerId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const content = `${message}\nThe follow-up stays queued. Edit it, remove it, or resume the queue.`;
    const metadata = { followUpQueue: true, userFacing: true };
    this.logControllerWarn("A queued follow-up could not start.", { ownerKind: kind, ownerId, error: message });
    try {
      if (kind === "run") {
        const step = await this.services.runEvents.appendRunEvent(ownerId, "error", "Queued follow-up held", content, metadata);
        this.services.runEvents.emitEvent({ runId: ownerId, type: "error", title: step.title, content, metadata, createdAt: step.createdAt, step });
      } else {
        const step = await this.services.runEvents.appendChatEvent(ownerId, "error", "Queued follow-up held", content, metadata);
        this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "error", title: step.title, content, metadata, createdAt: step.createdAt, step });
      }
    } catch (reportError) {
      this.logControllerError("Could not record the held follow-up.", reportError, { ownerKind: kind, ownerId });
    }
  }

  /**
   * Delivers a queued follow-up into the running turn. Refuses (leaving the entry queued)
   * when the turn cannot take it unchanged; an unconfirmed delivery marks it uncertain.
   * Returns a note when the turn keeps execution settings the follow-up asked to change.
   */
  private async steerQueuedFollowUp(entry: QueuedFollowUpEntry): Promise<string | undefined> {
    const { ownerKind: kind, ownerId } = entry;
    const active = (kind === "run" ? this.services.activeWorkers.runWorkers : this.services.activeWorkers.chatWorkers).get(ownerId);
    if (!active || active.cancelled) throw new OrchestrationToolError("delivery_unavailable", "The agent is not running a turn that can take this message.");
    if (!this.acceptsLiveSteering(kind === "run" ? ownerId : null, active.providerType)) {
      throw new OrchestrationToolError("delivery_unavailable", "This provider cannot take messages during a turn. The follow-up waits for the turn to finish.");
    }
    if (entry.record.updatesGoal) throw new Error("Goal updates wait for the current turn to finish.");
    const owner = kind === "run" ? this.db.getRun(ownerId) : this.db.getChat(ownerId);
    const requestedModelId = typeof entry.options.modelId === "string" ? entry.options.modelId : null;
    if (requestedModelId && requestedModelId !== owner.modelId) {
      throw new Error("A model change waits for the current turn to finish.");
    }
    const requestedMode = typeof entry.options.mode === "string" ? entry.options.mode : null;
    if (kind === "run" && requestedMode && requestedMode !== (owner as RunRecord).mode) {
      throw new Error("A mode change waits for the current turn to finish.");
    }
    // A steered message runs with the permissions of the running turn, so Full access changes wait.
    if (kind === "run" && typeof entry.options.yoloMode === "boolean" &&
      entry.options.yoloMode !== (latestRunExecutionSettings(this.db.getRunSteps(ownerId))?.yoloMode === true)) {
      throw new Error("A Full access change waits for the current turn to finish.");
    }
    const provider = this.db.getProviderAccount(owner.providerAccountId);
    const currentExecution = kind === "run"
      ? this.services.turnState.getLatestRunExecutionOptions(ownerId, provider)
      : this.services.turnState.getLatestChatExecutionOptions(ownerId, provider);
    const notice = steerKeepsExecutionSettings(resolveProviderExecutionOptions(provider, entry.options), currentExecution)
      ? "Sent into the running turn, which keeps its current reasoning and speed settings."
      : undefined;

    // Hidden while in flight so a turn ending meanwhile cannot also start it; the row stays
    // persisted so a restart can still recover the message.
    this.db.setQueuedFollowUpDeliveryState(entry.record.id, "steering");
    this.emitFollowUpQueueChanged(kind, ownerId);
    try {
      await this.requestWorkerSteer(active.worker, entry.record.prompt, entry.attachments);
    } catch (error) {
      if (!this.followUpOwnerExists(kind, ownerId)) throw error;
      if (isSteerOutcomeUnknownError(error)) {
        this.db.setQueuedFollowUpDeliveryState(entry.record.id, "uncertain");
        this.emitFollowUpQueueChanged(kind, ownerId);
        const message = error instanceof Error ? error.message : String(error);
        await this.reportUncertainFollowUp(kind, ownerId, entry, message);
        throw new SteerOutcomeUnknownError(`${message} ${UNCERTAIN_FOLLOW_UP_MESSAGE}`);
      }
      this.db.setQueuedFollowUpDeliveryState(entry.record.id, null);
      this.emitFollowUpQueueChanged(kind, ownerId);
      throw error;
    }
    const content = entry.record.prompt || "(no text)";
    const metadata = {
      source: "user",
      commandType: "steer",
      steered: true,
      queuedFollowUpId: entry.record.id,
      modelId: owner.modelId,
      providerAccountId: owner.providerAccountId,
      ...this.services.runEvents.buildStoredAttachmentMetadata(entry.attachments),
    };
    try {
      if (kind === "run") {
        const step = await this.services.runEvents.appendRunEvent(ownerId, "log", "Follow-up command", content, metadata);
        this.services.runEvents.emitEvent({ runId: ownerId, type: "log", title: step.title, content, metadata, createdAt: step.createdAt, step });
      } else {
        const step = await this.services.runEvents.appendChatEvent(ownerId, "log", "Follow-up", content, metadata);
        this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "log", title: step.title, content, metadata, createdAt: step.createdAt, step });
      }
    } catch (error) {
      // The agent has the message. A missing transcript step must not leave the entry in flight.
      this.logControllerError("Could not record a delivered steered message.", error, { ownerKind: kind, ownerId });
    }
    this.db.deleteQueuedFollowUp(entry.record.id);
    this.emitFollowUpQueueChanged(kind, ownerId);
    return notice;
  }

  private async reportUncertainFollowUp(
    kind: FollowUpQueueOwnerKind,
    ownerId: string,
    entry: QueuedFollowUpEntry,
    reason: string,
  ): Promise<void> {
    const title = "Steered message unconfirmed";
    const content = [
      `BuildWarden could not confirm that the running turn took this message: ${reason}`,
      entry.record.prompt ? `> ${entry.record.prompt.split("\n")[0]}` : "",
      UNCERTAIN_FOLLOW_UP_MESSAGE,
    ].filter(Boolean).join("\n");
    const metadata = { followUpQueue: true, userFacing: true, queuedFollowUpUncertain: entry.record.id };
    try {
      if (kind === "run") {
        const step = await this.services.runEvents.appendRunEvent(ownerId, "status", title, content, metadata);
        this.services.runEvents.emitEvent({ runId: ownerId, type: "status", title, content, metadata, createdAt: step.createdAt, step });
      } else {
        const step = await this.services.runEvents.appendChatEvent(ownerId, "status", title, content, metadata);
        this.services.runEvents.emitChatEvent(ownerId, { runId: ownerId, type: "status", title, content, metadata, createdAt: step.createdAt, step });
      }
    } catch (reportError) {
      this.logControllerError("Could not record the unconfirmed steered message.", reportError, { ownerKind: kind, ownerId });
    }
  }

  requestWorkerSteer(worker: Worker, prompt: string, attachments: ChatAttachmentPayload[]): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("exit", onExit);
        this.pendingFollowUpSteers.delete(requestId);
      };
      // Once posted, the worker may already have handed the message to the provider.
      const onExit = () => {
        cleanup();
        reject(new SteerOutcomeUnknownError("The turn ended before confirming the message."));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SteerOutcomeUnknownError("The running turn did not confirm the message in time."));
      }, FOLLOW_UP_STEER_TIMEOUT_MS);
      worker.once("exit", onExit);
      this.pendingFollowUpSteers.set(requestId, {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      try {
        worker.postMessage({ type: "steer", requestId, prompt, attachments });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  settleFollowUpSteer(payload: WorkerSteerResultPayload): void {
    const pending = this.pendingFollowUpSteers.get(payload.requestId);
    if (!pending) return;
    if (payload.error) pending.reject(payload.outcomeUnknown ? new SteerOutcomeUnknownError(payload.error) : new Error(payload.error));
    else pending.resolve();
  }

  private emitFollowUpQueueChanged(kind: FollowUpQueueOwnerKind, ownerId: string): void {
    if (!this.followUpOwnerExists(kind, ownerId)) return;
    const event = {
      runId: ownerId,
      type: "status" as const,
      title: "Follow-up queue updated",
      content: "",
      metadata: { silent: true, followUpQueue: true, queuedFollowUps: this.db.listQueuedFollowUps(kind, ownerId) },
      createdAt: new Date().toISOString(),
    };
    if (kind === "run") this.services.runEvents.emitEvent(event);
    else this.services.runEvents.emitChatEvent(ownerId, event);
  }
}
