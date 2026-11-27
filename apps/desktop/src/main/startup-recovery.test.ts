import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, getHarnessCapabilities, type ProviderType } from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { serviceOf } from "./controller-test-internals";
import { HostEventBus } from "./host-events";
import { reconcileStartupState } from "./startup-reconciliation";

const dirs: string[] = [];
const databases: BuildWardenDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-startup-recovery-")); dirs.push(dir);
  const db = new BuildWardenDatabase(join(dir, "state.sqlite")); databases.push(db); await db.init();
  const project = db.addProject({ repoPath: dir, baseBranch: "main", resolvedName: "Project" });
  const addRun = (providerType: ProviderType, prompt: string, extra: Partial<Parameters<BuildWardenDatabase["createRun"]>[0]> = {}) => {
    const provider = db.addProviderAccount({ providerType, label: prompt, apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
    const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
    const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code", workspaceType: "local", prompt, branchName: "main", worktreePath: dir, ...extra });
    return { provider, model, run };
  };
  const secrets = { readSecret: vi.fn(async (): Promise<string | null> => null), saveSecret: async () => undefined, deleteSecret: async () => undefined };
  const controller = new AppController(db, secrets, dir,
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  return { db, controller, addRun };
};

describe("startup recovery", () => {
  it("marks every interrupted run and chat cancelled when one run's provider type is unknown", async () => {
    const { db, controller, addRun } = await fixture();
    // A provider type this version does not know, as a newer version may have stored it.
    const retired = addRun("retired-provider" as ProviderType, "Unknown provider");
    const codex = addRun("codex-cli", "Codex");
    db.updateRunStatus(codex.run.id, "running");
    const chat = db.createChat(codex.provider.id, codex.model.id, "Chat");

    await controller.reconcileOrphanedActiveSessions();

    for (const runId of [retired.run.id, codex.run.id]) {
      expect(db.getRun(runId).status).toBe("cancelled");
      expect(db.getRunSteps(runId).at(-1)?.title).toBe("Session interrupted");
    }
    expect(JSON.parse(db.getRunSteps(retired.run.id).at(-1)?.metadataJson ?? "{}")).toMatchObject({
      sessionInterrupted: true,
      canRecoverInterruptedSession: false,
      recoveryKind: null,
    });
    expect(db.getChat(chat.id).status).toBe("cancelled");
  });

  it("cancels the other runs and chats when one run's status cannot be written, then reports the failure", async () => {
    const { db, controller, addRun } = await fixture();
    const stuck = addRun("codex-cli", "Stuck");
    const other = addRun("codex-cli", "Other");
    const chat = db.createChat(other.provider.id, other.model.id, "Chat");
    const update = db.updateRunStatus.bind(db);
    vi.spyOn(db, "updateRunStatus").mockImplementation((runId, ...rest) => {
      if (runId === stuck.run.id) throw new Error("database is locked");
      return update(runId, ...rest);
    });

    // The failure reaches startup, which then keeps loops, orchestrations and council rounds waiting.
    await expect(controller.reconcileOrphanedActiveSessions()).rejects.toThrow(stuck.run.id);

    expect(db.getRun(stuck.run.id).status).toBe("queued");
    expect(db.getRun(other.run.id).status).toBe("cancelled");
    expect(db.getChat(chat.id).status).toBe("cancelled");
  });

  it("records why a run was interrupted when its worktree cannot be marked ready", async () => {
    const { controller, addRun, db } = await fixture();
    const { run } = addRun("codex-cli", "Codex");
    vi.spyOn(serviceOf(controller, "workspaceGuard"), "updateWorktreeStatus").mockImplementation(() => {
      throw new Error("database is locked");
    });

    await controller.reconcileOrphanedActiveSessions();

    expect(db.getRun(run.id).status).toBe("cancelled");
    expect(db.getRunSteps(run.id).at(-1)?.title).toBe("Session interrupted");
  });

  it("keeps a chat active for the next start when its open questions cannot be closed", async () => {
    const { controller, addRun, db } = await fixture();
    const { provider, model } = addRun("codex-cli", "Codex");
    const stuck = db.createChat(provider.id, model.id, "Stuck");
    const question = db.appendChatEvent(stuck.id, "user-input-requested", "Question", "Which one?", { requestStatus: "opened" });
    const other = db.createChat(provider.id, model.id, "Other");
    const close = db.closeChatUserInputRequests.bind(db);
    vi.spyOn(db, "closeChatUserInputRequests").mockImplementation((chatId) => {
      close(chatId);
      // Fails after the question was already closed, so only a rollback keeps it open.
      if (chatId === stuck.id) throw new Error("database is locked");
    });

    await controller.reconcileOrphanedActiveSessions();

    expect(db.getChat(stuck.id).status).toBe("queued");
    const questionAfter = db.getChatSteps(stuck.id).find((step) => step.id === question.id);
    expect(JSON.parse(questionAfter?.metadataJson ?? "{}")).toMatchObject({ requestStatus: "opened" });
    expect(db.getChatSteps(stuck.id).some((step) => step.title === "Session interrupted")).toBe(false);
    expect(db.getChat(other.id).status).toBe("cancelled");
    expect(db.getChatSteps(other.id).at(-1)?.title).toBe("Session interrupted");
  });

  it("gives an unknown provider type the plain API capabilities", () => {
    const capabilities = getHarnessCapabilities("retired-provider" as ProviderType);
    expect(capabilities).toMatchObject({ nativeSessionResume: false, liveSteering: false, taskExecutionOptions: [] });
    expect(getHarnessCapabilities("constructor" as ProviderType).nativeSessionResume).toBe(false);
  });

  it("refuses to start a run or chat worker for an unknown provider type", async () => {
    const { db, controller, addRun } = await fixture();
    const { run, provider, model } = addRun("retired-provider" as ProviderType, "Unknown provider");
    const chat = db.createChat(provider.id, model.id, "Chat");

    await expect(serviceOf(controller, "runWorkerHost").startWorker(run, provider, model, "", undefined))
      .rejects.toThrow("does not support (retired-provider)");
    await expect(serviceOf(controller, "chatWorkerHost").startChatWorker(chat, provider, model, "", undefined))
      .rejects.toThrow("does not support (retired-provider)");
  });

  it("blocks an interrupted orchestration child whose provider type is unknown instead of restarting it", async () => {
    const { db, controller, addRun } = await fixture();
    db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
    const { run: root } = addRun("codex-cli", "Coordinate", { delegationEnabled: true });
    const orchestration = serviceOf(controller, "orchestration").getOrCreateOrchestration(root);
    const wave = db.createOrchestrationWave(orchestration.id);
    const task = db.createOrchestrationTask({
      orchestrationId: orchestration.id, waveId: wave.id, clientTaskId: "c1", title: "c1", prompt: "Part", roleId: "general", modelId: root.modelId, intent: "inspect",
    });
    const { run: child } = addRun("retired-provider" as ProviderType, "Part", {
      kind: "orchestration-task", parentRunId: root.id, rootRunId: root.id, orchestrationTaskId: task.id,
    });
    db.updateRunStatus(child.id, "running");
    db.updateOrchestrationTask(task.id, { childRunId: child.id, status: "running" });
    const restart = vi.spyOn(serviceOf(controller, "orchestrationDispatch"), "restartOrchestrationChildFromBeginning");

    await controller.reconcileOrchestrationsAfterRestart();

    expect(restart).not.toHaveBeenCalled();
    expect(db.getOrchestrationTask(task.id)).toMatchObject({ status: "blocked", attentionReason: expect.stringContaining("does not support (retired-provider)") });
  });

  const startupController = () => ({
    migrateProjectBaseBranches: vi.fn(async () => undefined),
    reconcileOrphanedActiveSessions: vi.fn(async () => undefined),
    reconcileOrchestrationsAfterRestart: vi.fn(async () => undefined),
    startHistorySearchBackfill: vi.fn(() => undefined),
    reconcileCouncilAfterRestart: vi.fn(async () => undefined),
    resumeActiveProjectLoops: vi.fn(() => undefined),
  });

  it("runs the remaining startup steps when one fails", async () => {
    const controller = startupController();
    controller.migrateProjectBaseBranches.mockRejectedValue(new Error("repository moved"));
    controller.reconcileOrchestrationsAfterRestart.mockRejectedValue(new Error("orchestration row"));
    const log = vi.fn();

    await reconcileStartupState(controller, log);

    expect(controller.reconcileOrphanedActiveSessions).toHaveBeenCalled();
    expect(controller.startHistorySearchBackfill).toHaveBeenCalled();
    expect(controller.reconcileCouncilAfterRestart).toHaveBeenCalled();
    expect(controller.resumeActiveProjectLoops).toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("does not resume loops, orchestrations or council rounds while interrupted runs may still read as running", async () => {
    const controller = startupController();
    controller.reconcileOrphanedActiveSessions.mockRejectedValue(new Error("database locked"));
    const log = vi.fn();

    await reconcileStartupState(controller, log);

    expect(controller.startHistorySearchBackfill).toHaveBeenCalled();
    expect(controller.reconcileOrchestrationsAfterRestart).not.toHaveBeenCalled();
    expect(controller.reconcileCouncilAfterRestart).not.toHaveBeenCalled();
    expect(controller.resumeActiveProjectLoops).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
  });
});
