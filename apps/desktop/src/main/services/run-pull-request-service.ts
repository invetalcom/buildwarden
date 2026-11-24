import { GitService } from "@buildwarden/git-service";
import type { RunPublishOptions, RunPullRequestDraft } from "@buildwarden/shared";
import { normalizeJsonResponse } from "../json-response";
import { AppService } from "./app-service";
import { MAX_DIFF_CHARS_FOR_REVIEW } from "./app-service-constants";
import { normalizeSuggestedCommitMessage } from "./run-branch-service";

/** Drafts and opens pull and merge requests for runs. */
export class RunPullRequestService extends AppService<
  | "forgeIssueActions"
  | "modelText"
  | "runBranches"
  | "runDeletion"
  | "runEvents"
  | "runForge"
  | "tasks"
  | "verification"
  | "workspaceGuard"
> {
  async getRunPublishOptions(runId: string): Promise<RunPublishOptions> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Publishing");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Publishing");

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const targetBranches = await this.gitService.listTargetBranches(run.worktreePath);
    const defaultTargetBranch =
      targetBranches.includes(project.baseBranch) ? project.baseBranch : (targetBranches[0] ?? project.baseBranch);
    const publishContext = await this.gitService
      .getPullRequestContext(run.worktreePath, defaultTargetBranch)
      .catch((error: unknown) => {
        this.logControllerWarn("Could not resolve target-relative Git context for the publish dialog.", {
          runId: run.id,
          targetBranch: defaultTargetBranch,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    const defaultCommitMessage = this.services.runBranches.buildRunCommitMessage(run.prompt);
    const suggestedTitle = publishContext?.commits[0]?.subject || defaultCommitMessage;

    return {
      defaultTargetBranch,
      defaultSourceBranch: run.branchName,
      defaultDescription: this.buildRunPullRequestBody(project.name, run.prompt, defaultTargetBranch),
      defaultCommitMessage,
      hasOpenChanges: publishContext?.hasOpenChanges ?? (await this.gitService.hasChanges(run.worktreePath)),
      suggestedTitle,
      targetBranches,
    };
  }

  async createRunPullRequest(
    runId: string,
    targetBranch: string,
    title: string,
    sourceBranchName?: string,
    description?: string,
    commitMessage?: string,
  ): Promise<string> {
    const initialRun = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(initialRun, "Pull and merge request creation");
    const initialProject = this.db.getProject(initialRun.projectId);
    this.services.workspaceGuard.requireGitProject(initialProject, "Pull and merge request creation");
    return this.services.workspaceGuard.serializeProjectBranchMutation(initialProject.id, () =>
      this.createRunPullRequestUnlocked(runId, targetBranch, title, sourceBranchName, description, commitMessage));
  }

  private async createRunPullRequestUnlocked(
    runId: string,
    targetBranch: string,
    title: string,
    sourceBranchName?: string,
    description?: string,
    commitMessage?: string,
  ): Promise<string> {
    let run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Pull and merge request creation");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request creation");
    this.services.workspaceGuard.requireIdleRunWorkspace(run, "creating a pull or merge request");
    const trimmedTitle = title.trim();
    const trimmedTargetBranch = targetBranch.trim();
    const trimmedSourceBranch = sourceBranchName?.trim() || run.branchName;
    const createdCustomSourceBranch = trimmedSourceBranch !== run.branchName;
    const trimmedDescription = this.services.forgeIssueActions.withForgeIssueClosingReference(
      run,
      description?.trim() || this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch),
    );
    if (createdCustomSourceBranch) {
      this.services.workspaceGuard.requireIdleProjectCheckout(run, "creating a pull or merge request from a new branch");
    }

    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title.");
    }

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    await this.services.verification.requireVerifiedRevision(runId);
    const prospectiveContext = await this.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
    if (!prospectiveContext.diff.trim()) {
      throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
    }

    if (createdCustomSourceBranch) {
      await this.gitService.assertPublishBranchAvailable(run.worktreePath, trimmedSourceBranch);
    }

    // Commit on the run branch before branching off, so rolling back a failed custom branch keeps the commit.
    if (await this.gitService.hasChanges(run.worktreePath)) {
      await this.services.runBranches.commitRunUnlocked(run.id, commitMessage?.trim() || trimmedTitle);
      run = this.db.getRun(run.id);
    }

    const originalRunBranch = run.branchName;
    const previousCheckout = createdCustomSourceBranch ? await this.gitService.getCurrentBranch(run.worktreePath).catch(() => null) : null;
    if (createdCustomSourceBranch) {
      await this.gitService.createPublishBranchFromHead(run.worktreePath, trimmedSourceBranch);
      run = this.db.updateRunBranchName(run.id, trimmedSourceBranch);
    }

    let result: Awaited<ReturnType<GitService["createPullRequest"]>>;
    try {
      const publishContext = await this.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
      if (!publishContext.diff.trim()) {
        throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
      }

      await this.services.verification.requireVerifiedRevision(runId);
      result = await this.gitService.createPullRequest(
        run.worktreePath,
        trimmedSourceBranch,
        trimmedTargetBranch,
        trimmedTitle,
        trimmedDescription,
      );
    } catch (error) {
      if (createdCustomSourceBranch) {
        await this.services.runDeletion.rollbackCreatedRunBranch(run, project.repoPath, {
          previousCheckout,
          originalRunBranch,
          created: trimmedSourceBranch,
        });
      }
      throw error;
    }
    const url = result.url;
    const requestLabel = result.requestKind === "merge-request" ? "Merge request" : "Pull request";
    const eventTitle =
      result.mode === "created"
        ? `${requestLabel} created`
        : result.mode === "existing"
          ? `${requestLabel} already open`
          : `${requestLabel} draft opened`;

    await this.services.runEvents.appendRunEvent(run.id, "status", eventTitle, url, {
      targetBranch: trimmedTargetBranch,
      sourceBranch: trimmedSourceBranch,
      title: trimmedTitle,
      descriptionLength: trimmedDescription.length,
      url,
      mode: result.mode,
      promotedToProject: createdCustomSourceBranch,
    });
    this.services.runEvents.emitEvent({
      runId: run.id,
      type: "status",
      title: eventTitle,
      content: url,
      metadata: {
        targetBranch: trimmedTargetBranch,
        sourceBranch: trimmedSourceBranch,
        title: trimmedTitle,
        descriptionLength: trimmedDescription.length,
        url,
        mode: result.mode,
        promotedToProject: createdCustomSourceBranch,
      },
      createdAt: new Date().toISOString(),
    });
    if (result.descriptionOmitted === true) {
      // The draft link left the description out to stay short enough to open; keep it for pasting.
      await this.services.runEvents.appendRunEvent(run.id, "status", `${requestLabel} description to paste`, trimmedDescription, {
        url,
        descriptionOmittedFromDraftUrl: true,
      });
    }
    this.services.tasks.markLinkedRunTaskInReview(run, url);
    await this.services.runForge.syncRunForgeRequest(run.id, true, true, url);

    if (createdCustomSourceBranch) {
      await this.services.runBranches.promoteRunBranchToProjectCheckout(run, project.repoPath, trimmedSourceBranch);
    }

    const openResult = await this.desktop.openExternalUrl(url);
    if (!openResult.ok) {
      throw new Error(openResult.error ?? "Could not open the pull request URL.");
    }

    return url;
  }

  async suggestRunPullRequestDraft(runId: string, targetBranch: string): Promise<RunPullRequestDraft> {
    return this.generateRunPullRequestDraft(runId, targetBranch);
  }

  async suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string): Promise<string> {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error("Enter a merge request or pull request title before generating a description.");
    }
    return (await this.generateRunPullRequestDraft(runId, targetBranch, trimmedTitle)).description;
  }

  private async generateRunPullRequestDraft(
    runId: string,
    targetBranch: string,
    preferredTitle?: string,
  ): Promise<RunPullRequestDraft> {
    const run = this.db.getRun(runId);
    this.services.workspaceGuard.requireGitRun(run, "Pull and merge request draft generation");
    const project = this.db.getProject(run.projectId);
    this.services.workspaceGuard.requireGitProject(project, "Pull and merge request draft generation");
    const trimmedTargetBranch = targetBranch.trim();

    if (!trimmedTargetBranch) {
      throw new Error("Select a target branch before generating a pull request draft.");
    }

    if (run.workspaceType === "worktree") {
      await this.gitService.checkoutWorktreeBranch(run.worktreePath, run.branchName);
    }

    const publishContext = await this.gitService.getPullRequestContext(run.worktreePath, trimmedTargetBranch);
    let diff = publishContext.diff;
    if (!diff.trim()) {
      throw new Error(`The source branch has no changes against "${trimmedTargetBranch}".`);
    }
    if (diff.length > MAX_DIFF_CHARS_FOR_REVIEW) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_FOR_REVIEW)}\n\n[Diff truncated for MR/PR description generation.]`;
    }
    const commitContext = publishContext.commits.length > 0
      ? publishContext.commits.map((commit) => `- ${commit.hash.slice(0, 12)} ${commit.subject}`).join("\n")
      : "(no committed source-branch changes yet; open changes will be committed before publishing)";

    const context = await this.services.modelText.resolveModelInvocationContext(run.modelId);
    const defaultTitle = preferredTitle?.trim() || publishContext.commits[0]?.subject || this.services.runBranches.buildRunCommitMessage(run.prompt);
    const defaultCommitMessage = this.services.runBranches.buildRunCommitMessage(run.prompt);
    const defaultDescription = this.buildRunPullRequestBody(project.name, run.prompt, trimmedTargetBranch);
    const prompt = [
      "Create a complete merge request / pull request draft for these code changes.",
      "Return exactly one JSON object with this shape:",
      '{"title":"Concise PR title","commitMessage":"Concise git commit message or null","description":"Markdown PR body"}',
      "The title should be specific, concise, and should not use a conventional-commit prefix unless it improves clarity.",
      publishContext.hasOpenChanges
        ? "The commitMessage must describe the open changes that BuildWarden will commit before publishing."
        : "Set commitMessage to null because the workspace is clean.",
      "Keep the description practical and scannable, using ## Summary, ## What Changed, and ## Validation when useful.",
      "If validation is unknown, say so briefly instead of inventing it.",
      "Encode the markdown description as a JSON string. Do not output markdown fences or commentary outside the JSON object.",
      "",
      `Project: ${project.name}`,
      `Source branch: ${run.branchName}`,
      `Target branch: ${trimmedTargetBranch}`,
      "",
      "Original run prompt:",
      run.prompt || "(no prompt available)",
      "",
      "Current defaults:",
      `Title: ${defaultTitle}`,
      `Commit message: ${publishContext.hasOpenChanges ? defaultCommitMessage : "(not needed)"}`,
      "Description:",
      defaultDescription,
      "",
      "Source-branch commits since the target merge base:",
      commitContext,
      "",
      publishContext.hasOpenChanges
        ? "Prospective PR diff, including open changes that BuildWarden will commit before publishing:"
        : "Committed PR diff against the target branch merge base:",
      diff,
    ].join("\n");

    try {
      const text = await this.services.modelText.askModelForUtilityText(run.worktreePath, context, {
        purpose: "pull-request-draft",
        prompt,
        systemPrompt: "You write strong engineering pull request drafts. Output only the requested JSON object.",
        maxTokens: 1_300,
        temperature: 0.2,
        usageProjectId: run.projectId,
      });
      const parsed = JSON.parse(normalizeJsonResponse(text)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The model did not return a JSON object.");
      }
      const record = parsed as Record<string, unknown>;
      const generatedTitle = typeof record.title === "string" ? record.title.replace(/\s+/g, " ").trim() : "";
      const generatedDescription = typeof record.description === "string" ? record.description.trim() : "";
      const generatedCommitMessage = typeof record.commitMessage === "string"
        ? normalizeSuggestedCommitMessage(record.commitMessage)
        : "";
      if (!generatedTitle || !generatedDescription) {
        throw new Error("The model returned an incomplete pull request draft.");
      }
      return {
        title: generatedTitle,
        description: generatedDescription,
        commitMessage: publishContext.hasOpenChanges ? generatedCommitMessage || generatedTitle : null,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a merge request or pull request draft. Detail: ${msg}`);
    }
  }

  private buildRunPullRequestBody(projectName: string, prompt: string, targetBranch: string): string {
    return [
      "## Summary",
      `- Automated changes from BuildWarden for \`${projectName}\`.`,
      `- Original run prompt: ${prompt}`,
      "",
      "## Target branch",
      `- ${targetBranch}`,
      "",
      "## Test plan",
      "- [ ] Review the generated diff",
      "- [ ] Run relevant tests locally",
    ].join("\n");
  }
}
