import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  type AppSnapshot,
  type ProjectRecord,
  type RunKind,
  type RunRecord,
  type RunTokenUsage,
} from "@buildwarden/shared";
import type { SecretStore } from "@buildwarden/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { HostEventBus } from "./host-events";

type WorkerMessageListener = (message: unknown) => unknown | Promise<unknown>;

interface TestWorker {
  emitMessage(message: unknown): Promise<void>;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

const workerHarness = vi.hoisted(() => ({ instances: [] as unknown[] }));
const providerHarness = vi.hoisted(() => ({ generateAskTextResultWithAiSdk: vi.fn() }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter: MockEventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");

  class Worker extends MockEventEmitter implements TestWorker {
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn(async () => 1);

    constructor() {
      super();
      workerHarness.instances.push(this);
    }

    async emitMessage(message: unknown): Promise<void> {
      for (const listener of this.listeners("message") as WorkerMessageListener[]) {
        await listener(message);
      }
    }
  }

  return { Worker };
});

vi.mock("@buildwarden/provider-ai-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@buildwarden/provider-ai-sdk")>();
  return {
    ...original,
    generateAskTextResultWithAiSdk: providerHarness.generateAskTextResultWithAiSdk,
  };
});

interface TokenAccountingInternals {
  applyRunWorkerUsageUpdate(
    run: RunRecord,
    usage: Partial<RunTokenUsage> | null,
    maxRunTokens: number,
    exhaustBudget: () => void,
    tracker: { reportedUsage: { inputTokens: number; outputTokens: number } },
  ): RunRecord;
}

interface TokenUsageHarness {
  rootDir: string;
  repoPath: string;
  db: BuildWardenDatabase;
  controller: AppController;
  project: ProjectRecord;
  codexProviderId: string;
  codexModelId: string;
  aiSdkModelId: string;
}

const harnesses: TokenUsageHarness[] = [];

const createHarness = async (): Promise<TokenUsageHarness> => {
  const rootDir = mkdtempSync(join(tmpdir(), "buildwarden-token-usage-e2e-"));
  const repoPath = join(rootDir, "project");
  const dataPath = join(rootDir, "data");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(dataPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# Token usage fixture\n", "utf8");

  const db = new BuildWardenDatabase(join(dataPath, "buildwarden.sqlite"));
  await db.init();
  const project = db.addProject({
    repoPath,
    baseBranch: "project-folder",
    resolvedName: "Token usage project",
    kind: "folder",
  });
  const codexProvider = db.addProviderAccount({
    providerType: "codex-cli",
    label: "Codex CLI",
    apiBaseUrl: null,
    apiKeyRef: "",
    configJson: "{}",
  });
  const codexModel = db.addModel({
    providerAccountId: codexProvider.id,
    modelId: "gpt-5.6-codex",
    displayName: "Codex",
    config: {},
    capabilities: {},
    enabled: true,
  });
  const aiSdkProvider = db.addProviderAccount({
    providerType: "ai-sdk",
    label: "AI SDK",
    apiBaseUrl: null,
    apiKeyRef: "test-secret",
    configJson: "{}",
  });
  const aiSdkModel = db.addModel({
    providerAccountId: aiSdkProvider.id,
    modelId: "gpt-5.6",
    displayName: "AI SDK model",
    config: {},
    capabilities: {},
    enabled: true,
  });
  const secrets = {
    readSecret: vi.fn(async () => "test-api-key"),
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
  const controller = new AppController(
    db,
    secrets,
    join(rootDir, "logs"),
    desktop,
    { killForRunId: vi.fn() },
    new HostEventBus(),
  );
  const harness = {
    rootDir,
    repoPath,
    db,
    controller,
    project,
    codexProviderId: codexProvider.id,
    codexModelId: codexModel.id,
    aiSdkModelId: aiSdkModel.id,
  };
  harnesses.push(harness);
  return harness;
};

const nextWorker = (): TestWorker => {
  const worker = workerHarness.instances.shift() as TestWorker | undefined;
  if (!worker) throw new Error("Expected the controller to start a worker.");
  return worker;
};

const usage = (inputTokens: number, outputTokens: number): RunTokenUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
  totalProcessedTokens: inputTokens + outputTokens,
});

const completeWorker = async (
  worker: TestWorker,
  reportedUsage: RunTokenUsage,
  repoPath: string,
  sessionId: string,
): Promise<void> => {
  await worker.emitMessage({
    type: "done",
    result: {
      summary: "Completed by the token-usage test worker.",
      responseId: `response-${sessionId}`,
      usage: reportedUsage,
      providerSessionRuntime: {
        cwd: repoPath,
        modelId: "gpt-5.6-codex",
        runtimeMode: "code",
        resumeCursor: { threadId: sessionId },
      },
    },
  });
};

const createStoredRun = (
  harness: TokenUsageHarness,
  label: string,
  kind: RunKind,
  extra: Partial<Parameters<BuildWardenDatabase["createRun"]>[0]> = {},
): RunRecord => harness.db.createRun({
  projectId: harness.project.id,
  providerAccountId: harness.codexProviderId,
  modelId: harness.codexModelId,
  harnessType: "codex-app-server",
  mode: "code",
  workspaceType: "local",
  workspaceVcs: "folder",
  prompt: label,
  branchName: "project-folder",
  worktreePath: harness.repoPath,
  kind,
  ...extra,
});

const expectSnapshotTotals = (
  snapshot: AppSnapshot,
  projectId: string,
  expected: { inputTokens: number; outputTokens: number; standaloneInputTokens?: number; standaloneOutputTokens?: number },
): void => {
  const project = snapshot.projects.find((entry) => entry.project.id === projectId)?.project;
  expect(project).toMatchObject({
    cumulativeInputTokens: expected.inputTokens,
    cumulativeOutputTokens: expected.outputTokens,
  });
  expect(snapshot.tokenUsage?.today).toEqual({
    inputTokens: expected.inputTokens + (expected.standaloneInputTokens ?? 0),
    outputTokens: expected.outputTokens + (expected.standaloneOutputTokens ?? 0),
  });
  expect(snapshot.tokenUsage?.standaloneChats).toEqual({
    inputTokens: expected.standaloneInputTokens ?? 0,
    outputTokens: expected.standaloneOutputTokens ?? 0,
  });
};

const enableProjectLab = (
  harness: TokenUsageHarness,
  implementationModelId: string,
  reviewModelId: string,
): void => {
  harness.db.setSetting(APP_SETTING_KEYS.projectLabSettings, JSON.stringify({
    [harness.project.id]: {
      enabled: true,
      maxThreadsPerDay: 10,
      maxConcurrentThreads: 3,
      implementationModelId,
      reviewModelId,
    },
  }));
};

beforeEach(() => {
  workerHarness.instances.length = 0;
  providerHarness.generateAskTextResultWithAiSdk.mockReset();
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.db.close();
    rmSync(harness.rootDir, { recursive: true, force: true });
  }
  workerHarness.instances.length = 0;
  vi.restoreAllMocks();
});

describe("token usage end-to-end accounting", () => {
  it("counts every agent-run origin in its owner, project page, and landing-page ledger", async () => {
    const harness = await createHarness();
    const task = harness.db.createProjectTask(harness.project.id, {
      title: "Task-board work",
      prompt: "Implement the task-board item",
    });
    const automation = harness.db.createProjectAutomation(harness.project.id, {
      name: "Automated review",
      prompt: "Review automatically",
      cronExpression: "0 9 * * *",
      modelId: harness.codexModelId,
      workspaceType: "copy",
    }, "2099-01-01T09:00:00.000Z", "UTC");
    const labThread = harness.db.createProjectLabThread({
      projectId: harness.project.id,
      kind: "implementation",
      mode: "new-feature",
      status: "running",
      origin: "manual",
      title: "Lab implementation",
      summary: "Testing accounting",
      seedPrompt: null,
      implementationModelId: harness.codexModelId,
      reviewModelId: harness.aiSdkModelId,
      baseBranch: "project-folder",
    });
    const defaultRun = createStoredRun(harness, "Default agent run", "standard");
    const scenarios = [
      defaultRun,
      createStoredRun(harness, "Task-board agent run", "standard", { projectTaskId: task.id }),
      createStoredRun(harness, "Continued agent run", "standard", {
        parentRunId: defaultRun.id,
        rootRunId: defaultRun.id,
        lineageTitle: defaultRun.prompt,
      }),
      createStoredRun(harness, "Automation agent run", "automation", { automationId: automation.id }),
      createStoredRun(harness, "Project Lab implementation", "lab-implementation", {
        labThreadId: labThread.id,
      }),
      createStoredRun(harness, "Project loop iteration", "loop-iteration"),
      createStoredRun(harness, "Delegated child agent run", "orchestration-task", {
        parentRunId: defaultRun.id,
        rootRunId: defaultRun.id,
      }),
    ];
    const accounting = harness.controller as unknown as TokenAccountingInternals;

    for (const run of scenarios) {
      const tracker = { reportedUsage: { inputTokens: 0, outputTokens: 0 } };
      accounting.applyRunWorkerUsageUpdate(run, usage(100, 20), Number.POSITIVE_INFINITY, vi.fn(), tracker);
      accounting.applyRunWorkerUsageUpdate(run, usage(160, 35), Number.POSITIVE_INFINITY, vi.fn(), tracker);
      expect(harness.db.getRun(run.id)).toMatchObject({ inputTokens: 160, outputTokens: 35 });
    }

    expectSnapshotTotals(await harness.controller.getSnapshot(), harness.project.id, {
      inputTokens: scenarios.length * 160,
      outputTokens: scenarios.length * 35,
    });
  });

  it("counts a default agent run and its cumulative Codex follow-up exactly once", async () => {
    const harness = await createHarness();
    const run = await harness.controller.createRun({
      projectId: harness.project.id,
      providerAccountId: harness.codexProviderId,
      modelId: harness.codexModelId,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "local",
      prompt: "Initial agent run",
    });
    await completeWorker(nextWorker(), usage(100, 20), harness.repoPath, "run-session");

    await harness.controller.followUpRun(run.id, "Continue the implementation");
    await completeWorker(nextWorker(), usage(165, 38), harness.repoPath, "run-session");

    expect(harness.db.getRun(run.id)).toMatchObject({ inputTokens: 165, outputTokens: 38 });
    expectSnapshotTotals(await harness.controller.getSnapshot(), harness.project.id, {
      inputTokens: 165,
      outputTokens: 38,
    });
  });

  it("separates standalone chats from run-panel chats and counts follow-ups for both", async () => {
    const harness = await createHarness();
    const run = await harness.controller.createRun({
      projectId: harness.project.id,
      providerAccountId: harness.codexProviderId,
      modelId: harness.codexModelId,
      harnessType: "codex-app-server",
      mode: "code",
      workspaceType: "local",
      prompt: "Run hosting the side-panel chat",
    });
    await completeWorker(nextWorker(), usage(0, 0), harness.repoPath, "hosting-run");

    const standalone = await harness.controller.createChat({
      providerAccountId: harness.codexProviderId,
      modelId: harness.codexModelId,
      prompt: "Standalone question",
    });
    await completeWorker(nextWorker(), usage(40, 10), harness.repoPath, "standalone-chat");
    await harness.controller.followUpChat(standalone.id, "Standalone follow-up");
    await completeWorker(nextWorker(), usage(65, 16), harness.repoPath, "standalone-chat");

    const runChat = await harness.controller.createRunChat(run.id, {
      modelId: harness.codexModelId,
      prompt: "Question from the agent-run side panel",
    });
    await completeWorker(nextWorker(), usage(30, 7), harness.repoPath, "run-panel-chat");
    const sameRunChat = await harness.controller.createRunChat(run.id, {
      modelId: harness.codexModelId,
      prompt: "Side-panel follow-up",
    });
    await completeWorker(nextWorker(), usage(55, 13), harness.repoPath, "run-panel-chat");

    expect(sameRunChat.id).toBe(runChat.id);
    expect(harness.db.getChat(standalone.id)).toMatchObject({ inputTokens: 65, outputTokens: 16, runId: null });
    expect(harness.db.getChat(runChat.id)).toMatchObject({ inputTokens: 55, outputTokens: 13, runId: run.id });
    expect(harness.db.listChats().map((chat) => chat.id)).toEqual([standalone.id]);
    expectSnapshotTotals(await harness.controller.getSnapshot(), harness.project.id, {
      inputTokens: 55,
      outputTokens: 13,
      standaloneInputTokens: 65,
      standaloneOutputTokens: 16,
    });
  });

  it("counts automation worker usage even though automation runs are hidden from the normal run list", async () => {
    const harness = await createHarness();
    const automation = harness.db.createProjectAutomation(harness.project.id, {
      name: "Nightly automation",
      prompt: "Run the nightly automation",
      cronExpression: "0 2 * * *",
      modelId: harness.codexModelId,
      workspaceType: "copy",
    }, "2099-01-01T02:00:00.000Z", "UTC");

    const run = await harness.controller.runProjectAutomationNow(automation.id);
    await completeWorker(nextWorker(), usage(210, 44), run.worktreePath, "automation-run");

    const snapshot = await harness.controller.getSnapshot();
    expect(harness.db.getRun(run.id)).toMatchObject({
      kind: "automation",
      automationId: automation.id,
      inputTokens: 210,
      outputTokens: 44,
    });
    expect(snapshot.projects[0]?.runs).toEqual([]);
    expect(snapshot.projects[0]?.automations?.[0]?.runs?.map((item) => item.id)).toContain(run.id);
    expectSnapshotTotals(snapshot, harness.project.id, { inputTokens: 210, outputTokens: 44 });
  });

  it("counts both the Project Lab implementation run and its separate review model call", async () => {
    const harness = await createHarness();
    enableProjectLab(harness, harness.codexModelId, harness.aiSdkModelId);
    providerHarness.generateAskTextResultWithAiSdk.mockResolvedValueOnce({
      text: "## Verdict\nApproved.",
      usage: usage(30, 6),
    });

    const [thread] = await harness.controller.runProjectLab({
      projectId: harness.project.id,
      mode: "new-feature",
      baseBranch: "project-folder",
      implementationModelId: harness.codexModelId,
      reviewModelId: harness.aiSdkModelId,
    });
    const implementationRun = harness.db.getRun(thread!.implementationRunId!);
    await completeWorker(nextWorker(), usage(90, 20), implementationRun.worktreePath, "project-lab-run");

    expect(harness.db.getRun(implementationRun.id)).toMatchObject({
      kind: "lab-implementation",
      inputTokens: 90,
      outputTokens: 20,
    });
    expect(harness.db.getProjectLabThread(thread!.id).status).toBe("completed");
    expect(providerHarness.generateAskTextResultWithAiSdk).toHaveBeenCalledTimes(1);
    expectSnapshotTotals(await harness.controller.getSnapshot(), harness.project.id, {
      inputTokens: 120,
      outputTokens: 26,
    });
  });

  it("counts both direct model calls in a Project Lab RFC and exposes them in project and landing totals", async () => {
    const harness = await createHarness();
    enableProjectLab(harness, harness.aiSdkModelId, harness.aiSdkModelId);
    providerHarness.generateAskTextResultWithAiSdk
      .mockResolvedValueOnce({ text: "# RFC\nA focused proposal.", usage: usage(45, 9) })
      .mockResolvedValueOnce({ text: "## Verdict\nReady for implementation.", usage: usage(25, 5) });

    const [createdThread] = await harness.controller.runProjectLab({
      projectId: harness.project.id,
      mode: "rfc-only",
      baseBranch: "project-folder",
      implementationModelId: harness.aiSdkModelId,
      reviewModelId: harness.aiSdkModelId,
    });

    await vi.waitFor(() => {
      expect(harness.db.getProjectLabThread(createdThread!.id).status).toBe("completed");
    });
    expect(providerHarness.generateAskTextResultWithAiSdk).toHaveBeenCalledTimes(2);
    expectSnapshotTotals(await harness.controller.getSnapshot(), harness.project.id, {
      inputTokens: 70,
      outputTokens: 14,
    });
  });
});
