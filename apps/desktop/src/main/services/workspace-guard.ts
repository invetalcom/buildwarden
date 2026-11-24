import { existsSync } from "node:fs";
import { isSameWorktreePath } from "@buildwarden/git-service";
import { APP_SETTING_KEYS, type GitProjectValidation, type ProjectRecord, type RunRecord, type WorktreeStatus } from "@buildwarden/shared";
import { getChatWorkspacePath } from "../chat-workspace";
import { getFolderSnapshotRoot } from "../folder-diff";
import { workspacePathsOverlap } from "../workspace-restore-safety";
import { AppService } from "./app-service";
import { ACTIVE_RUN_STATUSES } from "./app-service-constants";

/** Keeps agents, Git operations and file restores from changing the same workspace at once. */
export class WorkspaceGuard extends AppService<"activeWorkers"> {
  readonly manualVerifications = new Map<string, { abort: AbortController; completion: Promise<void> }>();
  readonly pendingManualVerifications = new Map<string, { abort: AbortController; completion: Promise<void> }>();
  readonly restoringWorkspaces = new Set<string>();
  /** Serializes Git branch mutations per project while allowing different projects to proceed independently. */
  private readonly projectBranchMutations = new Map<string, Promise<unknown>>();
  /** Prevents concurrent agents from mutating the same checked-out project workspace. */
  private readonly projectLocalRunStarts = new Map<string, Promise<unknown>>();

  getFolderSnapshotRoot(): string {
    return getFolderSnapshotRoot(this.db.getFilePath());
  }

  getConfiguredWorktreeRoot(): string | undefined {
    return this.db.getSettings()[APP_SETTING_KEYS.worktreeRootOverride]?.trim() || undefined;
  }

  /** Worktrees, branches and runs all operate on the whole repository, so a subfolder cannot be a Git project. */
  assertProjectFolderIsRepositoryRoot(repoPath: string, validation: GitProjectValidation): void {
    if (!isSameWorktreePath(validation.repoRoot, repoPath)) {
      throw new Error(`This folder is inside the Git repository at ${validation.repoRoot}. Add the repository root as the project instead.`);
    }
  }

  requireGitProject(project: ProjectRecord, featureLabel: string): void {
    if (project.kind !== "git") {
      throw new Error(`${featureLabel} is only available for Git projects.`);
    }
  }

  serializeProjectBranchMutation<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.projectBranchMutations.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    this.projectBranchMutations.set(projectId, current);
    return current.finally(() => {
      if (this.projectBranchMutations.get(projectId) === current) {
        this.projectBranchMutations.delete(projectId);
      }
    });
  }

  serializeRunStart<T>(runId: string, start: () => Promise<T>): Promise<T> {
    if (this.manualVerifications.has(runId)) throw new Error("Wait for verification to finish or cancel it first.");
    return this.serializeProjectBranchMutation(this.db.getRun(runId).projectId, async () => {
      if (this.manualVerifications.has(runId)) throw new Error("Wait for verification to finish or cancel it first.");
      if (this.services.activeWorkers.runWorkers.has(runId)) throw new Error("This run is already active.");
      this.requireWorkspaceNotRestoring(this.db.getRun(runId).worktreePath);
      return start();
    });
  }

  requireGitRun(run: RunRecord, featureLabel: string): void {
    if (run.workspaceVcs !== "git") {
      throw new Error(`${featureLabel} is only available for Git-backed runs.`);
    }
  }

  /** Branch moves and worktree removal must never happen underneath a live agent or verification. */
  requireIdleRunWorkspace(run: RunRecord, action: string): void {
    if (ACTIVE_RUN_STATUSES.has(run.status) || this.services.activeWorkers.runWorkers.has(run.id) || this.manualVerifications.has(run.id)) {
      throw new Error(`Wait for the agent to finish before ${action}.`);
    }
  }

  requireWorkspaceNotRestoring(path: string): void {
    if ([...this.restoringWorkspaces, ...this.db.listPendingRewindWorkspaces()].some((restoring) => workspacePathsOverlap(restoring, path))) {
      throw new Error("Wait for workspace restoration to finish before starting another agent.");
    }
  }

  requireIsolatedRestoreWorkspace(run: RunRecord): void {
    this.requireIdleRunWorkspace(this.db.getRun(run.id), "undoing changes");
    const others = this.db.listProjects().flatMap((project) => this.db.listRunsForProject(project.id))
      .filter((other) => other.id !== run.id)
      .map((other) => other.workspaceType === "worktree" && !existsSync(other.worktreePath)
        ? this.getEffectiveRunWorkspacePath(other) : other.worktreePath);
    others.push(...this.db.listAllChats().map((chat) => getChatWorkspacePath(this.db.getFilePath(), chat.id)));
    others.push(...this.db.listProviderSessionWorkspaces()
      .filter((session) => session.ownerKind !== "run" || session.ownerId !== run.id)
      .map((session) => session.cwd));
    if (others.some((path) => workspacePathsOverlap(run.worktreePath, path))) {
      throw new Error("Cannot undo files in a workspace shared with another run or chat. Their changes must be preserved; use an isolated worktree instead.");
    }
  }

  /**
   * Promotion checks a branch out in the project repository, which active local runs use as their workspace.
   * Callers check before any commit or push; run starts share the project lock, so none can start in between.
   */
  requireIdleProjectCheckout(run: RunRecord, action: string): void {
    this.requireNoActiveLocalRun(run.projectId, action, run.id);
  }

  /** Active local runs use the project checkout as their workspace, so Git must not rewrite it underneath them. */
  requireNoActiveLocalRun(projectId: string, action: string, exceptRunId?: string): void {
    const busyLocalRun = this.db
      .listRunsForProject(projectId)
      .some(
        (other) =>
          other.id !== exceptRunId &&
          other.workspaceType === "local" &&
          (ACTIVE_RUN_STATUSES.has(other.status) || this.services.activeWorkers.runWorkers.has(other.id) || this.manualVerifications.has(other.id)),
      );
    if (busyLocalRun) {
      throw new Error(`Wait for the agent using the project checkout to finish before ${action}.`);
    }
  }

  getRunWorkspaceLabel(run: RunRecord): string {
    if (run.workspaceVcs === "folder") {
      return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
    }
    return run.workspaceType === "local" ? `Local repository on ${run.branchName}` : `Worktree ${run.branchName}`;
  }

  getEffectiveRunWorkspacePath(run: RunRecord, project?: ProjectRecord): string {
    const owningProject = project ?? this.db.getProject(run.projectId);
    const branchPromotedToProject = this.wasRunPromotedToProject(run.id);
    return run.workspaceType === "worktree" && !existsSync(run.worktreePath) && branchPromotedToProject
      ? owningProject.repoPath
      : run.worktreePath;
  }

  serializeProjectLocalRunStart<T>(projectId: string, start: () => Promise<T>): Promise<T> {
    const previous = this.projectLocalRunStarts.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(start);
    this.projectLocalRunStarts.set(projectId, current);
    return current.finally(() => {
      if (this.projectLocalRunStarts.get(projectId) === current) this.projectLocalRunStarts.delete(projectId);
    });
  }

  updateWorktreeStatus(run: RunRecord, status: WorktreeStatus): void {
    if (run.workspaceType !== "worktree" && run.workspaceType !== "copy") {
      return;
    }

    this.db.upsertWorktree({
      id: run.id,
      projectId: run.projectId,
      runId: run.id,
      branchName: run.branchName,
      worktreePath: run.worktreePath,
      status,
    });
  }

  wasRunPromotedToProject(runId: string): boolean {
    return this.db
      .getRunSteps(runId)
      .some((step) => {
        try {
          const metadata = JSON.parse(step.metadataJson || "{}") as Record<string, unknown>;
          return metadata.promotedToProject === true;
        } catch {
          return false;
        }
      });
  }
}
