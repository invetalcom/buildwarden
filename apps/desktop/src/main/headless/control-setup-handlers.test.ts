import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildWardenDatabase } from "@buildwarden/db";
import type { ModelInput, ProjectInput, ProviderAccountInput } from "@buildwarden/shared";
import { createHostSetupHandlers, type HostSetupDependencies } from "./control-setup-handlers";

let directory: string;
let db: BuildWardenDatabase;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "bw-setup-"));
  db = new BuildWardenDatabase(join(directory, "test.sqlite"));
  await db.init();
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

const setup = () => {
  const controller = {
    addProviderAccount: vi.fn(async (input: ProviderAccountInput) => db.addProviderAccount({
      providerType: input.providerType, label: input.label, apiBaseUrl: input.apiBaseUrl ?? null, apiKeyRef: "ref",
      configJson: JSON.stringify(input.config),
    })),
    addModel: vi.fn(async (input: ModelInput) => db.addModel(input)),
    addProject: vi.fn(async (input: ProjectInput) => db.addProject({ ...input, baseBranch: "main", resolvedName: input.name ?? "repo" })),
    getDetectedCodexInstallation: async () => ({ binaryPath: "/detected/codex" }),
    getDetectedClaudeInstallation: async () => ({ binaryPath: null }),
    getDetectedCursorInstallation: async () => ({ binaryPath: null, message: "Install it." }),
    listAvailableProviderModels: vi.fn(async () => ({
      models: [{ modelId: "known", displayName: "Known", source: "provider", config: { a: 1 }, capabilities: { supportsTools: true } }],
    })),
    setProviderApiKey: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    cancelRun: vi.fn<(runId: string) => Promise<void>>(async () => undefined),
  };
  const onDataChanged = vi.fn();
  const onForgeSettingsChanged = vi.fn(async () => undefined);
  const handlers = createHostSetupHandlers({
    dataDir: directory, db, controller: controller as unknown as HostSetupDependencies["controller"], onDataChanged, onForgeSettingsChanged,
  });
  return { handlers, controller, onDataChanged, onForgeSettingsChanged };
};

const codex = { providerType: "codex-cli" as const, label: "Codex", apiKey: "", options: {} };

describe("providers", () => {
  it("uses the detected command-line tool unless a path is given", async () => {
    const { handlers, controller, onDataChanged } = setup();
    await handlers.addProvider(codex);
    expect(controller.addProviderAccount.mock.lastCall![0].config).toEqual({ codexBinaryPath: "/detected/codex" });
    await handlers.addProvider({ ...codex, label: "Other", options: { binary: "/own/codex", home: "/home/x" } });
    expect(controller.addProviderAccount.mock.lastCall![0].config).toEqual({ codexBinaryPath: "/own/codex", codexHomePath: "/home/x" });
    expect(onDataChanged).toHaveBeenCalledTimes(2);
  });

  it("stores the family of an API-key provider", async () => {
    const { handlers, controller } = setup();
    await handlers.addProvider({ providerType: "ai-sdk", family: "xai", label: "xAI", apiKey: "sk", options: {} });
    expect(controller.addProviderAccount.mock.lastCall![0]).toMatchObject({ apiKey: "sk", config: { providerFamily: "xai" } });
    await handlers.addProvider({ providerType: "azure-legacy", label: "Azure", apiKey: "sk", options: {} });
    expect(controller.addProviderAccount.mock.lastCall![0].config).toEqual({ azureApiVersion: "2024-06-01" });
  });

  it("rejects options of other provider types, bad configuration and duplicate names", async () => {
    const { handlers, controller } = setup();
    await expect(handlers.addProvider({ ...codex, options: { command: "x" } })).rejects.toThrow("--command does not apply");
    await expect(handlers.addProvider({ ...codex, options: JSON.parse('{"__proto__":"x"}') })).rejects.toThrow("does not apply");
    await expect(handlers.addProvider({ ...codex, configJson: "{}" })).rejects.toThrow("no --config");
    await expect(handlers.addProvider({ providerType: "openrouter", label: "R", apiKey: "k", options: {}, configJson: "[]" })).rejects.toThrow("JSON object");
    await expect(handlers.addProvider({ ...codex, providerType: "nope" as never })).rejects.toThrow("Unknown provider type");
    await expect(handlers.addProvider({ providerType: "acp", label: "A", apiKey: "", options: { command: "a", env: "broken" } })).rejects.toThrow("KEY=VALUE");
    expect(controller.addProviderAccount).not.toHaveBeenCalled();
    await handlers.addProvider(codex);
    await expect(handlers.addProvider({ ...codex, label: "codex" })).rejects.toThrow("already exists");
  });

  it("finds providers by id, name or the start of the id", async () => {
    const { handlers, controller } = setup();
    const added = await handlers.addProvider(codex);
    for (const reference of [added.id, "CODEX", added.id.slice(0, 8)]) {
      expect((await handlers.findProvider({ provider: reference })).id).toBe(added.id);
    }
    await expect(handlers.findProvider({ provider: added.id.slice(0, 2) })).rejects.toThrow("not found");
    await handlers.setProviderKey({ provider: "codex", apiKey: "new" });
    expect(controller.setProviderApiKey).toHaveBeenCalledWith(added.id, "new");
  });
});

describe("models", () => {
  it("takes the settings a provider reports and refuses a second copy", async () => {
    const { handlers, controller } = setup();
    await handlers.addProvider(codex);
    await handlers.addModel({ provider: "codex", modelId: "known" });
    expect(controller.addModel.mock.lastCall![0]).toMatchObject({ displayName: "Known", config: { a: 1 }, capabilities: { supportsTools: true } });
    await expect(handlers.addModel({ provider: "codex", modelId: "known" })).rejects.toThrow("already has");
    expect((await handlers.addModel({ provider: "codex", modelId: "custom", name: "Mine" })).name).toBe("Mine");
    expect((await handlers.availableModels({ provider: "codex" })).models).toEqual([{ modelId: "known", name: "Known", added: true }]);
    expect((await handlers.listProviders(undefined))[0].models).toBe(2);
  });

  it("asks for an id when a name is used by several providers", async () => {
    const { handlers } = setup();
    for (const label of ["One", "Two"]) {
      await handlers.addProvider({ ...codex, label });
      await handlers.addModel({ provider: label, modelId: "known" });
    }
    await expect(handlers.modelImpact({ model: "known" })).rejects.toThrow("not unique");
  });
});

describe("projects", () => {
  it("adds a folder once and removes by id after the impact was shown", async () => {
    const { handlers, controller, onForgeSettingsChanged } = setup();
    await expect(handlers.addProject({ path: "repo" })).rejects.toThrow("absolute");
    const path = resolve(directory);
    const project = await handlers.addProject({ path });
    await expect(handlers.addProject({ path: join(path, ".") })).rejects.toThrow("already the project");
    expect(await handlers.projectImpact({ project: "repo" })).toMatchObject({ runs: 0, activeRuns: 0, project: { id: project.id } });
    await handlers.removeProject({ projectId: project.id });
    expect(controller.deleteProject).toHaveBeenCalledWith(project.id);
    expect(onForgeSettingsChanged).toHaveBeenCalledOnce();
  });
});

const runFactory = async (handlers: ReturnType<typeof setup>["handlers"]) => {
  const { id: providerAccountId } = await handlers.addProvider(codex);
  const { id: modelId } = await handlers.addModel({ provider: "codex", modelId: "known" });
  const { id: projectId } = await handlers.addProject({ path: resolve(directory) });
  return () => db.createRun({
    projectId, providerAccountId, modelId, harnessType: "codex-app-server", mode: "code", workspaceType: "worktree",
    prompt: "Work", branchName: "branch", worktreePath: join(directory, "worktree"),
  });
};

describe("runs", () => {
  it("cancels only active runs", async () => {
    const { handlers } = setup();
    expect(await handlers.listRuns({ all: true })).toEqual([]);
    await expect(handlers.cancelRun({ run: "12345678" })).rejects.toThrow("Run not found");
  });

  it("reports a cancellation only when it took effect", async () => {
    const { handlers, controller } = setup();
    const { id } = (await runFactory(handlers))();
    await expect(handlers.cancelRun({ run: id })).rejects.toThrow("was not cancelled");
    controller.cancelRun.mockImplementationOnce(async (runId) => { db.updateRunStatus(runId, "cancelled"); });
    expect(await handlers.cancelRun({ run: id })).toMatchObject({ id, status: "cancelled" });
  });

  it("lists every active run and limits only the finished ones", async () => {
    const { handlers } = setup();
    const create = await runFactory(handlers);
    for (let index = 0; index < 35; index += 1) {
      create();
      db.updateRunStatus(create().id, "completed");
    }
    expect(await handlers.listRuns({ all: false })).toHaveLength(35);
    const all = await handlers.listRuns({ all: true });
    expect(all.filter((run) => run.status === "queued")).toHaveLength(35);
    expect(all.filter((run) => run.status === "completed")).toHaveLength(30);
  });
});
