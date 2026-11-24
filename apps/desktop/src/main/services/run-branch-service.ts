import { existsSync } from "node:fs";
import { basename } from "node:path";
import { GitService } from "@buildwarden/git-service";
import { APP_SETTING_KEYS, canReviewRunChanges, forgeIssueBranchName, type RunRecord } from "@buildwarden/shared";
import { normalizeSuggestedBranchName } from "../branch-name-suggestion";
import { runWorktreeDiffInWorker } from "../run-worktree-diff-worker";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES, MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST, SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";

export const normalizeSuggestedCommitMessage = (raw: string): string => {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[\w-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return t;
};

/** Commits, publishes, checks out and releases run branches. */
export class RunBranchService extends AppService<
  | "forgeIssueActions"
  | "modelText"
  | "runDeletion"
  | "runEvents"
  | "runForge"
  | "settings"
  | "tasks"
  | "verification"
  | "workspaceGuard"
> {
  private shouldAutoCheckoutRunBranch(run: RunRecord): boolean {
    return run.workspaceVcs === "git" && run.workspaceType === "worktree" &&
      this.services.settings.isSettingEnabled(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, true);
  }

  private async canCheckoutRunWorktree(run: RunRecord): Promise<boolean> {
    return this.shouldAutoCheckoutRunBranch(run) && existsSync(run.worktreePath) &&
      await this.gitService.hasWorktreeGitMetadata(run.worktreePath);
  }

  async activateRun(runId: string): Promise<void> {
    let run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);
    const branchPromotedToProject = this.services.workspaceGuard.wasRunPromotedToProject(run.id);
    const autoCheckoutWorktree = this.shouldAutoCheckoutRunBranch(run);

    if (await this.canCheckoutRunWorktree(run)) {
      try {
        await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
        this.services.workspaceGuard.updateWorktreeStatus(run, ACTIVE_RUN_STATUSES.has(run.status) ? "busy" : "ready");
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the run branch "${run.branchName}" in its worktree.`,
            "It may already be checked out in another IDE, repository, or worktree.",
            "Release it from the other source or open the run worktree folder directly instead.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    } else if (
      autoCheckoutWorktree &&
      branchPromotedToProject
    ) {
      try {
        await this.gitService.checkoutProjectBranch(project.repoPath, run.branchName);
        run = this.db.updateRunWorkspace(run.id, "local", project.repoPath);
      } catch (error) {
        throw new Error(
          [
            `BuildWarden could not check out the promoted branch "${run.branchName}" in the project repository.`,
            "It may be blocked by local changes or another checkout state in the main repository.",
            "",
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
          ].join("\n"),
        );
      }
    }

    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.setSetting(SELECTED_RUN_KEY, run.id);
  }

  async commitRun(runId: string, message: string): Promise<void> {
    const initialRun = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Committing");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.commitRunUnlocked(runId, message));
  }

  async commitRunUnlocked(runId: string, message: string): Promise<void> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Committing");

    if (!canReviewRunChanges(run)) {
      throw new Error("The agent must finish its turn before its changes can be committed.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to commit for this run.");
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const commitMessage = message.trim() || this.buildRunCommitMessage(run.prompt);
    const result = await this.gitService.commitAllChanges(run.worktreePath, commitMessage);

    await this.services.runEvents.appendRunEvent(run.id, "status", "Commit created", `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`, {
      commitHash: result.commitHash,
      commitMessage: commitMessage,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Commit created",
      content: `Created commit ${result.commitHash.slice(0, 12)} on ${run.branchName}.`,
      metadata: {
        commitHash: result.commitHash,
        commitMessage: commitMessage,
      },
      createdAt: new Date().toISOString(),
    });
    this.services.tasks.markLinkedRunTaskInReview(run);
    this.services.runForge.syncRunForgeRequestInBackground(run.id, true);
  }

  async suggestCommitMessage(runId: string): Promise<string> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Commit message suggestions");

    if (!canReviewRunChanges(run)) {
      throw new Error("The agent must finish its turn before requesting AI commit suggestions.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    if (!(await this.gitService.hasChanges(run.worktreePath))) {
      throw new Error("There are no changes to describe for this run.");
    }

    const diffOutcome = await runWorktreeDiffInWorker(run.worktreePath);
    if (!diffOutcome.ok) {
      throw new Error("Could not read the worktree diff.");
    }
    let diff = diffOutcome.diff;
    if (diff.length > MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) {
      diff =
        diff.slice(0, MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST) +
        "\n\n[Diff truncated for commit message generation - review before committing.]";
    }

    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const commitMessagePrompt = [
      "Task the agent was given:",
      run.prompt,
      "",
      "Git diff of current uncommitted changes in the run workspace (staged + unstaged + untracked as patches):",
      diff || "(empty diff)",
      "",
      "Write a concise git commit message for these changes.",
      "Use an imperative mood subject line, at most about 72 characters.",
      "Optionally add a blank line and a short body if needed.",
      "Output only the commit message text - no quotes, markdown fences, or commentary.",
    ].join("\n");

    try {
      const text = normalizeSuggestedCommitMessage(await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
        purpose: "commit-message",
        prompt: commitMessagePrompt,
        systemPrompt: "You write concise git commit messages from diffs. Output only the commit message.",
        maxTokens: 500,
        temperature: 0.3,
        usageProjectId: run.projectId,
      }));
      if (!text) throw new Error("The model returned an empty commit message.");
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a commit message via the configured provider. Detail: ${message}`);
    }
  }

  async publishRunBranch(runId: string, branchName?: string): Promise<string> {
    const initialRun = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Publishing");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.publishRunBranchUnlocked(runId, branchName));
  }

  private async publishRunBranchUnlocked(runId: string, branchName?: string): Promise<string> {
    let run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Publishing");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Publishing");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "publishing its branch");
    const trimmedBranchName = branchName?.trim() || run.branchName;
    const createdCustomBranch = trimmedBranchName !== run.branchName;

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }
    if (createdCustomBranch) {
      this.services.workspaceGuard.requireIdleProjectCheckout(run, "publishing a new branch");
    }

    if (await this.gitService.hasChanges(run.worktreePath)) {
      throw new Error("Commit or discard open changes before publishing the branch.");
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const originalRunBranch = run.branchName;
    const previousCheckout = createdCustomBranch ? await this.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createdCustomBranch) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
    }

    let result: Awaited<ReturnType<GitService["publishBranch"]>>;
    let worktreeRemoved = true;
    try {
      if (createdCustomBranch) run = this.db.updateRunBranchName(run.id, trimmedBranchName);
      result = await this.gitService.publishBranch(run.worktreePath, trimmedBranchName);
      if (createdCustomBranch) {
        ({ worktreeRemoved } = await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName));
      }
    } catch (error) {
      if (createdCustomBranch) {
        await this.services.runDeletion.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch,
          created: trimmedBranchName,
        });
      }
      throw error;
    }

    const content = createdCustomBranch
      ? `Published branch ${result.branchName} to ${result.remoteName} and checked it out in the project repository.${worktreeRemoved ? " The run worktree was removed." : ""}`
      : `Published branch ${result.branchName} to ${result.remoteName}.`;

    await this.services.runEvents.appendRunEvent(run.id, "status", "Branch published", content, {
      branchName: result.branchName,
      remoteName: result.remoteName,
      promotedToProject: createdCustomBranch,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Branch published",
      content,
      metadata: {
        branchName: result.branchName,
        remoteName: result.remoteName,
        promotedToProject: createdCustomBranch,
      },
      createdAt: new Date().toISOString(),
    });
    this.services.tasks.markLinkedRunTaskInReview(run);
    this.services.runForge.syncRunForgeRequestInBackground(run.id, true);

    return content;
  }

  async createRunLocalBranch(runId: string, branchName: string): Promise<string> {
    const initialRun = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Local branch creation");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialRun.projectId, () => this.createRunLocalBranchUnlocked(runId, branchName));
  }

  private async createRunLocalBranchUnlocked(runId: string, branchName: string): Promise<string> {
    let run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Local branch creation");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Local branch creation");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "moving its changes to a local branch");
    const originalRunBranchName = run.branchName;
    const trimmedBranchName = branchName.trim();

    if (!trimmedBranchName) {
      throw new Error("Enter a branch name.");
    }

    const createsNewBranch = trimmedBranchName !== run.branchName;
    if (!createsNewBranch && run.workspaceType !== "worktree") {
      throw new Error("The new local branch must differ from the current worktree branch.");
    }
    this.services.workspaceGuard.requireIdleProjectCheckout(run, "moving changes to a local branch");

    const hasOpenChanges = await this.gitService.hasChanges(run.worktreePath);

    const previousCheckout = createsNewBranch ? await this.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createsNewBranch) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedBranchName);
    }
    let worktreeRemoved: boolean;
    try {
      if (createsNewBranch) run = this.db.updateRunBranchName(run.id, trimmedBranchName);
      ({ worktreeRemoved } = await this.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedBranchName, {
        transferOpenChanges: hasOpenChanges,
        deleteReleasedBranchName: createsNewBranch ? originalRunBranchName : undefined,
      }));
    } catch (error) {
      if (createsNewBranch) {
        await this.services.runDeletion.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch: originalRunBranchName,
          created: trimmedBranchName,
        });
      }
      throw error;
    }

    const moved = hasOpenChanges ? "moved the open changes to it" : "checked it out";
    const content = `Created local branch ${trimmedBranchName} and ${moved} in the project repository.${worktreeRemoved ? " The run worktree was removed." : ""}`;
    await this.services.runEvents.appendRunEvent(run.id, "status", "Local branch created", content, {
      branchName: trimmedBranchName,
      promotedToProject: true,
      transferredOpenChanges: hasOpenChanges,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: "Local branch created",
      content,
      metadata: {
        branchName: trimmedBranchName,
        promotedToProject: true,
        transferredOpenChanges: hasOpenChanges,
      },
      createdAt: new Date().toISOString(),
    });

    return content;
  }

  async suggestRunBranchName(runId: string): Promise<string> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Branch name suggestions");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch name suggestions");
    // A run started from an issue gets a name that leads back to it; no model call needed.
    const issueLink = this.services.forgeIssueActions.findForgeIssueLinkForRun(run);
    if (issueLink) return forgeIssueBranchName(issueLink.issueNumber, issueLink.issueTitle);
    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const prompt = [
      `Project: ${project.name}`,
      `Task: ${run.prompt}`,
      `Current branch: ${run.branchName}`,
      "",
      "Suggest a new branch name for this task.",
      "Use lowercase ASCII letters, numbers, hyphens, and optional forward slashes only.",
      "Use a short conventional prefix such as feat/, fix/, refactor/, docs/, test/, or chore/ when appropriate.",
      "Output only the branch name, with no quotes, markdown, or commentary.",
    ].join("\n");
    const raw = await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
      purpose: "branch-name",
      prompt,
      systemPrompt: "You generate concise, valid Git branch names. Output only the branch name.",
      maxTokens: 80,
      temperature: 0.2,
      usageProjectId: run.projectId,
    });
    const branchName = normalizeSuggestedBranchName(raw);
    if (!branchName) {
      throw new Error("The model returned an empty branch name.");
    }
    return branchName;
  }

  async releaseRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    const project = this.db.getProject(run.projectId);

    // A watched run keeps its branch checked out: the next wake commits on it.
    const watched = Boolean(this.db.getPrWatch(runId)) && this.db.getPrWatch(runId)!.status !== "ended";
    if (
      run.workspaceType === "worktree" &&
      this.services.settings.isSettingEnabled(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, true) &&
      !ACTIVE_RUN_STATUSES.has(run.status) &&
      !watched
    ) {
      if (existsSync(run.worktreePath) && (await this.gitService.hasWorktreeGitMetadata(run.worktreePath))) {
        try {
          await this.gitService.releaseWorktreeBranch(run.worktreePath, run.branchName);
          this.services.workspaceGuard.updateWorktreeStatus(run, "released");
        } catch (error) {
          throw new Error(
            [
              `BuildWarden could not release the run branch "${run.branchName}" from its worktree.`,
              "Close file locks in other tools or open the run worktree folder directly instead.",
              "",
              `Original error: ${error instanceof Error ? error.message : String(error)}`,
            ].join("\n"),
          );
        }
      } else {
        this.services.workspaceGuard.updateWorktreeStatus(run, "released");
      }
    }

    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    this.db.deleteSetting(SELECTED_RUN_KEY);
  }

  buildRunCommitMessage(prompt: string): string {
    const singleLinePrompt = prompt.replace(/\s+/g, " ").trim();
    const summary = singleLinePrompt.length > 60 ? `${singleLinePrompt.slice(0, 60).trim()}...` : singleLinePrompt;
    return `buildwarden: ${summary || "apply run changes"}`;
  }

  /**
   * Run cleanup force-deletes only the branch BuildWarden generated for the worktree (named like its
   * folder). A branch the user named, for example when publishing, may hold unpushed work and is kept.
   */
  getOwnedRunBranchForDeletion(run: RunRecord, options: { preserveBranch?: boolean }): string | undefined {
    if (options.preserveBranch === true || run.branchName !== basename(run.worktreePath)) {
      return undefined;
    }
    return run.branchName;
  }

  async promoteRunBranchToProjectCheckout(
    run: RunRecord,
    repoPath: string,
    branchName: string,
    options?: { transferOpenChanges?: boolean; deleteReleasedBranchName?: string },
  ): Promise<{ worktreeRemoved: boolean }> {
    if (run.workspaceType !== "worktree") {
      await this.gitService.checkoutProjectBranch(repoPath, branchName);
      return { worktreeRemoved: true };
    }

    const transferOpenChanges = options?.transferOpenChanges === true && (await this.gitService.hasChanges(run.worktreePath));

    await this.gitService.releaseWorktreeBranch(run.worktreePath, branchName);
    try {
      await this.gitService.checkoutProjectBranch(repoPath, branchName);
      if (transferOpenChanges) {
        // The target is the user's own checkout: never overwrite changes they made there.
        await this.gitService.cloneWorkspaceChanges(run.worktreePath, repoPath, { protectTargetChanges: true });
      }
    } catch (error) {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, branchName).catch(() => {});
      throw new Error(
        [
          `BuildWarden created branch "${branchName}", but could not check it out in the project repository or transfer the open changes.`,
          "Commit, stash, or discard local changes in the project repository and try again.",
          "",
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
        ].join("\n"),
      );
    }

    // The project checkout owns the branch now, so a worktree that cannot be removed must not detach the run from it.
    this.db.updateRunWorkspace(run.id, "local", repoPath);
    try {
      await this.gitService.removeWorktree(repoPath, run.worktreePath, options?.deleteReleasedBranchName, this.services.workspaceGuard.getConfiguredWorktreeRoot());
      return { worktreeRemoved: true };
    } catch (error) {
      this.logControllerWarn("Could not remove the worktree of a promoted run.", { runId: run.id, worktreePath: run.worktreePath, error });
      await this.services.runEvents.recordRunEvent(
        run.id,
        "status",
        "Run worktree not removed",
        `The branch is checked out in the project repository, but ${run.worktreePath} could not be removed. Close programs that use the folder and delete it.`,
        { worktreePath: run.worktreePath },
      );
      return { worktreeRemoved: false };
    }
  }
}
