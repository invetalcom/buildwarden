import { randomUUID } from "node:crypto";
import { BuildWardenDatabase } from "@buildwarden/db";
import {
  type ChatAttachmentPayload,
  type ChatRecord,
  type ChatStepRecord,
  EFFORT_CHANGE_STEP_TITLE,
  formatEffortChangeContent,
  formatModelHandoffContent,
  MODEL_HANDOFF_STEP_TITLE,
  type ModelHandoffContext,
  type ModelHandoffMetadata,
  type ModelRecord,
  type ProviderAccountRecord,
  type ProviderExecutionOptions,
  type ProviderSessionRuntimeInput,
  type ProviderSessionRuntimeRecord,
  readTurnEffort,
  resolveEffortChange,
  type RunPromptRestorePoint,
  type RunRecord,
  type RunResumeCheckpoint,
} from "@buildwarden/shared";
import { sessionMatchesWorkspace } from "../chat-session-migration";
import { getChatWorkspacePath } from "../chat-workspace";
import { getHarnessTypeForProvider } from "../harness-adapters";
import {
  buildContextHandoffBlock,
  latestTurnMetadata,
  planContextHandoff,
  providerUsesNativeSession,
  selectResumableSession,
  turnsSinceAccountLastTurn,
} from "../provider-context-handoff";
import { runAssistantSourceText } from "../run-chat-context";
import { AppService } from "./app-service";
import { latestRunExecutionSettings, resolveProviderExecutionOptions } from "./run-execution-settings";
import { buildPriorRunMessagesFromSteps, extractInitialRunAttachmentsFromSteps, parseMetadataRecord } from "./run-step-content";
import type { WorkerDoneResult } from "./worker-payloads";

const runCheckpointSettingKey = (runId: string) => `runCheckpoint:${runId}`;

/** Reads and writes what a turn needs to continue: checkpoints, restore points, native sessions and execution options. */
export class TurnStateStore extends AppService {
  /**
   * The full conversation, for a provider that may fail to reload its saved session and start
   * fresh. Only ACP agents do that silently; the adapter sends it only when the reload fails.
   */
  buildResumeFallbackContext(steps: ReturnType<BuildWardenDatabase["getRunSteps"]>, provider: ProviderAccountRecord): string | undefined {
    if (provider.providerType !== "acp") return undefined;
    return buildContextHandoffBlock(steps, planContextHandoff({
      steps,
      targetProviderType: provider.providerType,
      targetProviderAccountId: provider.id,
      resumesNativeSession: false,
      sessionSeenAt: null,
      resolveTurnAccount: this.createTurnAccountResolver(),
    })) || undefined;
  }

  buildRunFollowUpMemo(runId: string): string {
    const run = this.db.getRun(runId);
    const steps = this.db.getRunSteps(runId);
    const recentSteps = steps.slice(-10);
    const toolCalls = recentSteps
      .filter((step) => step.eventType === "tool-call")
      .slice(-4)
      .map((step) => {
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        return `- ${String(meta.toolName ?? step.title)}: ${step.content}`;
      });
    const recentErrors = recentSteps.filter((step) => step.eventType === "error").slice(-2).map((step) => `- ${step.content}`);
    const recentOutput = steps
      .map(runAssistantSourceText)
      .filter(Boolean)
      .at(-1)
      ?.replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    const checkpoint = this.getRunCheckpoint(runId);

    const parts = [
      "Run memory:",
      [...steps].reverse().find((step) => parseMetadataRecord(step.metadataJson).rewindMode === "conversation")
        ? "- The conversation was rewound while keeping file changes. Inspect current files; retained history may describe an earlier file state." : null,
      run.goalText ? `- Run goal: ${run.goalText}` : null,
      run.summary ? `- Last run summary: ${run.summary}` : null,
      recentOutput ? `- Latest agent output: ${recentOutput}` : null,
      toolCalls.length > 0 ? ["- Recent tool activity:", ...toolCalls].join("\n") : null,
      recentErrors.length > 0 ? ["- Recent errors:", ...recentErrors].join("\n") : null,
      checkpoint?.memo ? `- Latest checkpoint: ${checkpoint.memo}` : null,
      "- Continue from the current workspace state. Avoid repeating already-attempted steps unless needed.",
    ].filter(Boolean);

    return parts.join("\n");
  }

  /**
   * The native session the run may resume with `provider`. Sessions belong to the account that
   * created them, so switching accounts/providers never hands a foreign thread or session id to
   * a CLI. Returns no session when the target must start fresh.
   */
  resolveRunNativeSession(
    run: RunRecord,
    provider: ProviderAccountRecord,
  ): { session: ProviderSessionRuntimeRecord | null; previousResponseId: string | null } {
    if (!providerUsesNativeSession(provider.providerType)) {
      return { session: null, previousResponseId: run.lastProviderResponseId };
    }
    const session = selectResumableSession(
      this.db.getProviderAccountSessionRuntime(run.id, "run", provider.id),
      { providerAccountId: provider.id, providerType: provider.providerType },
    );
    // Codex declares dynamic tools when a thread starts; a thread created without the
    // orchestration tools cannot gain them, so delegation needs a fresh thread.
    const orchestrationToolsEnabled = Boolean(run.delegationEnabled) && run.kind !== "orchestration-task";
    const missingOrchestrationTools = provider.providerType === "codex-cli" && orchestrationToolsEnabled &&
      session?.runtimePayload?.orchestrationTools !== true;
    if (!session || missingOrchestrationTools || !session.resumeCursor) {
      return { session: null, previousResponseId: null };
    }
    return { session, previousResponseId: run.lastProviderResponseId };
  }

  /** Same rules for chats; a session that missed other accounts' turns is replaced by a fresh one with history. */
  resolveChatNativeSession(
    chat: ChatRecord,
    provider: ProviderAccountRecord,
    historySteps: ReadonlyArray<ChatStepRecord>,
  ): { session: ProviderSessionRuntimeRecord | null; previousResponseId: string | null } {
    if (!providerUsesNativeSession(provider.providerType)) {
      return { session: null, previousResponseId: chat.lastProviderResponseId };
    }
    const session = selectResumableSession(
      this.db.getProviderAccountSessionRuntime(chat.id, "chat", provider.id),
      { providerAccountId: provider.id, providerType: provider.providerType },
    );
    if (
      !session ||
      !session.resumeCursor ||
      // Claude/Cursor sessions cannot follow a chat into a different workspace.
      !sessionMatchesWorkspace(provider.providerType, session, getChatWorkspacePath(this.db.getFilePath(), chat.id)) ||
      turnsSinceAccountLastTurn(historySteps, provider.id, this.createTurnAccountResolver(), session.lastSeenAt)
    ) {
      return { session: null, previousResponseId: null };
    }
    return { session, previousResponseId: chat.lastProviderResponseId };
  }

  /**
   * The timeline marker a follow-up gets when its settings differ from the previous turn: the
   * model handoff divider (carrying any effort change along), or an effort-only divider.
   * `turnMetadata` holds the effort fields persisted on the follow-up's own log step. A queued
   * follow-up's id tags the marker too, so withdrawing an undelivered attempt removes it along
   * with the follow-up's log step instead of leaving an orphaned divider.
   */
  buildTurnSettingsMarker(
    historySteps: ReadonlyArray<{ eventType: string; metadataJson: string }>,
    model: ModelRecord,
    provider: ProviderAccountRecord,
    context: ModelHandoffContext,
    turnMetadata: Record<string, unknown>,
    queuedFollowUpId: unknown,
  ): { title: string; content: string; metadata: Record<string, unknown> } | null {
    const modelHandoff = this.buildModelHandoffMetadata(historySteps, model, provider, context);
    const previousTurn = latestTurnMetadata(historySteps);
    const effortChange = previousTurn
      ? resolveEffortChange(readTurnEffort(previousTurn), readTurnEffort(turnMetadata), modelHandoff !== null)
      : null;
    const queueTag = typeof queuedFollowUpId === "string" ? { queuedFollowUpId } : {};
    if (modelHandoff) {
      return {
        title: MODEL_HANDOFF_STEP_TITLE,
        content: formatModelHandoffContent(modelHandoff),
        metadata: { modelHandoff, ...(effortChange ? { effortChange } : {}), ...queueTag },
      };
    }
    if (effortChange) {
      return { title: EFFORT_CHANGE_STEP_TITLE, content: formatEffortChangeContent(effortChange), metadata: { effortChange, ...queueTag } };
    }
    return null;
  }

  /**
   * The user-facing "Passing over to …" note for a follow-up whose model differs from the
   * model that handled the previous turn; null when the model did not change.
   */
  private buildModelHandoffMetadata(
    historySteps: ReadonlyArray<{ eventType: string; metadataJson: string }>,
    model: ModelRecord,
    provider: ProviderAccountRecord,
    context: ModelHandoffContext,
  ): ModelHandoffMetadata | null {
    const previousTurn = latestTurnMetadata(historySteps);
    const fromModelId = typeof previousTurn?.modelId === "string" ? previousTurn.modelId : null;
    if (!previousTurn || !fromModelId || fromModelId === model.id) {
      return null;
    }
    let fromModel: ModelRecord | null = null;
    try {
      fromModel = this.db.getModel(fromModelId);
    } catch {
      // The previous model may have been deleted; the note still names the new one.
    }
    const fromAccountId = this.createTurnAccountResolver()(previousTurn);
    return {
      fromModelId,
      fromModelLabel: fromModel?.displayName ?? null,
      toModelId: model.id,
      toModelLabel: model.displayName,
      toProviderLabel: provider.label,
      providerChanged: fromAccountId !== provider.id,
      context,
    };
  }

  /** Maps a persisted user-turn step to the provider account that handled it. */
  createTurnAccountResolver(): (metadata: Record<string, unknown>) => string | null {
    const accountByModelId = new Map<string, string | null>();
    return (metadata) => {
      if (typeof metadata.providerAccountId === "string" && metadata.providerAccountId) {
        return metadata.providerAccountId;
      }
      if (typeof metadata.modelId !== "string" || !metadata.modelId) {
        return null;
      }
      if (!accountByModelId.has(metadata.modelId)) {
        let accountId: string | null = null;
        try {
          accountId = this.db.getModel(metadata.modelId).providerAccountId;
        } catch {
          // Deleted models leave their turns unattributed.
        }
        accountByModelId.set(metadata.modelId, accountId);
      }
      return accountByModelId.get(metadata.modelId) ?? null;
    };
  }

  buildPriorRunMessagesFromSteps(runId: string): Array<Record<string, unknown>> {
    return buildPriorRunMessagesFromSteps(this.db.getRunSteps(runId), this.db.resolveAttachmentBlob);
  }

  getInitialRunAttachments(runId: string): ChatAttachmentPayload[] {
    return extractInitialRunAttachmentsFromSteps(this.db.getRunSteps(runId), this.db.resolveAttachmentBlob);
  }

  getRunCheckpoint(runId: string):
    | RunResumeCheckpoint
    | undefined {
    const raw = this.db.getSettings()[runCheckpointSettingKey(runId)];
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as RunResumeCheckpoint;
    } catch {
      this.db.deleteSetting(runCheckpointSettingKey(runId));
      return undefined;
    }
  }

  setRunCheckpoint(runId: string, checkpoint: RunResumeCheckpoint): void {
    this.db.setSetting(runCheckpointSettingKey(runId), JSON.stringify({ ...checkpoint, skills: this.db.getSessionSkills("run", runId) ?? undefined }));
  }

  clearRunCheckpoint(runId: string): void {
    this.db.deleteSetting(runCheckpointSettingKey(runId));
  }

  getRunPromptRestorePoint(runId: string): RunPromptRestorePoint | undefined {
    return this.db.getRunPromptRestorePoint(runId) ?? undefined;
  }

  private setRunPromptRestorePoint(runId: string, restorePoint: RunPromptRestorePoint): void {
    this.db.setRunPromptRestorePoint(runId, restorePoint);
  }

  clearRunPromptRestorePoint(runId: string): void {
    this.db.deleteRunPromptRestorePoint(runId);
  }

  async capturePromptRestorePoint(runId: string, commandType: "initial" | "follow-up"): Promise<void> {
    const run = this.db.getRun(runId);
    if (run.workspaceVcs !== "git") {
      this.clearRunPromptRestorePoint(runId);
      this.captureConversationRestorePoint(runId, commandType);
      return;
    }
    try {
      const headSha = await this.gitService.getHeadCommitSha(run.worktreePath).catch(() => null);
      // Recorded first: a review still needs the start when undo can't be captured.
      if (headSha && commandType === "initial") this.db.recordRunReviewBaseline(runId, headSha);
      const patch = await this.gitService.createPromptRestorePatch(run.worktreePath);
      if (headSha !== await this.gitService.getHeadCommitSha(run.worktreePath)) throw new Error("HEAD moved while capturing the restore point.");
      this.setRunPromptRestorePoint(runId, {
        createdAt: new Date().toISOString(),
        commandType,
        patch,
        headSha,
      });
    } catch (error) {
      // An older point would undo the wrong prompt. Keep execution available without undo.
      this.clearRunPromptRestorePoint(runId);
      this.logControllerWarn("Could not capture a prompt restore point; undo is unavailable for this prompt.", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.captureConversationRestorePoint(runId, commandType);
  }

  /** Captures optional pre-turn history/session state; storage errors must not prevent execution. */
  private captureConversationRestorePoint(runId: string, commandType: "initial" | "follow-up"): void {
    try {
      const run = this.db.getRun(runId);
      if (run.kind !== "standard" || run.delegationEnabled) return;
      const step = [...this.db.getRunSteps(runId)].reverse().find((entry) => {
        const meta = parseMetadataRecord(entry.metadataJson);
        return meta.source === "user" && meta.commandType === commandType;
      });
      if (!step) return;
      const snapshot = this.getRunPromptRestorePoint(runId);
      this.db.saveRunTurnRestorePoint(runId, { id: randomUUID(), stepId: step.id, prompt: step.content,
        createdAt: new Date().toISOString(), commandType, filesAvailable: Boolean(snapshot?.headSha),
        patch: snapshot?.patch ?? null, headSha: snapshot?.headSha ?? null,
        providerSession: this.db.getProviderAccountSessionRuntime(runId, "run", run.providerAccountId) });
    } catch (error) {
      this.logControllerWarn("Could not save a conversation restore point; rewind is unavailable for this prompt.", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getLatestRunExecutionOptions(runId: string, provider: ProviderAccountRecord): ProviderExecutionOptions | undefined {
    return this.getLatestExecutionOptionsFromSteps(this.db.getRunSteps(runId), provider);
  }

  getLatestChatExecutionOptions(chatId: string, provider: ProviderAccountRecord): ProviderExecutionOptions | undefined {
    return this.getLatestExecutionOptionsFromSteps(this.db.getChatSteps(chatId), provider);
  }

  private getLatestExecutionOptionsFromSteps(
    steps: ReadonlyArray<{ metadataJson: string }>,
    provider: ProviderAccountRecord,
  ): ProviderExecutionOptions | undefined {
    const settings = latestRunExecutionSettings(steps);
    if (!settings) return undefined;
    return resolveProviderExecutionOptions(provider, settings);
  }

  upsertProviderSessionRuntime(
    ownerKind: "run" | "chat",
    ownerId: string,
    provider: ProviderAccountRecord,
    fallbackModelId: string,
    runtime: Omit<ProviderSessionRuntimeInput, "status" | "ownerId" | "ownerKind" | "providerType" | "harnessType"> & {
      status?: ProviderSessionRuntimeInput["status"];
    },
  ): void {
    this.db.upsertProviderSessionRuntime({
      ownerId,
      ownerKind,
      providerAccountId: provider.id,
      providerType: provider.providerType,
      harnessType: getHarnessTypeForProvider(provider.providerType),
      status: runtime.status ?? "ready",
      cwd: runtime.cwd,
      modelId: runtime.modelId ?? fallbackModelId,
      runtimeMode: runtime.runtimeMode,
      resumeCursor: runtime.resumeCursor ?? null,
      runtimePayload: runtime.runtimePayload ?? null,
    });
  }

  async persistFailedTurnAccounting(
    ownerKind: "run" | "chat", ownerId: string, provider: ProviderAccountRecord,
    modelId: string, metadata: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (provider.providerType !== "claude-code" || metadata?.failedTurnAccounting !== true) return;
    const runtime = metadata.providerSessionRuntime as WorkerDoneResult["providerSessionRuntime"];
    if (!runtime || runtime.status !== "ready" || typeof runtime.cwd !== "string" ||
      !["ask", "plan", "code"].includes(runtime.runtimeMode) || typeof runtime.resumeCursor?.sessionId !== "string") return;
    this.upsertProviderSessionRuntime(ownerKind, ownerId, provider, modelId, runtime);
    await this.db.flushDurable();
  }
}
