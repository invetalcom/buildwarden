import {
  APP_SETTING_KEYS,
  commandToExactShellPatternSource,
  parseShellAllowlistExtraSetting,
  parseToolApprovalAllowlistSetting,
  type RunRecord,
  type RunUserInputAnswers,
  type RunUserInputQuestion,
  type ShellApprovalDecision,
  type ShellApprovalRespondOptions,
} from "@buildwarden/shared";
import { AppService } from "./app-service";
import type { RunWorkerPayload } from "./worker-payloads";

const SHELL_APPROVAL_DECISION_MESSAGES: Record<string, { title: string; content: string }> = {
  deny: { title: "Shell command denied", content: "The requested shell command was denied." },
  "allow-for-run": {
    title: "Shell command allowed for run",
    content: "The requested shell command was allowed and will stay allowed for this run.",
  },
  "allow-always": {
    title: "Shell command allowed and saved to settings",
    content:
      "The requested shell command was allowed. An exact-match pattern was added to Settings > Projects & Workspace > Shell allowlist.",
  },
  "allow-once": { title: "Shell command allowed once", content: "The requested shell command was allowed once." },
};

/** Handles approval and question requests of run workers. */
export class RunInteractionService extends AppService<"activeWorkers" | "orchestration" | "orchestrationCoordinator" | "runEvents"> {
  private readonly runShellApprovalStepIds = new Map<string, string>();
  private readonly runUserInputStepIds = new Map<string, string>();
  /** What each provider account's latest session reported about the installed agent. */
  /** Tool identity of open non-shell approval requests, keyed like {@link runShellApprovalStepIds}. */
  private readonly runToolApprovalKeys = new Map<string, string>();
  /** Open approval requests (by step key) that may only be allowed once. */
  private readonly runOnceOnlyApprovals = new Set<string>();

  async cancelRunShell(runId: string, toolCallId: string): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      return;
    }

    active.worker.postMessage({ type: "cancel-shell", callId: toolCallId });
  }

  async respondToShellApproval(
    runId: string,
    requestId: string,
    requestedDecision: ShellApprovalDecision,
    options?: ShellApprovalRespondOptions,
  ): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    // An action with nothing specific to remember can only be allowed this once.
    const onceOnly = this.runOnceOnlyApprovals.delete(this.shellApprovalStepKey(runId, requestId));
    const decision: ShellApprovalDecision = onceOnly && requestedDecision !== "deny" ? "allow-once" : requestedDecision;
    const approvalKey = this.runToolApprovalKeys.get(this.shellApprovalStepKey(runId, requestId));
    if (decision === "allow-always" && approvalKey) {
      // A tool approval is stored by tool identity, apart from shell patterns, so it can never
      // be matched against a shell command.
      const projectId = this.db.getRun(runId).projectId;
      const lists = parseToolApprovalAllowlistSetting(this.db.getSettings()[APP_SETTING_KEYS.toolApprovalAllowlist]);
      const keys = lists[projectId] ?? [];
      if (!keys.includes(approvalKey)) {
        lists[projectId] = [...keys, approvalKey];
        this.db.setSetting(APP_SETTING_KEYS.toolApprovalAllowlist, JSON.stringify(lists));
      }
    } else if (decision === "allow-always") {
      const cmd = options?.command?.trim();
      if (!cmd) {
        throw new Error('A command is required when choosing "always allow" (save to settings).');
      }
      const pattern = commandToExactShellPatternSource(cmd);
      const list = parseShellAllowlistExtraSetting(this.db.getSettings()[APP_SETTING_KEYS.shellAllowlistExtra]);
      if (!list.includes(pattern)) {
        list.push(pattern);
        this.db.setSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(list));
      }
    }
    this.runToolApprovalKeys.delete(this.shellApprovalStepKey(runId, requestId));

    active.worker.postMessage({
      type: "shell-approval-response",
      requestId,
      decision,
    });

    const { title, content } = SHELL_APPROVAL_DECISION_MESSAGES[decision] ?? SHELL_APPROVAL_DECISION_MESSAGES["allow-once"];

    const metadata = {
      requestKind: "approval",
      requestStatus: "resolved",
      shellApprovalDecision: decision,
      approvalRequestId: requestId,
      approvalResolutionMessage: content,
    };
    const approvalStepId = this.runShellApprovalStepIds.get(this.shellApprovalStepKey(runId, requestId));
    if (approvalStepId) {
      this.db.updateRunStep(approvalStepId, {
        title,
        metadataJson: JSON.stringify(metadata),
      });
      this.runShellApprovalStepIds.delete(this.shellApprovalStepKey(runId, requestId));
    } else {
      await this.services.runEvents.appendRunEvent(runId, "approval-resolved", title, content, metadata);
    }
    this.services.runEvents.emitEvent({
      runId,
      type: "approval-resolved",
      title,
      content,
      metadata: {
        requestKind: "approval",
        requestStatus: "resolved",
        shellApprovalDecision: decision,
        approvalRequestId: requestId,
        approvalResolutionMessage: content,
      },
      createdAt: new Date().toISOString(),
    });
    this.resolveChildTaskAttention(runId, "Approval resolved", content);
  }

  /** Records an answered request of a child; its task runs on once no other request waits. */
  private resolveChildTaskAttention(runId: string, title: string, content: string): void {
    const task = this.db.getOrchestrationTaskByChildRunId(runId);
    if (task?.status !== "waiting-input") return;
    const prefix = `${runId}:`;
    const stillWaiting = [...this.runShellApprovalStepIds.keys(), ...this.runUserInputStepIds.keys()].some((key) => key.startsWith(prefix));
    if (!stillWaiting) this.db.updateOrchestrationTask(task.id, { status: "running", attentionReason: null });
    this.db.appendOrchestrationEvent({ orchestrationId: task.orchestrationId, taskId: task.id, type: "attention-resolved", title, content });
    this.services.orchestration.emitOrchestrationChanged(task.orchestrationId, task.id);
  }

  async respondToRunUserInput(
    runId: string,
    requestId: string,
    answers: RunUserInputAnswers,
    answeredBy: "user" | "coordinator" = "user",
  ): Promise<void> {
    const active = this.services.activeWorkers.runWorkers.get(runId);
    if (!active) {
      throw new Error("This run is no longer active.");
    }

    active.worker.postMessage({
      type: "user-input-response",
      requestId,
      answers,
    });

    const content = this.formatRunUserInputAnswers(answers);
    const title = answeredBy === "coordinator" ? "Coordinator answered" : "User input submitted";
    const metadata = {
      requestKind: "user-input",
      requestStatus: "resolved",
      userInputRequestId: requestId,
      userInputAnswers: answers,
      ...(answeredBy === "coordinator" ? { answeredBy } : {}),
    };
    const stepKey = this.userInputStepKey(runId, requestId);
    const stepId = this.runUserInputStepIds.get(stepKey);
    if (stepId) {
      let existingMetadata: Record<string, unknown> = {};
      try {
        existingMetadata = JSON.parse(this.db.getRunSteps(runId).find((step) => step.id === stepId)?.metadataJson || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        /* keep response metadata even if the stored request metadata is malformed */
      }
      this.db.updateRunStep(stepId, {
        title,
        metadataJson: JSON.stringify({
          ...existingMetadata,
          ...metadata,
        }),
      });
      this.runUserInputStepIds.delete(stepKey);
    } else {
      await this.services.runEvents.appendRunEvent(runId, "user-input-requested", title, content, metadata);
    }
    this.services.runEvents.emitEvent({
      runId,
      type: "user-input-requested",
      title,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    });
    this.resolveChildTaskAttention(runId, title, content);
  }

  async handleRunWorkerShellApprovalRequest(
    run: RunRecord,
    payload: Extract<RunWorkerPayload, { type: "shell-approval-request" }>,
  ): Promise<void> {
    if (run.kind === "council-review") {
      // Nobody is watching a reviewer, and reading files needs no approval.
      this.services.activeWorkers.runWorkers.get(run.id)?.worker.postMessage({ type: "shell-approval-response", requestId: payload.requestId, decision: "deny" });
      return;
    }
    const approvalKey = typeof payload.approvalKey === "string" && /^(mcp|acp):/.test(payload.approvalKey) ? payload.approvalKey : undefined;
    const metadata = {
      requestKind: "approval",
      requestStatus: "opened",
      approvalRequestId: payload.requestId,
      shellApprovalRequest: true,
      command: payload.command,
      ...(approvalKey ? { toolApprovalKey: approvalKey } : {}),
      ...(payload.onceOnly === true ? { approvalOnceOnly: true } : {}),
    };
    const title = approvalKey ? "Tool approval requested" : "Shell approval requested";
    const step = await this.services.runEvents.appendRunEvent(
      run.id,
      "approval-requested",
      title,
      payload.command,
      metadata,
    );
    this.runShellApprovalStepIds.set(this.shellApprovalStepKey(run.id, payload.requestId), step.id);
    if (approvalKey) this.runToolApprovalKeys.set(this.shellApprovalStepKey(run.id, payload.requestId), approvalKey);
    if (payload.onceOnly === true) this.runOnceOnlyApprovals.add(this.shellApprovalStepKey(run.id, payload.requestId));
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "approval-requested",
      title,
      content: payload.command,
      metadata,
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.db.getOrchestrationTaskByChildRunId(run.id);
    if (!orchestrationTask) {
      return;
    }
    this.db.updateOrchestrationTask(orchestrationTask.id, {
      status: "waiting-input",
      attentionReason: `Shell approval required: ${payload.command}`,
    });
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestrationTask.orchestrationId,
      taskId: orchestrationTask.id,
      type: "attention",
      title: "Child needs shell approval",
      content: payload.command,
    });
    await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
  }

  async handleRunWorkerUserInputRequest(
    run: RunRecord,
    payload: Extract<RunWorkerPayload, { type: "user-input-request" }>,
  ): Promise<void> {
    if (run.kind === "council-review") {
      // A reviewer that waits for an answer would only hold up the round until its deadline.
      await this.services.activeWorkers.cancelRunWorker(run.id);
      return;
    }
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const content =
      payload.content?.trim() ||
      this.formatRunUserInputQuestions(questions) ||
      "The provider requested more input before it can continue.";
    const title = payload.title?.trim() || "User input requested";
    const metadata = {
      ...(payload.metadata ?? {}),
      requestKind: "user-input",
      requestStatus: "opened",
      userInputRequest: true,
      userInputRequestId: payload.requestId,
      requestId: payload.requestId,
      userInputQuestions: questions,
    };
    const step = await this.services.runEvents.appendRunEvent(run.id, "user-input-requested", title, content, metadata);
    this.runUserInputStepIds.set(this.userInputStepKey(run.id, payload.requestId), step.id);
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "user-input-requested",
      title,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    });
    const orchestrationTask = this.db.getOrchestrationTaskByChildRunId(run.id);
    if (!orchestrationTask) {
      return;
    }
    this.db.updateOrchestrationTask(orchestrationTask.id, {
      status: "waiting-input",
      attentionReason: title === "User input requested" ? "The child requested user input." : title,
    });
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestrationTask.orchestrationId,
      taskId: orchestrationTask.id,
      type: "attention",
      title: "Child needs user input",
      content,
      metadata: { kind: "user-input", inputRequestId: payload.requestId },
    });
    await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(orchestrationTask.orchestrationId);
    this.services.orchestration.emitOrchestrationChanged(orchestrationTask.orchestrationId, orchestrationTask.id);
  }

  private shellApprovalStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  private userInputStepKey(runId: string, requestId: string): string {
    return `${runId}:${requestId}`;
  }

  clearRunRequestStepIds(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.runShellApprovalStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runShellApprovalStepIds.delete(key);
      }
    }
    for (const key of [...this.runToolApprovalKeys.keys(), ...this.runOnceOnlyApprovals]) {
      if (key.startsWith(prefix)) {
        this.runToolApprovalKeys.delete(key);
        this.runOnceOnlyApprovals.delete(key);
      }
    }
    for (const key of this.runUserInputStepIds.keys()) {
      if (key.startsWith(prefix)) {
        this.runUserInputStepIds.delete(key);
      }
    }
  }

  private formatRunUserInputQuestions(questions: RunUserInputQuestion[]): string {
    return questions
      .map((question, index) => {
        const heading = question.header || `Question ${String(index + 1)}`;
        const options = question.options.map((option) => {
          const descriptionSuffix = option.description ? `: ${option.description}` : "";
          return `- ${option.label}${descriptionSuffix}`;
        });
        return [heading, question.question, ...options].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private formatRunUserInputAnswers(answers: RunUserInputAnswers): string {
    return Object.entries(answers)
      .map(([questionId, answer]) => `${questionId}: ${Array.isArray(answer) ? answer.join(", ") : answer}`)
      .join("\n");
  }
}
