import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS, type ModelRecord, type ProviderAccountRecord, type RunExecutionRequest, type RunRecord } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "./app-controller";
import { HostEventBus } from "./host-events";

const workers = vi.hoisted(() => ({ requests: [] as Array<RunExecutionRequest | undefined> }));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await vi.importActual<typeof import("node:events")>("node:events");
  class Worker extends EventEmitter {
    readonly postMessage = vi.fn();
    readonly terminate = vi.fn(async () => 1);
    constructor(_path: unknown, options?: { workerData?: { request?: RunExecutionRequest } }) {
      super();
      workers.requests.push(options?.workerData?.request);
    }
  }
  return { Worker };
});

interface Internals {
  startWorker(run: RunRecord, provider: ProviderAccountRecord, model: ModelRecord, apiKey: string, proxy: undefined, options?: Record<string, unknown>): Promise<unknown>;
}

const roots: Array<{ root: string; db: BuildWardenDatabase }> = [];
afterEach(async () => {
  workers.requests.length = 0;
  for (const { root, db } of roots.splice(0)) {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const setup = async (providerType: "acp" | "codex-cli") => {
  const root = mkdtempSync(join(tmpdir(), "buildwarden-acp-fallback-"));
  const repoPath = join(root, "project");
  mkdirSync(repoPath);
  const db = new BuildWardenDatabase(join(root, "buildwarden.sqlite"));
  await db.init();
  roots.push({ root, db });
  db.setSetting(APP_SETTING_KEYS.sessionTitlesEnabled, "false");
  const project = db.addProject({ repoPath, baseBranch: "project-folder", resolvedName: "Fallback", kind: "folder" });
  const provider = db.addProviderAccount({ providerType, label: "Agent", apiBaseUrl: null, apiKeyRef: "", configJson: JSON.stringify({ acpCommand: "agent --acp" }) });
  const model = db.addModel({ providerAccountId: provider.id, modelId: "default", displayName: "Agent", config: {}, capabilities: {}, enabled: true });
  const run = db.createRun({
    projectId: project.id, providerAccountId: provider.id, modelId: model.id, harnessType: providerType === "acp" ? "acp" : "codex-app-server",
    mode: "code", workspaceType: "local", workspaceVcs: "folder", prompt: "Build the importer", branchName: "project-folder", worktreePath: repoPath,
  });
  db.appendRunStep(run.id, "log", "User prompt", "Build the importer", JSON.stringify({ source: "user", commandType: "initial", providerAccountId: provider.id }));
  db.appendRunStep(run.id, "output", "Agent output", "Started the importer.", "{}");
  db.appendRunStep(run.id, "log", "Follow-up", "Keep the public API stable.", JSON.stringify({ source: "user", commandType: "follow-up", providerAccountId: provider.id }));
  db.upsertProviderSessionRuntime({
    ownerId: run.id, ownerKind: "run", providerAccountId: provider.id, providerType, harnessType: providerType === "acp" ? "acp" : "codex-app-server",
    status: "ready", cwd: repoPath, modelId: "default", runtimeMode: "code", resumeCursor: { sessionId: "session-1", threadId: "session-1" },
  });
  const controller = new AppController(db, { readSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => undefined }, join(root, "logs"),
    { pickProjectDirectory: async () => null, pickIdeExecutable: async () => null, openPathInFileManager: async () => ({ ok: true }), openExternalUrl: async () => ({ ok: true }), launchIdeWithFolder: async () => undefined },
    { killForRunId: () => {} }, new HostEventBus());
  return { db, run: db.getRun(run.id), provider: db.getProviderAccount(provider.id), model: db.getModel(model.id), internals: controller as unknown as Internals };
};

describe("ACP resume fallback context", () => {
  it("gives every resumed ACP worker the conversation, including recovery turns", async () => {
    const { run, provider, model, internals } = await setup("acp");
    await internals.startWorker(run, provider, model, "", undefined, { promptOverride: "Recover the interrupted turn." });
    const request = workers.requests.at(-1);
    expect(request?.providerSessionRuntime?.resumeCursor).toMatchObject({ sessionId: "session-1" });
    expect(request?.resumeFallbackContext).toContain("Build the importer");
    expect(request?.resumeFallbackContext).toContain("Keep the public API stable.");
  });

  it("keeps a fallback the caller already built", async () => {
    const { run, provider, model, internals } = await setup("acp");
    await internals.startWorker(run, provider, model, "", undefined, { resumeFallbackContext: "Caller history" });
    expect(workers.requests.at(-1)?.resumeFallbackContext).toBe("Caller history");
  });

  it("sends no fallback to providers that report a failed resume themselves", async () => {
    const { run, provider, model, internals } = await setup("codex-cli");
    await internals.startWorker(run, provider, model, "", undefined, { promptOverride: "Recover the interrupted turn." });
    expect(workers.requests.at(-1)?.resumeFallbackContext).toBeUndefined();
  });
});
