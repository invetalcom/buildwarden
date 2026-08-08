import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS } from "@buildwarden/shared";
import type {
  ModelRecord,
  OrchestrationRecord,
  OrchestrationTaskRecord,
  ProjectRecord,
  ProjectTaskRecord,
  ProviderAccountRecord,
  RunRecord,
} from "@buildwarden/shared";
import type { SecretStore } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "@buildwarden/git-service";
import { AppController, latestUserTurnUsedFullAccess } from "./app-controller";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { HostEventBus } from "./host-events";
import type { ProjectPrReviewProvider } from "./pr-review/pr-review-types";

const project = {
  id: "project-1",
  name: "Project",
  kind: "git",
  repoPath: "C:\\repo",
  baseBranch: "main",
} as ProjectRecord;

const provider = {
  id: "provider-1",
  providerType: "ai-sdk",
  label: "Provider",
  apiBaseUrl: null,
  apiKeyRef: "secret-1",
  configJson: "{}",
} as ProviderAccountRecord;

const model = {
  id: "model-1",
  providerAccountId: provider.id,
  modelId: "gpt-5",
  displayName: "GPT-5",
  baseUrlOverride: null,
  configJson: "{}",
  capabilitiesJson: "{}",
  enabled: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as ModelRecord;

const task = {
  id: "task-1",
  projectId: project.id,
  title: "Task",
  prompt: "Prompt",
  status: "open",
  runId: null,
  pullRequestUrl: null,
} as ProjectTaskRecord;

type DbOverrides = Partial<Record<keyof BuildWardenDatabase, unknown>>;

const createHarness = (overrides: DbOverrides = {}) => {
  const settings: Record<string, string> = {};
  const calls = {
    setSetting: vi.fn((key: string, value: string) => { settings[key] = value; }),
    deleteSetting: vi.fn((key: string) => { delete settings[key]; }),
    updateProjectBaseBranch: vi.fn((_projectId: string, baseBranch: string) => ({ ...project, baseBranch })),
  };
  const defaults: DbOverrides = {
    getSettings: vi.fn(() => ({ ...settings })),
    getSnapshot: vi.fn(() => ({ projects: [], providerAccounts: [], models: [], runs: [], chats: [], bookmarks: [], chatBookmarks: [], settings: {} })),
    getProject: vi.fn(() => project),
    listProjects: vi.fn(() => [project]),
    touchProject: vi.fn(),
    updateProjectBaseBranch: calls.updateProjectBaseBranch,
    setSetting: calls.setSetting,
    deleteSetting: calls.deleteSetting,
    getProviderAccount: vi.fn(() => provider),
    addProviderAccount: vi.fn((input: object) => ({ ...provider, ...input })),
    countRunsForProviderAccount: vi.fn(() => 0),
    deleteProviderAccount: vi.fn(),
    getModel: vi.fn(() => model),
    addModel: vi.fn((input: object) => ({ ...model, ...input })),
    countRunsForModel: vi.fn(() => 0),
    deleteModel: vi.fn(),
    createProjectTask: vi.fn((_projectId: string, input: object) => ({ ...task, ...input })),
    getProjectTask: vi.fn(() => task),
    updateProjectTask: vi.fn((_taskId: string, input: object) => ({ ...task, ...input })),
    deleteProjectTask: vi.fn(),
    addRunNote: vi.fn((_runId: string, content: string) => ({ id: "note-1", runId: "run-1", content, status: "open" })),
    updateRunNote: vi.fn((_noteId: string, input: object) => ({ id: "note-1", runId: "run-1", content: "note", status: "open", ...input })),
    deleteRunNote: vi.fn(),
    updateRunListVisibility: vi.fn((_runId: string, visibility: string) => ({ id: "run-1", listVisibility: visibility } as RunRecord)),
    getOrchestrationTaskByChildRunId: vi.fn(() => null),
    getOrchestrationByCoordinatorRunId: vi.fn(() => null),
  };
  const db = { ...defaults, ...overrides } as unknown as BuildWardenDatabase;
  const secrets = {
    readSecret: vi.fn(async () => null),
    saveSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
  } satisfies SecretStore;
  const desktop = {
    pickProjectDirectory: vi.fn(async () => null),
    pickIdeExecutable: vi.fn(async () => null),
    openPathInFileManager: vi.fn(async () => ({ ok: true })),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    launchIdeWithFolder: vi.fn(async () => undefined),
  } satisfies AppControllerDesktopServices;
  const terminal = { killForRunId: vi.fn() };
  const events = new HostEventBus();
  const lifecycle = { onRunDeleted: vi.fn() };
  const logDir = mkdtempSync(join(tmpdir(), "buildwarden-controller-"));
  return {
    controller: new AppController(db, secrets, logDir, desktop, terminal, events, lifecycle),
    db,
    secrets,
    desktop,
    terminal,
    events,
    lifecycle,
    settings,
    calls,
    logDir,
  };
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const createMutableProjectHarness = () => {
  let currentProject = { ...project };
  const harness = createHarness({
    getProject: vi.fn(() => currentProject),
    updateProjectBaseBranch: vi.fn((_projectId: string, baseBranch: string) => {
      currentProject = { ...currentProject, baseBranch };
      return currentProject;
    }),
  });
  return { ...harness, getCurrentProject: () => currentProject };
};

describe("AppController settings and lightweight workflows", () => {
  it("bypasses a cached forge request list for forced post-creation detection", async () => {
    const harness = createHarness();
    const empty = { provider: "github", webBaseUrl: "https://github.com/acme/repo", repoLabel: "acme/repo", items: [] } as const;
    const withRequest = {
      ...empty,
      items: [{
        provider: "github",
        number: 13,
        title: "New request",
        url: "https://github.com/acme/repo/pull/13",
        state: "open",
        draft: false,
        author: "author",
        sourceBranch: "feature",
        targetBranch: "main",
        createdAt: null,
        updatedAt: null,
      }],
    } as const;
    const forgeProvider = {
      listRequests: vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(withRequest),
    } as unknown as ProjectPrReviewProvider;
    const controller = harness.controller as unknown as {
      loadProjectForgeRequests: (
        projectId: string,
        provider: ProjectPrReviewProvider,
        input: { state: "all" },
        bypassCache?: boolean,
      ) => Promise<{ items: readonly unknown[] }>;
    };

    expect((await controller.loadProjectForgeRequests(project.id, forgeProvider, { state: "all" })).items).toHaveLength(0);
    expect((await controller.loadProjectForgeRequests(project.id, forgeProvider, { state: "all" })).items).toHaveLength(0);
    expect((await controller.loadProjectForgeRequests(project.id, forgeProvider, { state: "all" }, true)).items).toHaveLength(1);
    expect(forgeProvider.listRequests).toHaveBeenCalledTimes(2);
  });

  it("relinks a terminal request to a newer open request on the same branch", async () => {
    const run = {
      id: "run-1",
      projectId: project.id,
      workspaceVcs: "git",
      workspaceType: "local",
      worktreePath: project.repoPath,
      branchName: "feature",
    } as RunRecord;
    const oldRequest = {
      provider: "github" as const,
      number: 13,
      title: "Closed request",
      url: "https://github.com/acme/repo/pull/13",
      state: "closed",
      draft: false,
      author: "author",
      sourceBranch: "feature",
      targetBranch: "main",
      createdAt: "2026-08-08T08:00:00.000Z",
      updatedAt: "2026-08-08T09:00:00.000Z",
    };
    const newRequest = {
      ...oldRequest,
      number: 14,
      title: "Replacement request",
      url: "https://github.com/acme/repo/pull/14",
      state: "open",
      createdAt: "2026-08-08T10:00:00.000Z",
      updatedAt: "2026-08-08T11:00:00.000Z",
    };
    const oldSummary = {
      ...oldRequest,
      state: "closed" as const,
      readiness: "closed" as const,
      mergeability: "unknown" as const,
      reviewDecision: "none" as const,
      headSha: "head-sha",
      checks: { completed: 0, total: 0, successful: 0, failed: 0, running: 0 },
      unresolvedThreadCount: 0,
      supportedActions: ["refresh", "open", "reopen"] as const,
      supportedMergeMethods: ["merge"] as const,
      lastSyncedAt: "2026-08-08T09:00:00.000Z",
      stale: false,
      syncError: null,
    };
    const saveRunForgeRequest = vi.fn();
    const harness = createHarness({
      getRun: vi.fn(() => run),
      getRunSteps: vi.fn(() => []),
      getRunForgeRequestCache: vi.fn(() => ({
        runId: run.id,
        projectId: project.id,
        branchName: "feature",
        headSha: "head-sha",
        lastProbeAt: oldSummary.lastSyncedAt,
        negativeCacheUntil: null,
        summary: oldSummary,
        details: null,
        etag: null,
        lastModified: null,
        errorCount: 0,
        retryAfterAt: null,
      })),
      saveRunForgeRequest,
      saveRunForgeSyncError: vi.fn(() => null),
    });
    vi.spyOn(GitService.prototype, "getHeadCommitSha").mockResolvedValue("head-sha");
    vi.spyOn(GitService.prototype, "getCurrentBranch").mockResolvedValue("feature");
    const forgeProvider = {
      listRequests: vi.fn(async () => ({
        provider: "github" as const,
        webBaseUrl: "https://github.com/acme/repo",
        repoLabel: "acme/repo",
        items: [oldRequest, newRequest],
      })),
      getRequestStatus: vi.fn(async () => ({
        state: "open" as const,
        draft: false,
        mergeability: "mergeable" as const,
        reviewDecision: "none" as const,
        headSha: "head-sha",
        checks: [],
        unresolvedThreadCount: 0,
        supportedActions: ["refresh", "open", "mark-draft", "merge", "close"] as const,
        supportedMergeMethods: ["merge"] as const,
      })),
      getRequestDetails: vi.fn(async () => ({
        provider: "github" as const,
        webBaseUrl: "https://github.com/acme/repo",
        repoLabel: "acme/repo",
        request: {
          ...newRequest,
          description: "Replacement details",
          authorUser: null,
          labels: [],
          additions: 1,
          deletions: 0,
          changedFiles: 1,
          commentCount: 0,
          reviewCommentCount: 0,
        },
        activity: [],
        commits: [],
        files: [],
        reviewThreads: [],
        warnings: [],
      })),
    } as unknown as ProjectPrReviewProvider;
    const internalController = harness.controller as unknown as {
      createProjectPrReviewProvider: (projectId: string) => Promise<ProjectPrReviewProvider>;
    };
    internalController.createProjectPrReviewProvider = vi.fn(async () => forgeProvider);

    const result = await harness.controller.refreshRunForgeRequest(run.id);

    expect(result?.number).toBe(14);
    expect(forgeProvider.getRequestStatus).toHaveBeenCalledWith(expect.objectContaining({ prUrl: newRequest.url }));
    expect(forgeProvider.getRequestDetails).toHaveBeenCalledWith({ prUrl: newRequest.url });
    expect(saveRunForgeRequest).toHaveBeenCalledWith(
      run.id,
      project.id,
      "feature",
      "head-sha",
      expect.objectContaining({ number: 14, url: newRequest.url }),
      expect.objectContaining({ request: expect.objectContaining({ number: 14 }) }),
      expect.any(Object),
    );
  });

  it("inherits full access only from the latest coordinator user turn", () => {
    expect(latestUserTurnUsedFullAccess([
      { metadataJson: JSON.stringify({ source: "user", commandType: "initial", yoloMode: true }) },
      { metadataJson: "{malformed" },
      { metadataJson: JSON.stringify({ source: "user", commandType: "goal" }) },
      { metadataJson: JSON.stringify({ source: "user", commandType: "follow-up", yoloMode: false }) },
    ])).toBe(false);

    expect(latestUserTurnUsedFullAccess([
      { metadataJson: JSON.stringify({ source: "user", commandType: "initial", yoloMode: false }) },
      { metadataJson: JSON.stringify({ source: "user", commandType: "follow-up", yoloMode: true }) },
    ])).toBe(true);
  });

  it("cancels the durable orchestration when its coordinator run is cancelled", async () => {
    let orchestration: OrchestrationRecord = {
      id: "orchestration-1",
      projectId: project.id,
      coordinatorRunId: "coordinator-1",
      status: "active",
      teamSnapshot: {
        version: 1,
        maxConcurrentTasks: 3,
        maxTasksPerOrchestration: 12,
        models: [],
        roles: [],
      },
      wakeMode: "all-terminal",
      wakeTaskIds: ["orchestration-task-1"],
      lastEventSequence: 1,
      lastDeliveredSequence: 0,
      errorMessage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: null,
    };
    let orchestrationTask: OrchestrationTaskRecord = {
      id: "orchestration-task-1",
      orchestrationId: orchestration.id,
      waveId: "wave-1",
      clientTaskId: "client-task-1",
      title: "Inspect the workspace",
      prompt: "Inspect the workspace.",
      roleId: "researcher",
      modelId: model.id,
      intent: "inspect",
      status: "running",
      childRunId: "child-1",
      retryOfTaskId: null,
      summary: null,
      errorMessage: null,
      attentionReason: null,
      adoptionStatus: "none",
      inputTokens: 0,
      outputTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      startedAt: "2026-01-01T00:00:10.000Z",
      finishedAt: null,
    };
    const updateOrchestration = vi.fn((_id: string, input: Partial<OrchestrationRecord>) => {
      orchestration = { ...orchestration, ...input };
      return orchestration;
    });
    const updateOrchestrationTask = vi.fn((_id: string, input: Partial<OrchestrationTaskRecord>) => {
      orchestrationTask = { ...orchestrationTask, ...input };
      return orchestrationTask;
    });
    const flushDurable = vi.fn(async () => undefined);
    const harness = createHarness({
      getOrchestrationByCoordinatorRunId: vi.fn((runId: string) =>
        runId === orchestration.coordinatorRunId ? orchestration : null),
      getOrchestration: vi.fn(() => orchestration),
      getOrchestrationTask: vi.fn(() => orchestrationTask),
      listOrchestrationTasks: vi.fn(() => [orchestrationTask]),
      updateOrchestration,
      updateOrchestrationTask,
      appendOrchestrationEvent: vi.fn(),
      flushDurable,
    });
    tempDirs.push(harness.logDir);

    await harness.controller.cancelRun(orchestration.coordinatorRunId);

    expect(updateOrchestration).toHaveBeenCalledWith(orchestration.id, expect.objectContaining({
      status: "cancelled",
      finishedAt: expect.any(String),
    }));
    expect(updateOrchestrationTask).toHaveBeenCalledWith(orchestrationTask.id, expect.objectContaining({
      status: "cancelled",
      finishedAt: expect.any(String),
    }));
    expect(flushDurable).toHaveBeenCalled();
    expect(orchestration.status).toBe("cancelled");
    expect(orchestrationTask.status).toBe("cancelled");
  });

  it("does not create retries after an orchestration is terminal", async () => {
    const orchestration = {
      id: "orchestration-1",
      status: "completed",
      teamSnapshot: { maxTasksPerOrchestration: 12 },
    } as OrchestrationRecord;
    const completedTask = {
      id: "orchestration-task-1",
      orchestrationId: orchestration.id,
      status: "completed",
    } as OrchestrationTaskRecord;
    const createOrchestrationTask = vi.fn();
    const harness = createHarness({
      getOrchestrationTask: vi.fn(() => completedTask),
      getOrchestration: vi.fn(() => orchestration),
      createOrchestrationTask,
    });
    tempDirs.push(harness.logDir);

    await expect(harness.controller.retryOrchestrationTask(completedTask.id))
      .rejects.toThrow("Tasks cannot be retried while the orchestration is completed.");
    expect(createOrchestrationTask).not.toHaveBeenCalled();
  });

  it("serializes adoption decisions and re-reads task state inside the lock", async () => {
    const orchestration = {
      id: "orchestration-1",
      coordinatorRunId: "coordinator-1",
    } as OrchestrationRecord;
    let adoptionTask = {
      id: "orchestration-task-1",
      orchestrationId: orchestration.id,
      waveId: "wave-1",
      title: "Implementation",
      adoptionStatus: "proposed",
    } as OrchestrationTaskRecord;
    const firstFlush = deferred<void>();
    const updateOrchestrationTask = vi.fn((_taskId: string, input: Partial<OrchestrationTaskRecord>) => {
      adoptionTask = { ...adoptionTask, ...input };
      return adoptionTask;
    });
    const flushDurable = vi.fn()
      .mockImplementationOnce(() => firstFlush.promise)
      .mockResolvedValue(undefined);
    const appendOrchestrationEvent = vi.fn();
    const harness = createHarness({
      getOrchestrationTask: vi.fn(() => adoptionTask),
      getOrchestration: vi.fn(() => orchestration),
      getRun: vi.fn(() => ({ id: orchestration.coordinatorRunId, worktreePath: project.repoPath } as RunRecord)),
      getOrchestrationWave: vi.fn(() => ({ id: adoptionTask.waveId })),
      getOrchestrationAdoption: vi.fn(() => null),
      updateOrchestrationTask,
      upsertOrchestrationAdoption: vi.fn(),
      appendOrchestrationEvent,
      flushDurable,
    });
    tempDirs.push(harness.logDir);

    const first = harness.controller.decideOrchestrationAdoption({ taskId: adoptionTask.id, decision: "reject" });
    const second = harness.controller.decideOrchestrationAdoption({ taskId: adoptionTask.id, decision: "reject" });
    await vi.waitFor(() => expect(flushDurable).toHaveBeenCalledTimes(1));
    expect(updateOrchestrationTask).toHaveBeenCalledTimes(1);

    firstFlush.resolve();
    await Promise.all([first, second]);

    expect(adoptionTask.adoptionStatus).toBe("rejected");
    expect(updateOrchestrationTask).toHaveBeenCalledTimes(1);
    expect(appendOrchestrationEvent).toHaveBeenCalledTimes(1);
  });

  it("retries transient Windows worktree locks during run deletion", async () => {
    const run = {
      id: "run-1",
      projectId: project.id,
      workspaceType: "worktree",
      workspaceVcs: "git",
      worktreePath: "C:\\managed\\run-1",
      branchName: "buildwarden-run-1",
    } as RunRecord;
    const removeWorktree = vi.fn()
      .mockRejectedValueOnce(new Error("filesystem removal failed: EBUSY: resource busy or locked"))
      .mockResolvedValueOnce(undefined);
    const harness = createHarness();
    tempDirs.push(harness.logDir);
    const controller = harness.controller as unknown as {
      gitService: { removeWorktree: typeof removeWorktree };
      deleteRunResources: (repoPath: string, run: RunRecord, context: "run" | "project") => Promise<void>;
    };
    controller.gitService.removeWorktree = removeWorktree;

    await controller.deleteRunResources(project.repoPath, run, "run");

    expect(removeWorktree).toHaveBeenCalledTimes(2);
    expect(removeWorktree).toHaveBeenLastCalledWith(project.repoPath, run.worktreePath, run.branchName);
  });

  it("does not expose Git command details when a worktree summary fails", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "buildwarden-summary-error-"));
    tempDirs.push(workspacePath);
    const run = {
      id: "run-summary-error",
      projectId: project.id,
      workspaceType: "local",
      workspaceVcs: "git",
      worktreePath: workspacePath,
      branchName: "main",
    } as RunRecord;
    const harness = createHarness({
      getRun: vi.fn(() => run),
      getRunSteps: vi.fn(() => []),
    });
    tempDirs.push(harness.logDir);
    const getDiffSummary = vi.fn().mockRejectedValue(new Error(`git failed in ${workspacePath}`));
    (harness.controller as unknown as { gitService: { getDiffSummary: typeof getDiffSummary } }).gitService.getDiffSummary = getDiffSummary;

    const result = await harness.controller.getRunWorktreeDiffSummary(run.id);

    expect(result).toEqual({
      summary: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 },
      worktreeUnavailable: true,
      diffUnavailableReason: "The Git workspace is no longer available.",
    });
  });

  it("coalesces concurrent worktree summaries for the same path", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "buildwarden-summary-coalesce-"));
    tempDirs.push(workspacePath);
    const run = {
      id: "run-summary-coalesce",
      projectId: project.id,
      workspaceType: "local",
      workspaceVcs: "git",
      worktreePath: workspacePath,
      branchName: "main",
    } as RunRecord;
    const harness = createHarness({
      getRun: vi.fn(() => run),
      getRunSteps: vi.fn(() => []),
    });
    tempDirs.push(harness.logDir);
    const summaryRequest = deferred<Awaited<ReturnType<GitService["getDiffSummary"]>>>();
    const getDiffSummary = vi.fn(() => summaryRequest.promise);
    (harness.controller as unknown as { gitService: { getDiffSummary: typeof getDiffSummary } }).gitService.getDiffSummary = getDiffSummary;

    const first = harness.controller.getRunWorktreeDiffSummary(run.id);
    const second = harness.controller.getRunWorktreeDiffSummary(run.id);
    expect(getDiffSummary).toHaveBeenCalledTimes(1);

    const summary = { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 };
    summaryRequest.resolve(summary);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { summary, worktreeUnavailable: false },
      { summary, worktreeUnavailable: false },
    ]);

    await harness.controller.getRunWorktreeDiffSummary(run.id);
    expect(getDiffSummary).toHaveBeenCalledTimes(2);
  });

  it("automatically completes an orchestration after its delivered terminal wave is summarized", async () => {
    const orchestration = {
      id: "orchestration-1",
      projectId: project.id,
      coordinatorRunId: "coordinator-1",
      status: "active",
      teamSnapshot: {
        version: 1,
        maxConcurrentTasks: 3,
        maxTasksPerOrchestration: 12,
        models: [],
        roles: [],
      },
      wakeMode: null,
      wakeTaskIds: [],
      lastEventSequence: 4,
      lastDeliveredSequence: 4,
      errorMessage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: null,
    } satisfies OrchestrationRecord;
    const completedTask = {
      id: "orchestration-task-1",
      orchestrationId: orchestration.id,
      waveId: "wave-1",
      clientTaskId: "client-task-1",
      title: "Inspect the workspace",
      prompt: "Inspect the workspace.",
      roleId: "researcher",
      modelId: model.id,
      intent: "inspect",
      status: "completed",
      childRunId: "child-1",
      retryOfTaskId: null,
      summary: "Inspection complete.",
      errorMessage: null,
      attentionReason: null,
      adoptionStatus: "none",
      inputTokens: 100,
      outputTokens: 20,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      startedAt: "2026-01-01T00:00:10.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    } satisfies OrchestrationTaskRecord;
    const updateOrchestration = vi.fn();
    const appendOrchestrationEvent = vi.fn();
    const harness = createHarness({
      getOrchestrationByCoordinatorRunId: vi.fn(() => orchestration),
      getOrchestration: vi.fn(() => orchestration),
      listOrchestrationTasks: vi.fn(() => [completedTask]),
      updateOrchestration,
      appendOrchestrationEvent,
    });
    tempDirs.push(harness.logDir);

    await (harness.controller as unknown as {
      handleOrchestrationCoordinatorTurnTerminal: (runId: string) => Promise<void>;
    }).handleOrchestrationCoordinatorTurnTerminal(orchestration.coordinatorRunId);

    expect(updateOrchestration).toHaveBeenCalledWith(orchestration.id, expect.objectContaining({
      status: "completed",
      wakeMode: null,
      wakeTaskIds: [],
    }));
    expect(appendOrchestrationEvent).toHaveBeenCalledWith(expect.objectContaining({
      orchestrationId: orchestration.id,
      type: "completed",
    }));
  });

  it("notifies host services after a run is deleted", async () => {
    const run = {
      id: "run-1",
      projectId: project.id,
      workspaceType: "local",
      workspaceVcs: "git",
      worktreePath: project.repoPath,
      branchName: "main",
    } as RunRecord;
    const deleteRun = vi.fn();
    const harness = createHarness({
      getRun: vi.fn(() => run),
      getChatsForRun: vi.fn(() => []),
      deleteProviderSessionRuntime: vi.fn(),
      deleteRun,
    });
    tempDirs.push(harness.logDir);

    await harness.controller.deleteRun(run.id);

    expect(deleteRun).toHaveBeenCalledWith(run.id);
    expect(harness.lifecycle.onRunDeleted).toHaveBeenCalledWith(run.id);
  });

  it("continues post-delete cleanup when a run lifecycle callback throws", async () => {
    const run = {
      id: "run-1",
      projectId: project.id,
      workspaceType: "local",
      workspaceVcs: "git",
      worktreePath: project.repoPath,
      branchName: "main",
    } as RunRecord;
    const harness = createHarness({
      getRun: vi.fn(() => run),
      getChatsForRun: vi.fn(() => []),
      deleteProviderSessionRuntime: vi.fn(),
      deleteRun: vi.fn(),
    });
    tempDirs.push(harness.logDir);
    harness.lifecycle.onRunDeleted.mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    await expect(harness.controller.deleteRun(run.id)).resolves.toBeUndefined();

    expect(harness.calls.deleteSetting).toHaveBeenCalledWith("selectedRunId");
    expect(harness.calls.setSetting).toHaveBeenCalledWith("selectedProjectId", project.id);
  });

  it("migrates the former run base into the single project base branch", async () => {
    const harness = createHarness();
    tempDirs.push(harness.logDir);
    harness.settings[APP_SETTING_KEYS.projectRunDefaults] = JSON.stringify({
      [project.id]: { mode: "code", workspaceType: "worktree", baseBranch: "release/next", modelId: "" },
    });

    await harness.controller.migrateProjectBaseBranches();

    expect(harness.calls.updateProjectBaseBranch).toHaveBeenCalledWith(project.id, "release/next");
    expect(JSON.parse(harness.settings[APP_SETTING_KEYS.projectRunDefaults]!)).toEqual({
      [project.id]: { mode: "code", workspaceType: "worktree", modelId: "" },
    });
    expect(harness.settings[APP_SETTING_KEYS.projectBaseBranchMigrationVersion]).toBe("1");
  });

  it("retains legacy base-branch settings and retries after a project migration fails", async () => {
    const harness = createHarness({
      updateProjectBaseBranch: vi.fn(() => {
        throw new Error("database unavailable");
      }),
    });
    tempDirs.push(harness.logDir);
    const legacySettings = JSON.stringify({
      [project.id]: { mode: "code", workspaceType: "worktree", baseBranch: "release/next", modelId: "" },
    });
    harness.settings[APP_SETTING_KEYS.projectRunDefaults] = legacySettings;

    await expect(harness.controller.migrateProjectBaseBranches()).rejects.toThrow("Could not migrate the base branch for 1 project.");

    expect(harness.settings[APP_SETTING_KEYS.projectRunDefaults]).toBe(legacySettings);
    expect(harness.settings[APP_SETTING_KEYS.projectBaseBranchMigrationVersion]).toBeUndefined();
  });

  it("serializes project base-branch updates in request order", async () => {
    const harness = createMutableProjectHarness();
    tempDirs.push(harness.logDir);
    const firstBranchList = deferred<string[]>();
    const listTargetBranches = vi
      .spyOn(GitService.prototype, "listTargetBranches")
      .mockImplementationOnce(() => firstBranchList.promise)
      .mockResolvedValue(["main", "release/next", "develop"]);

    const firstUpdate = harness.controller.updateProjectBaseBranch(project.id, "release/next");
    await vi.waitFor(() => expect(listTargetBranches).toHaveBeenCalledTimes(1));
    const secondUpdate = harness.controller.updateProjectBaseBranch(project.id, "develop");
    await Promise.resolve();

    expect(listTargetBranches).toHaveBeenCalledTimes(1);
    firstBranchList.resolve(["main", "release/next", "develop"]);
    await Promise.all([firstUpdate, secondUpdate]);

    expect(harness.getCurrentProject().baseBranch).toBe("develop");
  });

  it("rechecks the latest base branch before a queued rename", async () => {
    const harness = createMutableProjectHarness();
    tempDirs.push(harness.logDir);
    const branchList = deferred<string[]>();
    vi.spyOn(GitService.prototype, "listTargetBranches").mockReturnValue(branchList.promise);
    const renameProjectBranch = vi.spyOn(GitService.prototype, "renameProjectBranch").mockResolvedValue(undefined);

    const update = harness.controller.updateProjectBaseBranch(project.id, "release/next");
    await vi.waitFor(() => expect(GitService.prototype.listTargetBranches).toHaveBeenCalledTimes(1));
    const rename = harness.controller.renameProjectBranch(project.id, {
      oldName: "release/next",
      newName: "release/renamed",
    });
    branchList.resolve(["main", "release/next"]);

    await update;
    await expect(rename).rejects.toThrow("Choose a different project base branch");
    expect(renameProjectBranch).not.toHaveBeenCalled();
  });

  it("rechecks the latest base branch before a queued deletion", async () => {
    const harness = createMutableProjectHarness();
    tempDirs.push(harness.logDir);
    const branchList = deferred<string[]>();
    vi.spyOn(GitService.prototype, "listTargetBranches").mockReturnValue(branchList.promise);
    const deleteProjectBranch = vi.spyOn(GitService.prototype, "deleteProjectBranch").mockResolvedValue(undefined);

    const update = harness.controller.updateProjectBaseBranch(project.id, "release/next");
    await vi.waitFor(() => expect(GitService.prototype.listTargetBranches).toHaveBeenCalledTimes(1));
    const deletion = harness.controller.deleteProjectBranch(project.id, {
      branchName: "release/next",
      force: false,
    });
    branchList.resolve(["main", "release/next"]);

    await update;
    await expect(deletion).rejects.toThrow("Choose a different project base branch");
    expect(deleteProjectBranch).not.toHaveBeenCalled();
  });

  it("validates, persists, reads, and clears network proxy credentials", async () => {
    const harness = createHarness();
    tempDirs.push(harness.logDir);

    await expect(harness.controller.saveNetworkProxySettings({ enabled: true, protocol: "http", host: "", port: "8080", username: "" })).rejects.toThrow("host");
    await expect(harness.controller.saveNetworkProxySettings({ enabled: true, protocol: "http", host: "proxy", port: "", username: "" })).rejects.toThrow("port");
    await expect(harness.controller.saveNetworkProxySettings({ enabled: true, protocol: "http", host: "proxy", port: "0", username: "" })).rejects.toThrow("whole number");
    await expect(harness.controller.saveNetworkProxySettings({ enabled: true, protocol: "http", host: "bad host", port: "80", username: "" })).rejects.toThrow("spaces");
    await expect(harness.controller.saveNetworkProxySettings({ enabled: true, protocol: "http", host: "proxy", port: "80", username: "bad\nname" })).rejects.toThrow("line breaks");

    const saved = await harness.controller.saveNetworkProxySettings({
      enabled: true,
      protocol: "https",
      host: " proxy.example ",
      port: " 443 ",
      username: " user ",
      password: "secret",
    });
    expect(saved).toMatchObject({ enabled: true, protocol: "https", host: "proxy.example", port: "443", username: "user" });
    expect(harness.secrets.saveSecret).toHaveBeenCalledWith("app:network-proxy-password", "secret");

    await harness.controller.saveNetworkProxySettings({
      enabled: false,
      protocol: "http",
      host: "",
      port: "",
      username: "",
      clearSavedPassword: true,
    });
    expect(harness.secrets.deleteSecret).toHaveBeenCalledWith("app:network-proxy-password");
  });

  it("updates selection and normalizes project ordering", async () => {
    const other = { ...project, id: "project-2" };
    const harness = createHarness({ listProjects: vi.fn(() => [project, other]) });
    tempDirs.push(harness.logDir);

    await harness.controller.selectProject(project.id);
    expect(harness.db.touchProject).toHaveBeenCalledWith(project.id);
    expect(harness.calls.deleteSetting).toHaveBeenCalledTimes(2);
    await harness.controller.reorderProjects([other.id, other.id, "missing", project.id]);
    expect(JSON.parse(harness.settings.projectOrder ?? "[]")).toEqual([other.id, project.id]);

    const empty = createHarness({ listProjects: vi.fn(() => []) });
    tempDirs.push(empty.logDir);
    await expect(empty.controller.reorderProjects(["missing"])).rejects.toThrow("valid projects");
  });

  it("validates and delegates task, model, note, and visibility operations", async () => {
    const harness = createHarness();
    tempDirs.push(harness.logDir);

    await expect(harness.controller.createProjectTask(project.id, { title: " ", prompt: "prompt" })).rejects.toThrow("title");
    await expect(harness.controller.createProjectTask(project.id, { title: "title", prompt: " " })).rejects.toThrow("prompt");
    await expect(harness.controller.createProjectTask(project.id, { title: " Title ", prompt: " Prompt " })).resolves.toMatchObject({ title: "Title", prompt: "Prompt" });
    await expect(harness.controller.updateProjectTask(task.id, { title: " Updated " })).resolves.toMatchObject({ title: "Updated", prompt: task.prompt });
    await expect(harness.controller.updateProjectTask(task.id, { status: "in_progress" })).resolves.toMatchObject({ status: "in_progress" });
    await expect(harness.controller.updateProjectTask(task.id, { status: "invalid" as "open" })).rejects.toThrow("Unsupported");
    await expect(harness.controller.updateProjectTask(task.id, { title: " " })).rejects.toThrow("title");
    await expect(harness.controller.updateProjectTask(task.id, { prompt: " " })).rejects.toThrow("prompt");
    await harness.controller.deleteProjectTask(task.id);

    await expect(harness.controller.addModel({ providerAccountId: provider.id, modelId: "gpt-5", displayName: "GPT-5", capabilities: {}, config: {} })).resolves.toMatchObject({ modelId: "gpt-5" });
    await harness.controller.deleteModel(model.id);
    await expect(harness.controller.addRunNote("run-1", { content: "note" })).resolves.toMatchObject({ content: "note" });
    await harness.controller.updateRunNote("note-1", { status: "closed" });
    await harness.controller.deleteRunNote("note-1");
    await expect(harness.controller.setRunListVisibility("run-1", "for-later")).resolves.toMatchObject({ listVisibility: "for-later" });
    await expect(harness.controller.setRunListVisibility("run-1", "invalid" as "default")).rejects.toThrow("Unsupported");
  });

  it("handles ordinary settings, worktree path validation, snapshots, and log sizes", async () => {
    const harness = createHarness();
    tempDirs.push(harness.logDir);
    writeFileSync(join(harness.logDir, "one.log"), "12345");

    await harness.controller.setAppSetting("theme", "dark");
    await harness.controller.setAppSetting("worktreeRootOverride", " ");
    await expect(harness.controller.setAppSetting("worktreeRootOverride", "relative/path")).rejects.toThrow("absolute");
    const paths = await harness.controller.getAppPaths();
    expect(paths.logDirectorySize).toMatchObject({ totalBytes: 5, fileCount: 1, unreadableEntryCount: 0 });
    await expect(harness.controller.getSnapshot()).resolves.toMatchObject({ projects: [] });
    await expect(harness.controller.refreshSnapshot()).resolves.toMatchObject({ projects: [] });
  });

  it("registers and removes chat listeners", () => {
    const harness = createHarness();
    tempDirs.push(harness.logDir);
    const listener = vi.fn();
    const remove = harness.controller.onChatEvent(listener);
    expect(() => remove()).not.toThrow();
    expect(() => remove()).not.toThrow();
  });
});
