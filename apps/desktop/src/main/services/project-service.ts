import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  APP_SETTING_KEYS,
  type CreateProjectBranchInput,
  type DeleteProjectBranchInput,
  isDetachedHeadProjectErrorMessage,
  type MergeProjectBranchInput,
  type ProjectBranchDeleteImpact,
  type ProjectFolderGitStatus,
  type ProjectGitBranchOverview,
  type ProjectGitConversionCandidate,
  type ProjectInput,
  type ProjectRecord,
  type PullProjectBranchInput,
  type PushProjectBranchInput,
  type RebaseProjectBranchInput,
  type RenameProjectBranchInput,
  type RunRecord,
} from "@buildwarden/shared";
import { MANAGED_WORKSPACE_DIR } from "../folder-workspace-constants";
import { AppService } from "./app-service";
import { SELECTED_PROJECT_KEY, SELECTED_RUN_KEY } from "./app-service-constants";
import { projectForgeTokenSecretKey } from "./forge-request-policy";

const readLegacyProjectRunBaseBranches = (
  raw: string | undefined,
): { branchesByProjectId: Record<string, string>; cleaned: string | null } => {
  if (!raw?.trim()) {
    return { branchesByProjectId: {}, cleaned: null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { branchesByProjectId: {}, cleaned: null };
    }
    const records = parsed as Record<string, unknown>;
    const branchesByProjectId: Record<string, string> = {};
    let changed = false;
    for (const [projectId, value] of Object.entries(records)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as Record<string, unknown>;
      if (!("baseBranch" in record)) {
        continue;
      }
      const baseBranch = typeof record.baseBranch === "string" ? record.baseBranch.trim() : "";
      if (baseBranch) {
        branchesByProjectId[projectId] = baseBranch;
      }
      const remaining = { ...record };
      delete remaining.baseBranch;
      records[projectId] = remaining;
      changed = true;
    }
    return { branchesByProjectId, cleaned: changed ? JSON.stringify(records) : null };
  } catch {
    return { branchesByProjectId: {}, cleaned: null };
  }
};

/** Adds and removes projects and manages their Git branches. */
export class ProjectService extends AppService<"chats" | "projectLoops" | "runDeletion" | "settings" | "turnState" | "workspaceGuard"> {
  /** Consolidates the former per-run base setting into the single editable project base branch. */
  async migrateProjectBaseBranches(): Promise<void> {
    const settings = this.db.getSettings();
    if (settings[APP_SETTING_KEYS.projectBaseBranchMigrationVersion] === "1") {
      return;
    }

    const legacy = readLegacyProjectRunBaseBranches(settings[APP_SETTING_KEYS.projectRunDefaults]);
    let failedProjectCount = 0;
    for (const project of this.db.listProjects()) {
      if (project.kind !== "git") {
        continue;
      }
      try {
        const detected = legacy.branchesByProjectId[project.id]
          ? null
          : await this.gitService.validateProject(project.repoPath);
        const baseBranch = legacy.branchesByProjectId[project.id] || (detected?.isGitRepo ? detected.baseBranch : "");
        if (baseBranch && baseBranch !== project.baseBranch) {
          this.db.updateProjectBaseBranch(project.id, baseBranch);
        }
      } catch (error) {
        failedProjectCount += 1;
        this.logControllerError("Could not migrate a project's base branch; retaining its previous value.", error, {
          projectId: project.id,
          repoPath: project.repoPath,
        });
      }
    }

    if (failedProjectCount > 0) {
      throw new Error(`Could not migrate the base branch for ${failedProjectCount} project${failedProjectCount === 1 ? "" : "s"}.`);
    }
    if (legacy.cleaned !== null) {
      this.db.setSetting(APP_SETTING_KEYS.projectRunDefaults, legacy.cleaned);
    }
    this.db.setSetting(APP_SETTING_KEYS.projectBaseBranchMigrationVersion, "1");
  }

  async getProjectBranches(projectId: string): Promise<string[]> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch management");
    const branches = await this.gitService.listTargetBranches(project.repoPath);
    return branches.length > 0 ? branches : [project.baseBranch];
  }

  async getProjectCurrentBranch(projectId: string): Promise<string> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch management");
    try {
      return await this.gitService.getCurrentBranch(project.repoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDetachedHeadProjectErrorMessage(message)) {
        return "";
      }
      throw error;
    }
  }

  async getProjectBranchOverview(projectId: string): Promise<ProjectGitBranchOverview> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch management");
    return this.readProjectBranchOverview(project);
  }

  async checkProjectGitConversion(projectId: string): Promise<ProjectGitConversionCandidate | null> {
    const project = this.db.getProject(projectId);
    if (project.kind !== "folder") {
      return null;
    }
    const validation = await this.gitService.validateProject(project.repoPath);
    if (!validation.isGitRepo) {
      return null;
    }
    const currentBranch = await this.gitService.getCurrentBranch(project.repoPath).catch(() => validation.baseBranch);
    return {
      projectId: project.id,
      repoPath: validation.repoPath,
      repoName: validation.repoName,
      baseBranch: validation.baseBranch,
      currentBranch,
      isWorktree: validation.isWorktree,
      isDirty: validation.isDirty,
    };
  }

  async convertProjectToGit(projectId: string): Promise<ProjectRecord> {
    const project = this.db.getProject(projectId);
    if (project.kind === "git") {
      return project;
    }
    const validation = await this.gitService.validateProject(project.repoPath);
    if (!validation.isGitRepo) {
      throw new Error("This project folder is not a Git repository yet.");
    }
    this.services.workspaceGuard.assertProjectFolderIsRepositoryRoot(project.repoPath, validation);
    const converted = this.db.updateProjectKind(project.id, "git", validation.baseBranch);
    this.db.touchProject(converted.id);
    return converted;
  }

  async updateProjectBaseBranch(projectId: string, branchName: string): Promise<ProjectRecord> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Base branch selection");
      const baseBranch = branchName.trim();
      if (!baseBranch) {
        throw new Error("Select a base branch.");
      }
      const availableBranches = await this.gitService.listTargetBranches(project.repoPath);
      if (!availableBranches.includes(baseBranch)) {
        throw new Error(`Base branch "${baseBranch}" is not available for this project. Refresh branches and choose an existing branch.`);
      }
      return this.db.updateProjectBaseBranch(projectId, baseBranch);
    });
  }

  async checkProjectFolderGitStatus(repoPath: string): Promise<ProjectFolderGitStatus> {
    const trimmed = repoPath.trim();
    if (!trimmed) {
      return { path: "", exists: false, isDirectory: false, isGitRepo: false };
    }
    try {
      if (!existsSync(trimmed)) {
        return { path: trimmed, exists: false, isDirectory: false, isGitRepo: false };
      }
      if (!statSync(trimmed).isDirectory()) {
        return { path: trimmed, exists: true, isDirectory: false, isGitRepo: false };
      }
      const validation = await this.gitService.validateProject(trimmed);
      return { path: trimmed, exists: true, isDirectory: true, isGitRepo: validation.isGitRepo };
    } catch {
      return { path: trimmed, exists: false, isDirectory: false, isGitRepo: false };
    }
  }

  async getProjectBranchDeleteImpact(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectBranchDeleteImpact> {
    const project = this.db.getProject(projectId);
    this.services.workspaceGuard.requireGitProject(project, "Branch management");
    const branchName = input.branchName.trim();
    if (!branchName) {
      throw new Error("Select a branch.");
    }

    return {
      branchName,
      linkedRuns: this.listRunsLinkedToProjectBranch(projectId, branchName).map((run) => ({
        id: run.id,
        prompt: run.prompt,
        status: run.status,
        workspaceType: run.workspaceType,
        branchName: run.branchName,
        worktreePath: run.worktreePath,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })),
    };
  }

  async checkoutProjectBranch(projectId: string, branchName: string): Promise<void> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch checkout");
      this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "checking out a branch");
      await this.gitService.checkoutProjectBranch(project.repoPath, branchName);
    });
  }

  async fetchProjectBranches(projectId: string): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch fetching");
      await this.gitService.fetchProjectBranches(project.repoPath);
      return this.readProjectBranchOverview(project);
    });
  }

  async createProjectBranch(projectId: string, input: CreateProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch creation");
      if (input.checkout !== false) this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "creating and checking out a branch");
      await this.gitService.createProjectBranch(project.repoPath, input.branchName, input.startPoint, input.checkout !== false);
      return this.readProjectBranchOverview(project);
    });
  }

  async renameProjectBranch(projectId: string, input: RenameProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch renaming");
      if (input.oldName.trim() === project.baseBranch) {
        throw new Error("Choose a different project base branch before renaming this branch.");
      }
      if (this.listRunsLinkedToProjectBranch(projectId, input.oldName).length > 0) {
        throw new Error("This branch is used by agent runs and cannot be renamed. Create a new branch instead.");
      }
      await this.gitService.renameProjectBranch(project.repoPath, input.oldName, input.newName);
      return this.readProjectBranchOverview(project);
    });
  }

  async deleteProjectBranch(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch deletion");
      const branchName = input.branchName.trim();
      if (!branchName) {
        throw new Error("Select a branch.");
      }
      if (branchName === project.baseBranch) {
        throw new Error("Choose a different project base branch before deleting this branch.");
      }
      const currentBranch = await this.gitService.getCurrentBranch(project.repoPath).catch(() => "");
      if (branchName === currentBranch) {
        throw new Error("You cannot delete the currently checked out branch.");
      }
      const linkedRuns = this.listRunsLinkedToProjectBranch(projectId, branchName);
      // Deleting a linked run would cancel its agent, so a busy run blocks the deletion instead.
      for (const run of linkedRuns) {
        this.services.workspaceGuard.requireIdleRunWorkspace(run, `deleting the branch "${branchName}"`);
      }
      if (input.deleteRemote === true && input.force !== true) {
        await this.gitService.assertCombinedBranchDeletionSafe(project.repoPath, branchName, project.baseBranch);
      }
      const hasLocalBranch = await this.gitService.hasLocalBranch(project.repoPath, branchName);
      // Decide before deleting linked runs: their history must survive a refused deletion.
      // The base branch counts as a merge target, matching the overview's merged filter and cleanup list.
      if (hasLocalBranch && input.force !== true && !(await this.gitService.isBranchMerged(project.repoPath, branchName, project.baseBranch))) {
        throw new Error(`The branch "${branchName}" is not fully merged. Force delete it to discard its unmerged commits.`);
      }

      for (const run of linkedRuns) {
        // Run cleanup would force-delete the branch; leave that to the merge-checked deletion below.
        await this.services.runDeletion.deleteRun(run.id, { preserveBranch: true });
      }

      if (hasLocalBranch && (await this.gitService.hasLocalBranch(project.repoPath, branchName))) {
        // The check above already decided; `git branch -d` would refuse a branch merged only into the remote base.
        await this.gitService.deleteProjectBranch(project.repoPath, branchName, true);
      }
      return this.readProjectBranchOverview(project);
    });
  }

  async pullProjectBranch(projectId: string, input?: PullProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Git pull");
      const branchName = input?.branchName?.trim() ?? "";
      const currentBranch = branchName ? await this.gitService.getCurrentBranch(project.repoPath).catch(() => "") : "";
      if (branchName && branchName !== currentBranch) {
        await this.gitService.fastForwardBranchFromUpstream(project.repoPath, branchName);
      } else {
        this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "pulling the checked-out branch");
        await this.gitService.pullProjectBranch(project.repoPath);
      }
      return this.readProjectBranchOverview(project);
    });
  }

  async pushProjectBranch(projectId: string, input: PushProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Git push");
      await this.gitService.pushProjectBranch(project.repoPath, input.branchName, input.setUpstream !== false);
      return this.readProjectBranchOverview(project);
    });
  }

  async mergeProjectBranch(projectId: string, input: MergeProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch merging");
      this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "merging into the checked-out branch");
      await this.gitService.mergeIntoCurrentBranch(project.repoPath, input.branchName, input.mode ?? "default");
      return this.readProjectBranchOverview(project);
    });
  }

  async rebaseProjectBranch(projectId: string, input: RebaseProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Branch rebasing");
      this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "rebasing the checked-out branch");
      await this.gitService.rebaseCurrentBranch(project.repoPath, input.onto);
      return this.readProjectBranchOverview(project);
    });
  }

  async abortProjectGitOperation(projectId: string): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Git operation abort");
      this.services.workspaceGuard.requireNoActiveLocalRun(projectId, "aborting the operation in the project checkout");
      await this.gitService.abortInProgressOperation(project.repoPath);
      return this.readProjectBranchOverview(project);
    });
  }

  async deleteProjectRemoteBranch(projectId: string, input: DeleteProjectBranchInput): Promise<ProjectGitBranchOverview> {
    return this.services.workspaceGuard.serializeProjectBranchMutation(projectId, async () => {
      const project = this.db.getProject(projectId);
      this.services.workspaceGuard.requireGitProject(project, "Remote branch deletion");
      const branchName = input.branchName.trim();
      if (branchName === project.baseBranch) {
        throw new Error("Choose a different project base branch before deleting this branch on the remote.");
      }
      await this.gitService.deleteRemoteBranch(project.repoPath, branchName, { force: input.force === true, baseBranch: project.baseBranch });
      return this.readProjectBranchOverview(project);
    });
  }

  /** Branch overview with the BuildWarden runs that use each branch. */
  private async readProjectBranchOverview(project: ProjectRecord): Promise<ProjectGitBranchOverview> {
    const overview = await this.gitService.getProjectBranchOverview(project.repoPath, project.baseBranch);
    const runCounts = new Map<string, number>();
    for (const run of this.db.listRunsForProject(project.id)) {
      if (run.workspaceVcs !== "git") {
        continue;
      }
      const name = this.linkedBranchName(run);
      if (name) {
        runCounts.set(name, (runCounts.get(name) ?? 0) + 1);
      }
    }
    return {
      ...overview,
      branches: overview.branches.map((branch) => ({ ...branch, linkedRunCount: runCounts.get(branch.name) ?? 0 })),
    };
  }

  private listRunsLinkedToProjectBranch(projectId: string, branchName: string): RunRecord[] {
    const normalizedBranchName = branchName.trim();
    if (!normalizedBranchName) {
      return [];
    }
    return this.db.listRunsForProject(projectId).filter((run) => {
      return run.workspaceVcs === "git" && this.linkedBranchName(run) === normalizedBranchName;
    });
  }

  /** The branch a run uses. Its folder name only stands in for a missing name: it may equal an unrelated branch. */
  private linkedBranchName(run: RunRecord): string {
    return run.branchName.trim() || (run.workspaceType === "worktree" ? basename(run.worktreePath) : "");
  }

  async addProject(input: ProjectInput): Promise<ProjectRecord> {
    const repoPath = input.repoPath.trim();
    if (!repoPath) {
      throw new Error("Choose a project folder.");
    }
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      throw new Error("The selected path is not a folder.");
    }
    // A run workspace added as a project would be cleaned up underneath it, or vice versa.
    if (resolve(repoPath).split(/[\\/]+/).some((segment) => segment.toLowerCase() === MANAGED_WORKSPACE_DIR)) {
      throw new Error("This folder is a workspace that BuildWarden created for a run. Add the original project folder instead.");
    }
    const validation = await this.gitService.validateProject(repoPath);
    if (validation.isGitRepo) {
      this.services.workspaceGuard.assertProjectFolderIsRepositoryRoot(repoPath, validation);
    }
    const kind: ProjectRecord["kind"] = validation.isGitRepo ? "git" : "folder";

    const project = this.db.addProject({
      ...input,
      repoPath,
      kind,
      baseBranch: validation.isGitRepo ? validation.baseBranch : "",
      resolvedName: input.name?.trim() || validation.repoName,
    });
    this.db.touchProject(project.id);
    this.db.setSetting(SELECTED_PROJECT_KEY, project.id);
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = this.db.getProject(projectId);

    // Loops first: this cancels their timers/runs and removes loop rows, runs, and stored screenshots.
    for (const loop of this.db.listProjectLoops(projectId)) {
      try {
        await this.services.projectLoops.loopRunner.deleteLoop(loop.id);
      } catch (loopError) {
        this.logControllerWarn("Could not delete a project loop while deleting the project.", { projectId, loopId: loop.id, error: loopError });
      }
    }

    const runs = this.db.listRunsForProject(projectId);
    for (const run of runs) {
      for (const chat of this.db.getChatsForRun(run.id)) {
        await this.services.chats.deleteChat(chat.id);
      }
      this.terminal.killForRunId(run.id);
      this.services.turnState.clearRunCheckpoint(run.id);
      this.services.turnState.clearRunPromptRestorePoint(run.id);
      this.db.deleteProviderSessionRuntime(run.id, "run");
      if (run.kind === "council-review" && !existsSync(run.worktreePath)) continue;
      await this.services.runDeletion.deleteRunResources(project.repoPath, run, "project");
    }

    await this.secrets.deleteSecret(projectForgeTokenSecretKey(projectId));
    this.services.settings.setProjectForgePrMonitorInterval(projectId, 0);
    this.db.deleteProject(projectId);
    runs.forEach((run) => this.services.runDeletion.notifyRunDeleted(run.id));

    const remainingProjects = this.db.listProjects();
    if (remainingProjects.length > 0) {
      this.db.setSetting(SELECTED_PROJECT_KEY, remainingProjects[0].id);
    } else {
      this.db.deleteSetting(SELECTED_PROJECT_KEY);
    }
    this.db.deleteSetting(SELECTED_RUN_KEY);
  }

  async pickProjectDirectory(): Promise<string | null> {
    return this.desktop.pickProjectDirectory();
  }
}
