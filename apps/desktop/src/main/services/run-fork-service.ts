import { existsSync, statSync } from "node:fs";
import { APP_SETTING_KEYS, type ModelRecord, type ProviderSessionRuntimeInput, type RunForkInput, type RunRecord, type RunStepRecord } from "@buildwarden/shared";
import { canonicalWorkspacePath } from "../workspace-restore-safety";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES, SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";
import { parseMetadataRecord } from "./run-step-content";

/** Where the files of a fork come from. */
export type RunForkFiles = "turn-snapshot" | "current" | "current-no-snapshot";

const FORK_TITLE_MAX_LENGTH = 120;

/** A prompt the user sent that starts a new turn; steered messages belong to the running turn. */
const isTurnPrompt = (step: Pick<RunStepRecord, "eventType" | "metadataJson">): boolean => {
  if (step.eventType !== "log") return false;
  const metadata = parseMetadataRecord(step.metadataJson);
  return metadata.source === "user" && (metadata.commandType === "initial" || metadata.commandType === "follow-up");
};

/** The model or effort divider that the app writes just before the prompt of a turn that changed them. */
const isTurnSettingsMarker = (step: Pick<RunStepRecord, "eventType" | "metadataJson">): boolean => {
  if (step.eventType !== "status") return false;
  const metadata = parseMetadataRecord(step.metadataJson);
  const isObject = (value: unknown) => typeof value === "object" && value !== null;
  return isObject(metadata.modelHandoff) || isObject(metadata.effortChange);
};

/**
 * The steps a fork through the turn that holds `stepId` keeps, and the prompt that starts the
 * next turn (null when the turn is the run's latest).
 */
export const planRunFork = (steps: ReadonlyArray<RunStepRecord>, stepId: string): { kept: RunStepRecord[]; nextPrompt: RunStepRecord | null } => {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error("The selected message is no longer in this run's history.");
  if (!steps.slice(0, index + 1).some(isTurnPrompt)) throw new Error("Choose a message after the run's first prompt.");
  const next = steps.findIndex((step, position) => position > index && isTurnPrompt(step));
  if (next < 0) return { kept: [...steps], nextPrompt: null };
  // The next turn's settings dividers belong to that turn, like in the paged history.
  let end = next;
  while (end - 1 > index && isTurnSettingsMarker(steps[end - 1]!)) end -= 1;
  return { kept: steps.slice(0, end), nextPrompt: steps[next]! };
};

const describeForkFiles = (files: RunForkFiles): string => {
  if (files === "turn-snapshot") return "Files are as they were when this turn ended.";
  if (files === "current") return "Files are a copy of the source run's workspace as it is now.";
  return "No snapshot of the files at the end of this turn was saved, so the files are a copy of the source run's workspace as it is now.";
};

/**
 * Forks a finished run: a new run in its own workspace that holds the conversation up to the end
 * of a chosen turn. The fork has no provider session, so its first follow-up hands the copied
 * conversation to the agent, like any turn that starts a fresh session.
 */
export class RunForkService extends AppService<"activeWorkers" | "providerRuntime" | "runEvents" | "runLifecycle" | "runDeletion" | "settings" | "skills" | "workspaceGuard"> {
  async forkRun(input: RunForkInput): Promise<RunRecord> {
    const source = this.db.getRun(input.runId);
    this.requireForkable(source);
    if (!existsSync(source.worktreePath) || !statSync(source.worktreePath).isDirectory()) {
      throw new Error("The source run workspace is no longer available.");
    }
    const project = this.db.getProject(source.projectId);
    const workspaceSetupProfile = this.services.settings.getWorkspaceSetupProfile(project.id) ?? null;
    const configuredWorktreeRoot = this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
    const shareDependencies = workspaceSetupProfile?.dependencies !== "isolated";
    const { kept, nextPrompt, files, workspace, summary } = await this.services.workspaceGuard.serializeProjectBranchMutation(source.projectId, async () => {
      // A follow-up may have started the source run in the meantime, and a rewind may have cleared its summary.
      const current = this.db.getRun(source.id);
      this.requireForkable(current);
      this.services.workspaceGuard.requireWorkspaceNotRestoring(canonicalWorkspacePath(source.worktreePath));
      // Plan under the lock that rewind also holds, so a rewind that finished first is applied.
      const plan = planRunFork(this.db.getRunSteps(source.id), input.stepId);
      const snapshot = plan.nextPrompt ? this.findTurnEndSnapshot(source, plan.nextPrompt.id) : null;
      const files: RunForkFiles = snapshot ? "turn-snapshot" : plan.nextPrompt ? "current-no-snapshot" : "current";
      if (snapshot) {
        const created = await this.gitService.createWorktreeAtSnapshot(
          project.repoPath, project.name, crypto.randomUUID(), snapshot, configuredWorktreeRoot, shareDependencies,
        );
        return { kept: plan.kept, nextPrompt: plan.nextPrompt, files, summary: current.summary, workspace: { workspaceType: "worktree" as const, workspaceVcs: "git" as const, ...created } };
      }
      const workspace = await this.services.runLifecycle.prepareContinuationWorkspace(source, project, true, configuredWorktreeRoot, shareDependencies);
      return { kept: plan.kept, nextPrompt: plan.nextPrompt, files, summary: current.summary, workspace };
    });

    const lastPrompt = parseMetadataRecord([...kept].reverse().find(isTurnPrompt)?.metadataJson ?? "{}");
    const model = this.resolveTurnModel(lastPrompt.modelId, source);
    let fork: RunRecord;
    try {
      fork = this.db.createRun({
        projectId: project.id,
        providerAccountId: model.providerAccountId,
        modelId: model.id,
        harnessType: source.harnessType,
        mode: lastPrompt.mode === "code" || lastPrompt.mode === "plan" || lastPrompt.mode === "ask" ? lastPrompt.mode : source.mode,
        ...workspace,
        prompt: source.prompt,
        goalText: typeof lastPrompt.goalText === "string" && lastPrompt.goalText.trim() ? lastPrompt.goalText : null,
        parentRunId: source.id,
        rootRunId: source.rootRunId ?? source.id,
        lineageTitle: source.prompt || source.branchName,
        workspaceSetupProfile,
        delegationEnabled: Boolean(source.delegationEnabled),
      });
    } catch (error) {
      await this.services.runDeletion.discardPreparedRunWorkspace(project.repoPath, workspace);
      throw error;
    }

    const nativeFork = nextPrompt ? null : this.nativeSessionFork(source, model);
    const metadata = { forkedFromRunId: source.id, forkedFromStepId: input.stepId, forkFiles: files, ...(nativeFork ? { nativeSessionFork: true } : {}) };
    const sessionNote = nativeFork
      ? "The next message continues a fork of the agent's own session; if the agent cannot fork it, a fresh session receives this conversation."
      : "The next message starts a fresh agent session that receives this conversation.";
    const content = `Forked from ${this.services.workspaceGuard.getRunWorkspaceLabel(source)}. ${describeForkFiles(files)} ${sessionNote}`;
    try {
      if (fork.workspaceType !== "local") {
        this.db.upsertWorktree({ id: fork.id, projectId: fork.projectId, runId: fork.id, branchName: fork.branchName, worktreePath: fork.worktreePath, status: "ready" });
      }
      this.db.copyRunSteps(fork.id, kept);
      if (nativeFork) {
        this.db.upsertProviderSessionRuntime({
          ...nativeFork,
          ownerId: fork.id,
          ownerKind: "run",
          status: "ready",
          cwd: fork.worktreePath,
        });
      }
      const skills = this.db.getSessionSkills("run", source.id);
      if (skills?.overrideIds) this.services.skills.skillService.setSelection("run", fork.id, skills.overrideIds);
      if (source.title) {
        const title = `Fork of ${source.title}`;
        this.db.renameSessionTitle("run", fork.id, title.length <= FORK_TITLE_MAX_LENGTH ? title : `${title.slice(0, FORK_TITLE_MAX_LENGTH - 1)}…`);
      }
      await this.services.runEvents.appendRunEvent(fork.id, "status", "Run forked", content, metadata);
      fork = this.db.updateRunStatus(fork.id, "completed", { summary: nextPrompt ? null : summary });
    } catch (error) {
      // A half-made fork would sit queued until the next start; remove it with its workspace.
      await this.services.runDeletion.deleteRun(fork.id).catch(() => {});
      throw error;
    }
    await this.services.runLifecycle.captureFolderBaselineSnapshotOrFail(fork, project);

    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, fork.id);
    this.services.runEvents.emitEvent({ runId: fork.id, type: "status", title: "Run forked", content, metadata, createdAt: new Date().toISOString() });
    return this.db.getRun(fork.id);
  }

  private requireForkable(run: RunRecord): void {
    if (ACTIVE_RUN_STATUSES.has(run.status) || this.services.activeWorkers.runWorkers.has(run.id)) {
      throw new Error("Wait for this run to finish before forking it.");
    }
    // Delegation switched on is fine until the run hands out tasks; then the tasks belong to it.
    if (run.kind !== "standard" || this.db.getOrchestrationByCoordinatorRunId(run.id)) {
      throw new Error("Forking is available for independent runs. Runs that delegated tasks, and the delegated runs, must stay aligned with their tasks.");
    }
    if (this.db.getPendingRunRewind(run.id)) throw new Error("Finish the pending rewind before forking this run.");
  }

  /** The saved files from just before `nextPromptStepId` ran, which are the files the previous turn left. */
  private findTurnEndSnapshot(run: RunRecord, nextPromptStepId: string): { headSha: string; patch: string } | null {
    if (run.workspaceVcs !== "git") return null;
    const summary = this.db.listRunTurnRestorePoints(run.id).find((point) => point.stepId === nextPromptStepId);
    const point = summary?.filesAvailable ? this.db.getRunTurnRestorePoint(run.id, summary.id) : null;
    return point?.headSha && point.patch !== null ? { headSha: point.headSha, patch: point.patch } : null;
  }

  /**
   * The session a fork at the source run's latest turn starts from, when the agent can fork it
   * natively (ACP `session/fork`). A fork of an earlier turn cannot use it: the agent's session
   * already holds the later turns. The fork's first turn forks the session in its own workspace,
   * or falls back to a fresh session with the conversation when the agent cannot.
   */
  private nativeSessionFork(source: RunRecord, model: ModelRecord): Omit<ProviderSessionRuntimeInput, "ownerId" | "ownerKind" | "status" | "cwd"> | null {
    const session = this.db.getProviderAccountSessionRuntime(source.id, "run", model.providerAccountId);
    const sessionId = session?.resumeCursor?.sessionId;
    if (!session || session.providerType !== "acp" || typeof sessionId !== "string" || !sessionId) return null;
    const provider = this.db.getProviderAccount(model.providerAccountId);
    if (this.services.providerRuntime.sessionCapabilityReport(provider)?.sessionFork === false) return null;
    return {
      providerAccountId: session.providerAccountId,
      providerType: session.providerType,
      harnessType: session.harnessType,
      modelId: session.modelId,
      runtimeMode: session.runtimeMode,
      resumeCursor: { forkFromSessionId: sessionId },
      runtimePayload: session.runtimePayload,
    };
  }

  /** The model that answered the fork's last turn, or the source run's model when it was removed. */
  private resolveTurnModel(modelId: unknown, source: RunRecord): ModelRecord {
    if (typeof modelId === "string" && modelId) {
      try {
        return this.db.getModel(modelId);
      } catch {
        // Fall back to the run's current model below.
      }
    }
    return this.db.getModel(source.modelId);
  }
}
