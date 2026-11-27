import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import { getHarnessCapabilities, type ProviderType } from "@buildwarden/shared";
import { AppController } from "./app-controller";
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
  const addRun = (providerType: ProviderType, prompt: string) => {
    const provider = db.addProviderAccount({ providerType, label: prompt, apiBaseUrl: null, apiKeyRef: "key", configJson: "{}" });
    const model = db.addModel({ providerAccountId: provider.id, modelId: "test", displayName: "Test", config: {}, capabilities: {}, enabled: true });
    const run = db.createRun({ projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: "codex-app-server", mode: "code", workspaceType: "local", prompt, branchName: "main", worktreePath: dir });
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

  it("gives an unknown provider type the plain API capabilities", () => {
    const capabilities = getHarnessCapabilities("retired-provider" as ProviderType);
    expect(capabilities).toMatchObject({ nativeSessionResume: false, liveSteering: false, taskExecutionOptions: [] });
    expect(getHarnessCapabilities("constructor" as ProviderType).nativeSessionResume).toBe(false);
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
