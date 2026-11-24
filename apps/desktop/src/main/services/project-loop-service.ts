import { dirname, join } from "node:path";
import {
  type CreateProjectLoopInput,
  isLoopCapableProviderType,
  type ProjectLoopAvailability,
  type ProjectLoopChangedPayload,
  type ProjectLoopDetail,
  type ProjectLoopRecord,
  type ProjectLoopUiReviewDecisionInput,
} from "@buildwarden/shared";
import { ProjectLoopRunner } from "../loop/loop-runner";
import type { ProjectPrReviewRemoteContext } from "../pr-review/pr-review-types";
import { AppService } from "./app-service";
import { projectForgeTokenSecretKey } from "./forge-request-policy";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";

/** Starts and controls project loops. */
export class ProjectLoopService extends AppService<
  | "appState"
  | "forgeRequests"
  | "modelText"
  | "runDeletion"
  | "runLifecycle"
  | "runTurns"
  | "workspaceGuard"
> implements RunEndedListener {
  private loopRunnerInstance: ProjectLoopRunner | null = null;

  get loopRunner(): ProjectLoopRunner {
    if (!this.loopRunnerInstance) {
      this.loopRunnerInstance = new ProjectLoopRunner({
        db: this.db,
        gitService: this.gitService,
        uiReviewImageRoot: join(dirname(this.db.getFilePath()), "loop-ui-reviews"),
        createIterationRun: (input) => this.services.appState.withPreservedRunSelection(() => this.services.runLifecycle.createRun(input)),
        followUpRun: (runId, prompt, options) =>
          this.services.appState.withPreservedRunSelection(() => this.services.runTurns.followUpRunInternal(runId, prompt, options, { loopFollowUp: true })),
        cancelRun: (runId) => this.services.runTurns.cancelRun(runId),
        deleteRun: (runId) => this.services.runDeletion.deleteRun(runId),
        askModelForText: async (cwd, modelId, input) => {
          const context = await this.services.modelText.resolveModelInvocationContext(modelId);
          return this.services.modelText.askModelForText(cwd, context, input);
        },
        createForgeProvider: (projectId) => this.services.forgeRequests.createProjectPrReviewProvider(projectId),
        emitLoopChanged: (payload) => this.events.publish("loop", payload),
        logError: (message, error, metadata) => this.logControllerError(message, error, metadata),
        logWarn: (message, metadata) => this.logControllerWarn(message, metadata),
      });
    }
    return this.loopRunnerInstance;
  }

  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void): () => void {
    return this.events.subscribe("loop", listener);
  }

  /** Re-enters all active loops after an app restart (call after {@link reconcileOrphanedActiveSessions}). */
  resumeActiveProjectLoops(): void {
    try {
      this.loopRunner.resumeActiveLoops();
    } catch (error) {
      this.logControllerError("Could not resume active project loops on startup.", error);
    }
  }

  async createProjectLoop(input: CreateProjectLoopInput): Promise<ProjectLoopRecord> {
    const project = this.db.getProject(input.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Loops");
    return this.loopRunner.startLoop(input);
  }

  async getProjectLoopDetail(loopId: string): Promise<ProjectLoopDetail> {
    return this.db.getProjectLoopDetail(loopId);
  }

  async cancelProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.cancelLoop(loopId);
  }

  async resumeProjectLoop(loopId: string): Promise<void> {
    await this.loopRunner.resumeLoop(loopId);
  }

  async deleteProjectLoop(loopId: string): Promise<{ deletedRunIds: string[] }> {
    return this.loopRunner.deleteLoop(loopId);
  }

  async respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput): Promise<void> {
    await this.loopRunner.respondToUiReview(reviewId, input);
  }

  async getProjectLoopUiReviewImage(reviewId: string): Promise<string | null> {
    return this.loopRunner.getUiReviewImageDataUrl(reviewId);
  }

  async getProjectLoopAvailability(projectId: string): Promise<ProjectLoopAvailability> {
    const project = this.db.getProject(projectId);
    const enabledModels = this.db.listModels().filter((model) => model.enabled);
    const providersById = new Map(this.db.listProviderAccounts().map((provider) => [provider.id, provider]));
    const hasLocalModels = enabledModels.some((model) => {
      const provider = providersById.get(model.providerAccountId);
      return provider ? isLoopCapableProviderType(provider.providerType) : false;
    });

    if (project.kind !== "git") {
      return { available: false, reason: "not-git", hasToken: false, hasLocalModels };
    }

    let context: ProjectPrReviewRemoteContext;
    try {
      context = await this.services.forgeRequests.resolveProjectPrReviewRemoteContext(projectId);
    } catch {
      return { available: false, reason: "no-remote", hasToken: false, hasLocalModels };
    }

    const hasToken = Boolean((await this.secrets.readSecret(projectForgeTokenSecretKey(projectId)))?.trim());
    if (!hasToken) {
      return {
        available: false,
        reason: "no-forge-token",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    if (!hasLocalModels) {
      return {
        available: false,
        reason: "no-local-models",
        provider: context.provider,
        repoLabel: context.repoLabel,
        hasToken,
        hasLocalModels,
      };
    }
    return { available: true, provider: context.provider, repoLabel: context.repoLabel, hasToken, hasLocalModels };
  }

  onRunEnded({ run }: RunEnded): void {
    if (run.kind === "loop-iteration") this.loopRunner.handleRunTerminal(run.id);
  }
}
