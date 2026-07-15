import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildWardenDatabase } from "@buildwarden/db";
import { APP_SETTING_KEYS } from "@buildwarden/shared";
import type { ModelRecord, ProjectRecord, ProjectTaskRecord, ProviderAccountRecord, RunRecord } from "@buildwarden/shared";
import type { SecretStore } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "@buildwarden/git-service";
import { AppController } from "./app-controller";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { HostEventBus } from "./host-events";

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
  const logDir = mkdtempSync(join(tmpdir(), "buildwarden-controller-"));
  return {
    controller: new AppController(db, secrets, logDir, desktop, terminal, events),
    db,
    secrets,
    desktop,
    terminal,
    events,
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
