import { existsSync } from "node:fs";
import {
  APP_SETTING_KEYS,
  isPrWatchActive,
  parseProjectPrWatchInstructionsSetting,
  PR_WATCH_INSTRUCTIONS_MAX_CHARS,
  type ProjectForgeRequestSummary,
  prWatchRequestLabel,
  type PrWatchView,
  type RunForgeRequestSummary,
  type RunPrWatchCandidate,
  type RunPrWatchCandidates,
  type RunRecord,
  type StartPrWatchInput,
  toPrWatchView,
} from "@buildwarden/shared";
import { PrReviewHttpError } from "../pr-review/pr-review-http-client";
import { type PrWatchForgeState, PrWatchService, type PrWatchWorkspaceCheck } from "../pr-watch-service";
import { resolveRunForgeSourceRepository } from "../run-forge-source";
import { AppService } from "./app-service";
import { isOpenForgeRequestState } from "./forge-request-policy";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";
import { latestUserTurnUsedFullAccess } from "./run-execution-settings";
import { readPrWatchTurnResult } from "./run-step-content";

/** Connects pull request watching with runs and their workspaces. */
export class RunPrWatchService extends AppService<
  | "activeWorkers"
  | "appState"
  | "followUps"
  | "forgeRequests"
  | "runBranches"
  | "runForge"
  | "runTurns"
  | "workspaceGuard"
> implements RunEndedListener {
  prWatchService?: PrWatchService;
  /** Runs whose watch is being started; their link must not change until the watch is saved. */
  private readonly startingPrWatches = new Set<string>();

  getPrWatchService(): PrWatchService {
    return this.prWatchService ??= new PrWatchService(this.db, {
      getRun: (runId) => this.db.getRun(runId),
      isRunBusy: (runId) => this.services.activeWorkers.runWorkers.has(runId) || ["queued", "preparing", "running"].includes(this.db.getRun(runId).status),
      readForge: (run, prUrl, includeDetails) => this.readPrWatchForge(run, prUrl, includeDetails),
      readCheckLog: async (run, prUrl, check) => (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getCheckLog({ prUrl, check }),
      getInstructions: (projectId) => parseProjectPrWatchInstructionsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions])[projectId] ?? "",
      checkWorkspace: (run, summary, mode) => this.checkPrWatchWorkspace(run, summary, mode),
      startTurn: async (run, prompt, wake) => {
        await this.services.appState.withPreservedRunSelection(() => this.services.runTurns.followUpRunInternal(
          run.id,
          prompt,
          { mode: "code", modelId: run.modelId, yoloMode: latestUserTurnUsedFullAccess(this.db.getRunSteps(run.id)) },
          { displayPrompt: prompt, prWatchWake: wake },
        ));
      },
      readTurn: (runId, wakeId) => readPrWatchTurnResult(this.db.getRun(runId), this.db.getRunSteps(runId), wakeId),
      hasUncommittedChanges: (run) => this.gitService.hasChanges(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId))),
      pushRunBranch: async (run, remoteHeadSha) => {
        const head = await this.gitService.getHeadCommitSha(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId)));
        if (remoteHeadSha && head.toLowerCase() === remoteHeadSha.toLowerCase()) return false;
        await this.services.runBranches.publishRunBranch(run.id);
        return true;
      },
      resolveCommit: (run, sha) => this.gitService.resolveCommitInHistory(this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId)), sha),
      replyInThread: async (run, input) => {
        await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).replyToThread(input);
      },
      postComment: async (run, input) => {
        await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).postComment(input);
      },
      // Only a client error is a definite refusal; a timeout, network error or 5xx may follow an accepted write.
      isReplyRejected: (error) => error instanceof PrReviewHttpError && error.status >= 400 && error.status < 500,
      hasPostedReply: async (run, prUrl, text) => {
        const details = await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getRequestDetails({ prUrl });
        // A collection that failed to load comes back empty with a warning: absence there proves nothing.
        if (details.warnings.length) throw new Error(`The request's comments could not be read in full: ${details.warnings.join(" ")}`);
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\r\n/g, "\n").trim();
        const wanted = normalize(text);
        // Usually a delivery marker, which only that one reply carries.
        return details.activity.some((item) => normalize(item.body).includes(wanted)) ||
          details.reviewThreads.some((thread) => thread.comments.some((comment) => normalize(comment.body).includes(wanted)));
      },
      publish: (record) => {
        const forgeRequest = this.db.getRunForgeRequestCache(record.runId)?.summary ?? null;
        this.events.publish("forge", { runId: record.runId, projectId: record.projectId, forgeRequest, prWatch: toPrWatchView(record) });
      },
      logError: (message, error, context) => this.logControllerError(message, error, context),
    });
  }

  /** Forces a read of the watched request. A failed read throws instead of returning the stale copy. */
  private async readPrWatchForge(run: RunRecord, prUrl: string, includeDetails: boolean): Promise<PrWatchForgeState | null> {
    const summary = await this.services.runForge.syncRunForgeRequest(run.id, true, includeDetails, prUrl);
    if (summary?.syncError) throw new Error(summary.syncError);
    if (!summary) return null;
    const details = this.db.getRunForgeRequestCache(run.id)?.details ?? null;
    return {
      summary,
      checks: details?.checks ?? [],
      reviewThreads: details?.reviewThreads ?? null,
      activity: details?.activity ?? null,
    };
  }

  private async checkPrWatchWorkspace(run: RunRecord, summary: RunForgeRequestSummary, mode: "start" | "wake"): Promise<PrWatchWorkspaceCheck> {
    const label = prWatchRequestLabel(summary.provider);
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, this.db.getProject(run.projectId));
    if (!existsSync(workspacePath)) return { ok: false, message: "The run's workspace no longer exists." };
    let branch = await this.gitService.getCurrentBranch(workspacePath).catch(() => null);
    // Leaving a run releases its branch, detaching the worktree on the same commit. Take it back.
    if (!branch && run.workspaceType === "worktree" && run.branchName === summary.sourceBranch &&
      await this.gitService.isWorktreeOnBranch(workspacePath, run.branchName).catch(() => false)) {
      await this.gitService.checkoutWorktreeBranch(workspacePath, run.branchName);
      this.services.workspaceGuard.updateWorktreeStatus(run, "ready");
      branch = run.branchName;
    }
    if (branch !== summary.sourceBranch || run.branchName !== summary.sourceBranch) {
      return { ok: false, message: `The workspace is on ${branch ? `"${branch}"` : "no branch"}, not on the ${label} branch "${summary.sourceBranch}".` };
    }
    if (mode === "start") {
      // A wake fetches from the branch's push remote, which never has a fork's commits.
      const project = this.db.getProject(run.projectId);
      const source = await resolveRunForgeSourceRepository(this.gitService, project.repoPath, summary.sourceBranch, await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId));
      if (source && summary.sourceRepository && source !== summary.sourceRepository) {
        return { ok: false, message: `The ${label} comes from another repository (${summary.sourceRepository}), so its commits cannot be fetched here.` };
      }
      return { ok: true };
    }
    if (await this.gitService.hasChanges(workspacePath)) {
      return { ok: false, message: "The workspace has uncommitted changes. Commit or discard them, then resume the watch." };
    }
    if (!summary.headSha) return { ok: true };
    const sync = await this.gitService.syncWithRemoteHead(workspacePath, summary.sourceBranch, summary.headSha);
    if (sync === "diverged") {
      return { ok: false, message: `The workspace and the ${label} branch have different commits. Reconcile them, then resume the watch.` };
    }
    return { ok: true };
  }

  async getRunPrWatchCandidates(runId: string): Promise<RunPrWatchCandidates> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const cache = this.db.getRunForgeRequestCache(runId);
    const linked = cache?.summary ?? null;
    const workspacePath = this.services.workspaceGuard.getEffectiveRunWorkspacePath(run, project);
    let workspaceBranch = run.workspaceVcs === "git" && existsSync(workspacePath)
      ? await this.gitService.getCurrentBranch(workspacePath).catch(() => null)
      : null;
    // A released worktree is detached on its branch's commit; starting the watch takes the branch back.
    if (!workspaceBranch && run.workspaceVcs === "git" && run.workspaceType === "worktree" && existsSync(workspacePath) &&
      await this.gitService.isWorktreeOnBranch(workspacePath, run.branchName).catch(() => false)) {
      workspaceBranch = run.branchName;
    }
    const result: RunPrWatchCandidates = { workspaceBranch, linked, linkSource: cache?.linkSource ?? "auto", candidates: [], error: null };
    if (run.workspaceVcs !== "git") return { ...result, error: "Only Git runs can watch a request." };
    const watchers = new Map(this.db.listPrWatchesWithStatuses(["watching", "working"]).map((watch) => [watch.prUrl, watch.runId]));
    let sourceRepository: string | null = null;
    let requests: ProjectForgeRequestSummary[] = [];
    try {
      const provider = await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId);
      const branch = workspaceBranch ?? run.branchName;
      sourceRepository = await resolveRunForgeSourceRepository(this.gitService, project.repoPath, branch, provider);
      requests = (await this.services.forgeRequests.loadProjectForgeRequests(run.projectId, provider, {
        state: "open", sourceBranch: branch, ...(sourceRepository ? { sourceRepository } : {}),
      }, true)).items.filter((request) => request.sourceBranch === branch);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    const assess = (request: ProjectForgeRequestSummary): RunPrWatchCandidate => {
      const watchedByRunId = watchers.get(request.url) ?? null;
      let reason: string | null = null;
      // GitLab reports open merge requests as "opened".
      if (!isOpenForgeRequestState(request.state)) reason = "Only open requests can be watched.";
      else if (!workspaceBranch) reason = "The run's workspace is not on a branch.";
      else if (request.sourceBranch !== workspaceBranch || request.sourceBranch !== run.branchName) {
        reason = `Its branch "${request.sourceBranch}" is not checked out in this run's workspace.`;
      } else if (sourceRepository && request.sourceRepository && request.sourceRepository !== sourceRepository) {
        reason = "It comes from another repository.";
      }
      return { request, watchable: reason === null, reason, watchedByRunId: watchedByRunId === runId ? null : watchedByRunId };
    };
    result.candidates = requests.map(assess);
    if (linked && !requests.some((request) => request.url === linked.url)) {
      result.candidates.unshift(assess({
        provider: linked.provider, number: linked.number, title: linked.title, url: linked.url, state: linked.state, draft: linked.draft,
        author: linked.author, sourceBranch: linked.sourceBranch, sourceRepository: linked.sourceRepository ?? null,
        targetBranch: linked.targetBranch, createdAt: null, updatedAt: linked.updatedAt,
      }));
    }
    return result;
  }

  async setRunForgeLink(runId: string, prUrl: string | null): Promise<RunForgeRequestSummary | null> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Linking a request");
    this.requireLinkChangeable(runId);
    const url = prUrl?.trim() ?? "";
    if (!url) {
      this.db.saveRunForgeUnlinked(runId, run.branchName);
      this.services.runForge.publishRunForgeRequest(run, null);
      return null;
    }
    // Rejects requests from other repositories before anything is saved.
    await (await this.services.forgeRequests.createProjectPrReviewProvider(run.projectId)).getRequestSummary({ prUrl: url });
    this.requireLinkChangeable(runId);
    const summary = await this.services.runForge.syncRunForgeRequest(runId, true, true, url);
    if (!summary || summary.syncError) throw new Error(summary?.syncError ?? "The request could not be linked.");
    this.db.setRunForgeLinkSource(runId, "user");
    return summary;
  }

  private requireLinkChangeable(runId: string): void {
    if (this.startingPrWatches.has(runId)) throw new Error("Wait for the watch to start before changing the linked request.");
    if (isPrWatchActive(this.db.getPrWatch(runId))) throw new Error("Stop watching before changing the linked request.");
  }

  async startPrWatch(runId: string, input: StartPrWatchInput): Promise<PrWatchView> {
    // The watch reads the confirmed URL with force, which would relink it. Check the saved link first,
    // so a confirmation for a request the run is no longer linked to cannot take effect.
    const cache = this.db.getRunForgeRequestCache(runId);
    if (cache?.linkSource === "none" || !cache?.summary || cache.summary.url !== input.prUrl.trim()) {
      throw new Error("This run is no longer linked to that request. Check the link and try again.");
    }
    if (this.startingPrWatches.has(runId)) throw new Error("The watch is already starting.");
    this.startingPrWatches.add(runId);
    try {
      const record = await this.getPrWatchService().start(runId, input);
      // The confirmed request stays linked, so discovery cannot move the watch to another one.
      this.db.setRunForgeLinkSource(runId, "user");
      return toPrWatchView(record);
    } finally {
      this.startingPrWatches.delete(runId);
    }
  }

  async stopPrWatch(runId: string): Promise<PrWatchView | null> {
    const record = await this.getPrWatchService().stop(runId);
    return record ? toPrWatchView(record) : null;
  }

  async resumePrWatch(runId: string): Promise<PrWatchView> {
    return toPrWatchView(await this.getPrWatchService().resume(runId));
  }

  async getProjectPrWatchInstructions(projectId: string): Promise<string> {
    this.db.getProject(projectId);
    return parseProjectPrWatchInstructionsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions])[projectId] ?? "";
  }

  async saveProjectPrWatchInstructions(projectId: string, instructions: string): Promise<string> {
    this.db.getProject(projectId);
    const text = instructions.trim();
    if (text.length > PR_WATCH_INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`Watch instructions must be at most ${String(PR_WATCH_INSTRUCTIONS_MAX_CHARS)} characters.`);
    }
    const settings = parseProjectPrWatchInstructionsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectPrWatchInstructions]);
    if (text) settings[projectId] = text;
    else delete settings[projectId];
    if (Object.keys(settings).length) this.db.setSetting(APP_SETTING_KEYS.projectPrWatchInstructions, JSON.stringify(settings));
    else this.db.deleteSetting(APP_SETTING_KEYS.projectPrWatchInstructions);
    return text;
  }

  /**
   * Runs after every turn of a run. A watch turn pushes and answers before the run's queued
   * follow-ups may start, because those would hold the workspace the push needs.
   */
  async handlePrWatchRunTerminal(runId: string): Promise<void> {
    if (this.db.getPrWatch(runId)?.status !== "working") return;
    await this.getPrWatchService().onRunTerminal(runId)
      .catch((error: unknown) => this.logControllerError("Could not finish a PR watch turn.", error, { runId }));
  }

  onRunEnded({ run, status }: RunEnded): void {
    const watchTurn = this.handlePrWatchRunTerminal(run.id);
    // Cancelled or failed turns hold the queue until the user resumes it or sends another follow-up.
    if (status === "completed") void watchTurn.then(() => this.services.followUps.dispatchQueuedFollowUpsInBackground("run", run.id));
  }
}
