import { randomInt } from "node:crypto";
import {
  APP_SETTING_KEYS,
  buildDefaultProjectLabSettings,
  type OrchestrationRecord,
  parseProjectLabSettingsSetting,
  type ProjectLabMode,
  type ProjectLabSettings,
  type ProjectLabThreadRecord,
  type ProjectRecord,
  type RunProjectLabInput,
  type RunRecord,
} from "@buildwarden/shared";
import { getHarnessTypeForProvider } from "../harness-adapters";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";
import { PROJECT_LAB_MODE_LABELS } from "./project-lab-prompts";
import type { RunEnded, RunEndedListener } from "./run-ended-notifier";

const PROJECT_LAB_MODES: ProjectLabMode[] = ["new-feature", "bugfix", "refactoring", "rfc-only"];

/** Human-readable lab kickoff message; `baseBranch` is null for plain folder projects. */
const describeLabStart = (modeLabel: string, baseBranch: string | null, topic: string | null): string => {
  const origin = baseBranch ? `Started ${modeLabel} mode from base branch \`${baseBranch}\`` : `Started ${modeLabel} mode for this project folder`;
  return topic ? `${origin} with user direction: ${topic}` : `${origin}.`;
};

/** Runs Project Lab proposals and implementations. */
export class ProjectLabService
  extends AppService<"modelText" | "projectLabPrompts" | "projects" | "runDeletion" | "runDetails" | "runLifecycle">
  implements RunEndedListener
{
  private readonly cancelledProjectLabThreadIds = new Set<string>();

  private getProjectLabSettings(projectId: string): ProjectLabSettings {
    const settingsByProjectId = parseProjectLabSettingsSetting(this.db.getSettings()[APP_SETTING_KEYS.projectLabSettings]);
    return settingsByProjectId[projectId] ?? buildDefaultProjectLabSettings();
  }

  private chooseProjectLabMode(): ProjectLabMode {
    return PROJECT_LAB_MODES[randomInt(PROJECT_LAB_MODES.length)] ?? "new-feature";
  }

  private normalizeProjectLabMode(value: ProjectLabMode | undefined): ProjectLabMode {
    return value && PROJECT_LAB_MODES.includes(value) ? value : this.chooseProjectLabMode();
  }

  private async createProjectLabImplementationRun(
    projectId: string,
    threadId: string,
    modelId: string,
    prompt: string,
    baseBranch?: string | null,
  ): Promise<RunRecord> {
    const project = this.db.getProject(projectId);
    const selectedBaseBranch = baseBranch?.trim() || project.baseBranch;
    if (project.kind === "git") {
      const availableBranches = await this.services.projects.getProjectBranches(projectId);
      if (!availableBranches.includes(selectedBaseBranch)) {
        throw new Error(`Base branch "${selectedBaseBranch}" is not available for this project. Choose an existing Project Lab base branch and start a new thread.`);
      }
    }
    this.requireProjectLabThreadKept(threadId);
    const model = this.db.getModel(modelId);
    const provider = this.db.getProviderAccount(model.providerAccountId);
    const harnessType = getHarnessTypeForProvider(provider.providerType);
    const run = await this.services.runLifecycle.createRun({
      projectId,
      providerAccountId: model.providerAccountId,
      modelId,
      harnessType,
      mode: "code",
      workspaceType: project.kind === "folder" ? "copy" : "worktree",
      baseBranch: project.kind === "git" ? selectedBaseBranch : undefined,
      prompt,
      kind: "lab-implementation",
      labThreadId: threadId,
    });
    this.requireProjectLabThreadKept(threadId);
    this.db.deleteSetting(SELECTED_RUN_KEY);
    this.db.setSetting(SELECTED_PROJECT_KEY, projectId);
    return run;
  }

  /** Reviews a finished implementation. A review that fails still ends the thread, so it frees its slot. */
  async reviewCompletedProjectLabImplementation(run: RunRecord): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    try {
      await this.runProjectLabImplementationReview(run, run.labThreadId);
    } catch (error) {
      this.logControllerError("Could not review a Project Lab implementation.", error, { runId: run.id, threadId: run.labThreadId });
      if (this.isProjectLabThreadCancelled(run.labThreadId)) return;
      const content = `The implementation completed, but its review failed: ${error instanceof Error ? error.message : String(error)}`;
      this.db.appendProjectLabEvent({ threadId: run.labThreadId, role: "system", label: "System", content });
      const summary = run.summary?.trim();
      this.db.updateProjectLabThread(run.labThreadId, { status: "completed", ...(summary ? { summary } : {}), outcome: content });
    }
  }

  private async runProjectLabImplementationReview(run: RunRecord, threadId: string): Promise<void> {
    const thread = this.db.getProjectLabThread(threadId);
    const project = this.db.getProject(run.projectId);
    const reviewModelId = thread.reviewModelId?.trim();

    if (!reviewModelId) {
      this.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: "Implementation completed, but no review model was stored on this Project Lab thread.",
      });
      this.db.updateProjectLabThread(thread.id, {
        status: "completed",
        summary: run.summary?.trim() || thread.summary,
        outcome: run.summary?.trim() || thread.outcome,
      });
      return;
    }

    this.db.updateProjectLabThread(thread.id, { status: "reviewing" });
    const diff = (await this.services.runDetails.getRunWorktreeDiff(run.id)).diff.trim();
    const context = await this.services.modelText.resolveModelInvocationContext(reviewModelId);
    const content = await this.services.modelText.askModelForText(run.worktreePath, context, {
      prompt: [
        `Project: ${project.name}`,
        `Project Lab mode: ${PROJECT_LAB_MODE_LABELS[thread.mode]}`,
        `Implementation thread: ${thread.title}`,
        `Implementation run summary: ${run.summary ?? "(none)"}`,
        "",
        "Review the implementation as a second agent.",
        "Focus on correctness, scope control, regressions, missing validation, and whether the change matches the Project Lab mode.",
        "Do not rewrite the implementation. Return concise Markdown with sections: Verdict, Findings, Follow-up.",
        "",
        "Diff:",
        diff || "(No remaining diff found. Review the run summary and note that there was no diff to inspect.)",
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Be direct, concrete, and practical.",
      maxTokens: 900,
      temperature: 0.2,
      usageProjectId: project.id,
    });

    const review = content.trim() || "Review completed without comments.";
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "review",
      label: "Review agent",
      content: review,
    });
    this.db.updateProjectLabThread(thread.id, {
      status: "completed",
      summary: run.summary?.trim() || thread.summary,
      outcome: review,
    });
  }

  async failProjectLabImplementation(run: RunRecord, message: string): Promise<void> {
    if (!run.labThreadId) {
      return;
    }
    const thread = this.db.getProjectLabThread(run.labThreadId);
    if (thread.status === "cancelled") {
      return;
    }
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "System",
      content: `Implementation ended without success: ${message}`,
    });
    this.db.updateProjectLabThread(thread.id, {
      status: "failed",
      outcome: message,
    });
  }

  cancelProjectLabImplementation(run: RunRecord, message: string): void {
    if (!run.labThreadId) {
      return;
    }
    try {
      const thread = this.db.getProjectLabThread(run.labThreadId);
      if (thread.status === "cancelled") {
        return;
      }
      this.db.appendProjectLabEvent({
        threadId: thread.id,
        role: "system",
        label: "System",
        content: message,
      });
      this.db.updateProjectLabThread(thread.id, {
        status: "cancelled",
        outcome: message,
      });
    } catch {
      /* The Project Lab thread may have been deleted while its run was still stopping. */
    }
  }

  private requireProjectLabThreadKept(threadId: string): void {
    if (this.isProjectLabThreadCancelled(threadId)) throw new Error("This Project Lab thread was deleted.");
  }

  private isProjectLabThreadCancelled(threadId: string): boolean {
    return this.cancelledProjectLabThreadIds.has(threadId);
  }

  private projectLabTitleFromMarkdown(markdown: string, fallback: string): string {
    const heading = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^#{1,3}\s+/.test(line));
    return heading?.replace(/^#{1,3}\s+/, "").trim().slice(0, 140) || fallback;
  }

  private projectLabSummaryFromMarkdown(markdown: string, fallback: string): string {
    const paragraph = markdown
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))[0];
    return paragraph?.slice(0, 320) || fallback;
  }

  private async executeProjectLabRfcThread(
    threadId: string,
    input: RunProjectLabInput,
    project: ProjectRecord,
    mode: ProjectLabMode,
    implementationModelId: string,
    reviewModelId: string,
    baseBranch: string,
  ): Promise<void> {
    const repoBrief = await this.services.projectLabPrompts.buildProjectLabRepoBrief(project, baseBranch);
    const avoidanceBrief = this.services.projectLabPrompts.buildProjectLabAvoidanceBrief(project.id, threadId);
    const sameModePriorWorkBrief = this.services.projectLabPrompts.buildProjectLabSameModePriorWorkBrief(project.id, mode, threadId);
    const implementationContext = await this.services.modelText.resolveModelInvocationContext(implementationModelId);
    const rfc = await this.services.modelText.askModelForText(project.repoPath, implementationContext, {
      prompt: [
        "You are BuildWarden Project Lab's RFC agent.",
        "Inspect the repository context below and write one useful RFC. Do not modify files.",
        "",
        `Project: ${project.name}`,
        this.services.projectLabPrompts.buildProjectLabOpportunityInstruction(input, mode),
        "",
        "Repository brief:",
        repoBrief,
        "",
        this.services.projectLabPrompts.buildProjectLabModeBrief(mode),
        "",
        "Existing Project Lab topics to avoid:",
        avoidanceBrief,
        "",
        "Previous same-mode Project Lab work to avoid:",
        sameModePriorWorkBrief,
        "",
        "Return concise Markdown with sections: Title, Motivation, Proposal, Alternatives, Risks, Rollout, Open Questions.",
      ].join("\n"),
      systemPrompt: "You write practical engineering RFCs grounded in repository evidence.",
      maxTokens: 1400,
      temperature: 0.35,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    const rfcContent = rfc.trim() || "No RFC content returned.";
    this.db.appendProjectLabEvent({
      threadId,
      role: "rfc",
      label: "RFC agent",
      content: rfcContent,
    });
    this.db.updateProjectLabThread(threadId, {
      title: this.projectLabTitleFromMarkdown(rfcContent, "Project Lab RFC"),
      summary: this.projectLabSummaryFromMarkdown(rfcContent, "Project Lab drafted an RFC."),
      outcome: rfcContent,
      status: "reviewing",
    });

    const reviewContext = await this.services.modelText.resolveModelInvocationContext(reviewModelId);
    const review = await this.services.modelText.askModelForText(project.repoPath, reviewContext, {
      prompt: [
        `Project: ${project.name}`,
        "Review this Project Lab RFC as a second agent.",
        "Check whether the proposal is useful, scoped, risky, missing alternatives, or ready for a future implementation run.",
        "Return concise Markdown with sections: Verdict, Gaps, Suggested next step.",
        "",
        "RFC:",
        rfcContent,
      ].join("\n"),
      systemPrompt: "You are BuildWarden Project Lab's review agent. Review RFC quality and practicality.",
      maxTokens: 800,
      temperature: 0.25,
      usageProjectId: project.id,
    });
    if (this.isProjectLabThreadCancelled(threadId)) {
      return;
    }

    this.db.appendProjectLabEvent({
      threadId,
      role: "review",
      label: "Review agent",
      content: review.trim() || "RFC review completed without comments.",
    });
    this.db.updateProjectLabThread(threadId, {
      status: "completed",
    });
  }

  async runProjectLab(input: RunProjectLabInput): Promise<ProjectLabThreadRecord[]> {
    const project = this.db.getProject(input.projectId);
    const settings = this.getProjectLabSettings(project.id);
    if (!settings.enabled) {
      throw new Error("Enable Project Lab on this project before starting it.");
    }

    const implementationModelId = input.implementationModelId?.trim() || settings.implementationModelId?.trim() || "";
    const reviewModelId = input.reviewModelId?.trim() || settings.reviewModelId?.trim() || "";
    if (!implementationModelId) {
      throw new Error("Choose an implementation model before running Project Lab.");
    }
    if (!reviewModelId) {
      throw new Error("Choose a review model before running Project Lab.");
    }
    this.db.getModel(implementationModelId);
    this.db.getModel(reviewModelId);

    const mode = this.normalizeProjectLabMode(input.mode);
    const modeLabel = PROJECT_LAB_MODE_LABELS[mode];
    const baseBranch = project.kind === "git" ? input.baseBranch?.trim() || project.baseBranch : "project-folder";
    if (project.kind === "git") {
      const availableBranches = await this.services.projects.getProjectBranches(project.id);
      if (!availableBranches.includes(baseBranch)) {
        throw new Error(`Base branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
    }

    // Nothing may await between these checks and the insert, or two requests could take the last slot.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = this.db
      .listProjectLabThreads(project.id)
      .filter((thread) => new Date(thread.createdAt).getTime() >= todayStart.getTime()).length;
    if (todayCount >= settings.maxThreadsPerDay) {
      throw new Error(`Project Lab reached the daily cap of ${String(settings.maxThreadsPerDay)} thread(s) for this project.`);
    }

    const activeCount = this.db
      .listProjectLabThreads(project.id)
      .filter((thread) => thread.status === "queued" || thread.status === "running" || thread.status === "reviewing").length;
    if (activeCount >= settings.maxConcurrentThreads) {
      throw new Error(`Project Lab already has ${String(settings.maxConcurrentThreads)} active thread(s) on this project.`);
    }

    const thread = this.db.createProjectLabThread({
      projectId: project.id,
      kind: mode === "rfc-only" ? "rfc" : "implementation",
      mode,
      status: "queued",
      origin: input.origin ?? "manual",
      title: input.topic?.trim() || `${modeLabel} Project Lab run`,
      summary: mode === "rfc-only" ? "Project Lab is drafting an RFC." : `Project Lab is finding and implementing one ${modeLabel.toLowerCase()} opportunity.`,
      seedPrompt: input.topic?.trim() || null,
      implementationModelId,
      reviewModelId,
      baseBranch,
    });

    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "system",
      label: "Project Lab",
      content: describeLabStart(modeLabel, project.kind === "git" ? baseBranch : null, input.topic?.trim() || null),
    });

    if (mode === "rfc-only") {
      this.db.updateProjectLabThread(thread.id, { status: "running" });
      void this.executeProjectLabRfcThread(thread.id, input, project, mode, implementationModelId, reviewModelId, baseBranch).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.isProjectLabThreadCancelled(thread.id)) {
          try {
            this.db.appendProjectLabEvent({
              threadId: thread.id,
              role: "system",
              label: "Project Lab",
              content: `Project Lab RFC failed: ${message}`,
            });
            this.db.updateProjectLabThread(thread.id, {
              status: "failed",
              outcome: message,
            });
          } catch {
            /* thread may have been deleted */
          }
        }
        this.logControllerError("Project Lab RFC execution failed.", error, { projectId: project.id, threadId: thread.id });
      });
      return [this.db.getProjectLabThread(thread.id)];
    }

    let implementationPrompt: string;
    let implementationRun: RunRecord;
    try {
      implementationPrompt = await this.services.projectLabPrompts.buildProjectLabImplementationPrompt(input, project, mode, thread.id, baseBranch);
      implementationRun = await this.createProjectLabImplementationRun(
        project.id,
        thread.id,
        implementationModelId,
        implementationPrompt,
        baseBranch,
      );
    } catch (error) {
      await this.settleFailedProjectLabLaunch(thread, error);
      throw error;
    }
    this.db.appendProjectLabEvent({
      threadId: thread.id,
      role: "implementation",
      label: "Implementation agent",
      content:
        implementationRun.workspaceVcs === "folder"
          ? `Implementation started in a copied folder workspace. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`
          : `Implementation started in worktree \`${implementationRun.branchName}\`. The agent will find one ${modeLabel.toLowerCase()} opportunity, implement it, and a second agent will review the resulting diff afterwards.`,
    });

    return [
      this.db.updateProjectLabThread(thread.id, {
        status: "running",
        implementationPrompt,
        implementationRunId: implementationRun.id,
      }),
    ];
  }

  /** Ends a thread whose implementation did not start, keeping a run that was created before the failure. */
  private async settleFailedProjectLabLaunch(thread: ProjectLabThreadRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const run = this.db.listRunsForProject(thread.projectId).find((entry) => entry.labThreadId === thread.id);
    if (this.isProjectLabThreadCancelled(thread.id)) {
      // The deletion could not know this run, and no thread refers to it anymore.
      if (run) await this.services.runDeletion.deleteRun(run.id);
      return;
    }
    this.db.appendProjectLabEvent({ threadId: thread.id, role: "system", label: "Project Lab", content: `The implementation could not start: ${message}` });
    this.db.updateProjectLabThread(thread.id, {
      status: "failed",
      outcome: message,
      ...(run ? { implementationRunId: run.id } : {}),
    });
  }

  async deleteProjectLabThread(threadId: string): Promise<void> {
    this.cancelledProjectLabThreadIds.add(threadId);
    const thread = this.db.getProjectLabThread(threadId);
    const implementationRun = thread.implementationRunId
      ? (() => {
          try {
            return this.db.getRun(thread.implementationRunId);
          } catch {
            return null;
          }
        })()
      : null;
    this.db.deleteProjectLabThread(threadId);
    if (implementationRun) {
      const ownedTask = this.db.getOrchestrationTaskByChildRunId(implementationRun.id);
      if (ownedTask) {
        let orchestration: OrchestrationRecord | null = null;
        try {
          orchestration = this.db.getOrchestration(ownedTask.orchestrationId);
        } catch {
          /* Fall through to the implementation run when orchestration metadata is stale. */
        }
        await this.services.runDeletion.deleteRun(orchestration?.coordinatorRunId ?? implementationRun.id);
      } else {
        await this.services.runDeletion.deleteRun(implementationRun.id);
      }
    }
  }

  async getProjectLabThreadDetail(threadId: string) {
    return this.db.getProjectLabThreadDetail(threadId);
  }

  async onRunEnded({ run, status, failureReason }: RunEnded): Promise<void> {
    if (run.kind !== "lab-implementation") return;
    if (status === "completed") await this.reviewCompletedProjectLabImplementation(this.db.getRun(run.id));
    else if (failureReason !== null) await this.failProjectLabImplementation(run, failureReason);
    else this.cancelProjectLabImplementation(run, "The implementation run was cancelled.");
  }
}
