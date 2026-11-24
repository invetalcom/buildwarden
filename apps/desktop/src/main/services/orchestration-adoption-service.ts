import { join } from "node:path";
import type { OrchestrationAdoptionDecisionInput, OrchestrationAdoptionPreview, OrchestrationTaskRecord } from "@buildwarden/shared";
import { resultAbandonedSubagentCount } from "../orchestration-native-work";
import { AdoptionRollbackError, applyOrchestrationDelta, previewOrchestrationDelta, undoOrchestrationDelta } from "../orchestration-workspace";
import { AppService } from "./app-service";

/** Previews and applies the changes of isolated child workspaces. */
export class OrchestrationAdoptionService extends AppService<"orchestration" | "orchestrationCoordinator" | "runDetails"> {
  async getOrchestrationAdoptionPreview(taskId: string): Promise<OrchestrationAdoptionPreview> {
    const task = this.db.getOrchestrationTask(taskId);
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
    const wave = this.db.getOrchestrationWave(task.waveId);
    const adoption = this.db.getOrchestrationAdoption(task.id);
    if (adoption?.status !== "rejected" && adoption?.manifest.recoveryNeedsReview === true) {
      return { taskId, status: task.adoptionStatus, diff: "", changedFiles: [], autoMerged: [], unsupportedPaths: [],
        conflicts: [adoption.errorMessage ?? "Interrupted adoption needs manual review. Reject it after inspecting the coordinator workspace."] };
    }
    if (!task.childRunId) {
      return { taskId, status: task.adoptionStatus, diff: "", changedFiles: [], conflicts: [], autoMerged: [], unsupportedPaths: [] };
    }
    const child = this.db.getRun(task.childRunId);
    const result = this.db.listOrchestrationTaskResults(task.id).at(-1);
    const diffResult = await this.services.runDetails.getRunWorktreeDiff(child.id);
    const assertCurrentResult = () => {
      if (this.db.listOrchestrationTaskResults(task.id).at(-1)?.id !== result?.id) {
        throw new Error("The published result changed while loading the preview. Refresh it before approving.");
      }
    };
    assertCurrentResult();
    if (!wave.baselinePath || wave.baselineState !== "ready") {
      return {
        taskId,
        status: task.adoptionStatus,
        diff: diffResult.diff,
        changedFiles: this.services.orchestration.orchestrationTaskChangedFiles(diffResult.diff),
        conflicts: ["The immutable wave baseline is unavailable."],
        autoMerged: [],
        unsupportedPaths: [],
      };
    }
    const preview = await previewOrchestrationDelta({
      baselinePath: wave.baselinePath,
      childPath: child.worktreePath,
      targetPath: coordinator.worktreePath,
      childSnapshotPath: result?.workspaceSnapshotPath,
    });
    if (result?.workspaceSnapshotPath) {
      const sincePublication = await previewOrchestrationDelta({ baselinePath: result.workspaceSnapshotPath, childPath: child.worktreePath, targetPath: child.worktreePath });
      if (sincePublication.changedFiles.length || sincePublication.unsupportedPaths.length) {
        preview.conflicts.push("The child workspace changed after publication. Finish a follow-up turn to publish and review a new result.");
      }
    }
    assertCurrentResult();
    const abandonedSubagents = result ? resultAbandonedSubagentCount(this.db, task.id, result.id) : 0;
    return {
      taskId,
      resultId: result?.id,
      status: task.adoptionStatus,
      diff: diffResult.diff,
      ...preview,
      ...(abandonedSubagents > 0
        ? { warnings: [`${String(abandonedSubagents)} provider subagent${abandonedSubagents === 1 ? " was" : "s were"} still running when the child stopped. ${abandonedSubagents === 1 ? "Its" : "Their"} work is not part of this result and may be incomplete.`] }
        : {}),
    };
  }

  private recordOrchestrationAdoptionConflict(task: OrchestrationTaskRecord, reason: string): void {
    this.db.appendOrchestrationEvent({
      orchestrationId: task.orchestrationId,
      taskId: task.id,
      type: "adoption-conflict",
      title: "Adoption blocked",
      content: `Task "${task.title}" could not be adopted: ${reason}`,
    });
  }

  async decideOrchestrationAdoption(input: OrchestrationAdoptionDecisionInput): Promise<void> {
    const source = this.db.getOrchestrationTask(input.taskId);
    await this.services.orchestration.withOrchestrationMutation(source.orchestrationId, async () => {
      try {
        await this.applyOrchestrationAdoptionDecision(input, source.orchestrationId);
      } finally {
        // A coordinator waiting on this decision hears about it, whichever way it went.
        await this.services.orchestrationCoordinator.maybeWakeOrchestrationCoordinator(source.orchestrationId);
      }
    });
  }

  private async applyOrchestrationAdoptionDecision(input: OrchestrationAdoptionDecisionInput, orchestrationId: string): Promise<void> {
    const task = this.db.getOrchestrationTask(input.taskId);
    if (task.orchestrationId !== orchestrationId) {
      throw new Error("The task no longer belongs to the expected orchestration.");
    }
    const orchestration = this.db.getOrchestration(task.orchestrationId);
    const coordinator = this.db.getRun(orchestration.coordinatorRunId);
    const wave = this.db.getOrchestrationWave(task.waveId);
    const adoption = this.db.getOrchestrationAdoption(task.id);
    const result = this.db.listOrchestrationTaskResults(task.id).at(-1);
    if (input.decision === "approve" && input.resultId !== result?.id) {
      throw new Error("The published result changed. Refresh the adoption preview before approving.");
    }
    if (input.decision === "reject") {
      if (task.adoptionStatus === "rejected") return;
      if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
        throw new Error(`Changes cannot be rejected while adoption is ${task.adoptionStatus}.`);
      }
      this.db.updateOrchestrationTask(task.id, { adoptionStatus: "rejected" });
      this.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "rejected",
        // Only an explicit rejection abandons an unresolved interrupted adoption.
        manifest: { ...adoption?.manifest, recoveryNeedsReview: false } });
    } else if (input.decision === "undo") {
      if (!adoption?.backupPath || task.adoptionStatus !== "adopted") throw new Error("No adopted change is available to undo.");
      await undoOrchestrationDelta({ backupPath: adoption.backupPath, targetPath: coordinator.worktreePath });
      this.db.updateOrchestrationTask(task.id, { adoptionStatus: "undone" });
      this.db.upsertOrchestrationAdoption({ orchestrationId: orchestration.id, taskId: task.id, status: "undone" });
    } else {
      if (task.adoptionStatus === "applying" || task.adoptionStatus === "adopted") {
        throw new Error(`Changes cannot be adopted while adoption is ${task.adoptionStatus}.`);
      }
      if (!task.childRunId || !wave.baselinePath || task.status !== "completed" || task.intent !== "implement") {
        throw new Error("Only completed implementation tasks with a valid baseline can be adopted.");
      }
      const preview = await this.getOrchestrationAdoptionPreview(task.id);
      if (preview.conflicts.length || preview.unsupportedPaths.length) {
        this.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
        this.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "conflict",
          manifest: { ...adoption?.manifest, conflicts: preview.conflicts, unsupportedPaths: preview.unsupportedPaths },
        });
        const blocked = [...preview.conflicts, ...preview.unsupportedPaths].join(", ");
        this.recordOrchestrationAdoptionConflict(task, blocked);
        throw new Error(`Adoption is blocked: ${blocked}`);
      }
      const child = this.db.getRun(task.childRunId);
      const backupPath = join(this.services.orchestration.getOrchestrationArtifactRoot(), orchestration.id, "adoptions", task.id, "backup");
      this.db.updateOrchestrationTask(task.id, { adoptionStatus: "applying" });
      this.db.upsertOrchestrationAdoption({
        orchestrationId: orchestration.id,
        taskId: task.id,
        status: "applying",
        backupPath,
        manifest: { changedFiles: preview.changedFiles, resultId: result?.id ?? null },
      });
      await this.db.flushDurable();
      try {
        await applyOrchestrationDelta({
          baselinePath: wave.baselinePath,
          childPath: child.worktreePath,
          targetPath: coordinator.worktreePath,
          backupPath,
          childSnapshotPath: result?.workspaceSnapshotPath,
        });
        this.db.updateOrchestrationTask(task.id, { adoptionStatus: "adopted" });
        this.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "adopted",
          backupPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.db.updateOrchestrationTask(task.id, { adoptionStatus: "conflict" });
        this.db.upsertOrchestrationAdoption({
          orchestrationId: orchestration.id,
          taskId: task.id,
          status: "conflict",
          backupPath,
          errorMessage: message,
          // Another approval would replace the backup, the only copy of the original files.
          ...(error instanceof AdoptionRollbackError
            ? { manifest: { ...this.db.getOrchestrationAdoption(task.id)?.manifest, recoveryNeedsReview: true } }
            : {}),
        });
        this.recordOrchestrationAdoptionConflict(task, message);
        throw error;
      }
    }
    this.db.appendOrchestrationEvent({
      orchestrationId: orchestration.id,
      taskId: task.id,
      type: `adoption-${input.decision}`,
      title: `Adoption ${input.decision}`,
      content: `Task "${task.title}" adoption decision: ${input.decision}.`,
    });
    await this.db.flushDurable();
    this.services.orchestration.emitOrchestrationChanged(orchestration.id, task.id);
  }
}
