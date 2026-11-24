import {
  type ProjectTaskInput,
  type ProjectTaskRecord,
  type RunRecord,
  type UpdateProjectTaskInput,
  validateChatAttachmentPayloads,
} from "@buildwarden/shared";
import { logWarn } from "../logger";
import { AppService } from "./app-service";

/** Manages the project task board. */
export class ProjectTaskService extends AppService<"forgeIssueActions" | "forgeRequests" | "modelText"> {
  markLinkedRunTaskInReview(run: RunRecord, pullRequestUrl?: string): ProjectTaskRecord | null {
    if (!run.projectTaskId) {
      return null;
    }
    const task = this.db.markProjectTaskInReview(run.projectTaskId, pullRequestUrl);
    this.events.publish("task", { projectId: task.projectId, taskId: task.id, status: task.status });
    return task;
  }

  async createProjectTask(projectId: string, input: ProjectTaskInput): Promise<ProjectTaskRecord> {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (!title) {
      throw new Error("Enter a task title.");
    }
    if (!prompt) {
      throw new Error("Enter a task prompt.");
    }
    validateChatAttachmentPayloads(input.attachments);
    this.db.getProject(projectId);
    const task = this.db.createProjectTask(projectId, { title, prompt, attachments: input.attachments });
    this.services.forgeIssueActions.recordForgeIssueLink(input.forgeIssue, projectId, "task", task.id);
    this.events.publish("task", { projectId: task.projectId, taskId: task.id, status: task.status });
    return task;
  }

  async getProjectTask(taskId: string): Promise<ProjectTaskRecord> {
    return this.db.getProjectTask(taskId);
  }

  async updateProjectTask(taskId: string, input: UpdateProjectTaskInput): Promise<ProjectTaskRecord> {
    const existing = this.db.getProjectTask(taskId);
    const title = input.title === undefined ? existing.title : input.title.trim();
    const prompt = input.prompt === undefined ? existing.prompt : input.prompt.trim();
    if (!title) {
      throw new Error("Enter a task title.");
    }
    if (!prompt) {
      throw new Error("Enter a task prompt.");
    }
    validateChatAttachmentPayloads(input.attachments);
    const status = input.status ?? existing.status;
    if (!(status === "open" || status === "in_progress" || status === "in_review" || status === "done")) {
      throw new Error(`Unsupported project task status: ${String(status)}`);
    }
    const task = this.db.updateProjectTask(taskId, { title, prompt, status, attachments: input.attachments });
    this.events.publish("task", { projectId: task.projectId, taskId: task.id, status: task.status });
    return task;
  }

  async syncProjectTaskPullRequestStatuses(projectId: string, automatic = false): Promise<ProjectTaskRecord[]> {
    const tasks = this.db
      .listProjectTasks(projectId)
      .filter((task) => task.status === "in_review" && Boolean(task.pullRequestUrl));
    if (tasks.length === 0) {
      return [];
    }

    const provider = await this.services.forgeRequests.createProjectPrReviewProvider(projectId);
    const changed: ProjectTaskRecord[] = [];
    for (const task of tasks) {
      if (automatic && this.services.forgeRequests.projectForgeIntervalMs(projectId) <= 0) break;
      try {
        const summary = await provider.getRequestSummary({ prUrl: task.pullRequestUrl! });
        if (summary.state === "merged") {
          // The task may have been reopened or linked to another request meanwhile.
          const current = this.db.getProjectTask(task.id);
          if (current.status !== "in_review" || current.pullRequestUrl !== task.pullRequestUrl) continue;
          const updated = this.db.updateProjectTask(task.id, { status: "done" });
          this.events.publish("task", { projectId: updated.projectId, taskId: updated.id, status: updated.status });
          changed.push(updated);
        }
      } catch (error) {
        logWarn("Failed to reconcile a project task with its linked PR/MR.", {
          projectId,
          taskId: task.id,
          pullRequestUrl: task.pullRequestUrl,
          error,
        });
      }
    }
    return changed;
  }

  async deleteProjectTask(taskId: string): Promise<void> {
    const existing = this.db.getProjectTask(taskId);
    this.db.deleteProjectTask(taskId);
    this.events.publish("task", { projectId: existing.projectId, taskId: existing.id, status: existing.status });
  }

  async generateProjectTaskRunPrompt(input: { projectId: string; title: string; notes: string; modelId: string }): Promise<string> {
    const project = this.db.getProject(input.projectId);
    const context = await this.services.modelText.resolveModelInvocationContext(input.modelId);

    const title = input.title.trim();
    const notes = input.notes.trim();
    if (!title && !notes) {
      throw new Error("Enter task notes before generating a prompt.");
    }

    const prompt = [
      "Rewrite the following project task notes into a strong coding-agent run prompt.",
      "Keep it concrete, implementation-focused, and easy for an agent to act on.",
      "If the notes are vague, preserve the intent and state reasonable assumptions explicitly.",
      "Output only the final run prompt text. No markdown fences, no bullets unless they help clarity.",
      "",
      `Project: ${project.name}`,
      `Task title: ${title || "(untitled task)"}`,
      "Task notes:",
      notes || "(no notes provided)",
    ].join("\n");

    try {
      const text = await this.services.modelText.askModelForText(project.repoPath, context, {
        prompt,
        systemPrompt: "You rewrite rough software task notes into crisp prompts for a coding agent. Output only the final prompt text.",
        maxTokens: 900,
        temperature: 0.3,
        usageProjectId: project.id,
      });
      if (!text) {
        throw new Error("The model returned an empty prompt.");
      }
      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not generate a run prompt for this task. Detail: ${msg}`);
    }
  }
}
