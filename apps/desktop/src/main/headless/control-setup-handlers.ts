import { realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import {
  APP_SETTING_KEYS,
  connectionKindForProviderType,
  isProviderCliUpdateProviderType,
  parseAcpEnvironment,
  parseProviderCliUpdateSettings,
  PROVIDER_CONFIG_ACP_COMMAND_KEY,
  PROVIDER_CONFIG_ACP_ENV_KEY,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CODEX_HOME_PATH_KEY,
  PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY,
  PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY,
  PROVIDER_TYPES_BY_CONNECTION_KIND,
  serializeProviderCliUpdateSettings,
  type ModelRecord,
  type ProjectAutomationRecord,
  type ProjectRecord,
  type ProviderAccountRecord,
  type ProviderType,
  type RunListItem,
} from "@buildwarden/shared";
import type { BuildWardenDatabase } from "@buildwarden/db";
import type { AppController } from "../app-controller";
import { requireAbsolutePath, requireText } from "./control-input";
import {
  type HostAutomation,
  type HostControlHandlers,
  type HostModel,
  type HostProject,
  type HostProvider,
  type HostRun,
  type ProviderOptionName,
} from "./control-protocol";

export interface HostSetupDependencies {
  dataDir: string;
  db: Pick<BuildWardenDatabase,
    "getSettings" | "listModels" | "listProjectAutomations" | "listProjects" | "listProviderAccounts" | "getRun" | "listRunsForProject">;
  controller: Pick<AppController,
    | "addModel" | "addProject" | "addProviderAccount" | "cancelRun" | "checkProviderCliUpdates" | "compactDatabase"
    | "deleteDataRetentionCandidates" | "deleteModel" | "deleteProject" | "deleteProjectForgeAuthToken" | "deleteProviderAccount"
    | "getDatabaseStorageInfo" | "getDataRetentionCleanupImpact" | "getDetectedClaudeInstallation" | "getDetectedCodexInstallation"
    | "getDetectedCursorInstallation" | "getModelDeletionImpact" | "getProjectForgeAuthStatus" | "getProviderCliUpdates"
    | "listAvailableProviderModels" | "recheckProviderCapabilities" | "runProjectAutomationNow" | "runProviderCliUpdate"
    | "saveProjectForgeAuthToken" | "setAppSetting" | "setProviderApiKey" | "updateProjectAutomation">;
  /** Lets connected clients reload projects, providers and models. */
  onDataChanged: () => void;
  onForgeSettingsChanged: () => Promise<void>;
}

type SetupMethod =
  | "listProviders" | "findProvider" | "detectProviders" | "addProvider" | "setProviderKey" | "checkProvider" | "removeProvider"
  | "listModels" | "availableModels" | "addModel" | "modelImpact" | "removeModel"
  | "listProjects" | "addProject" | "projectImpact" | "removeProject" | "projectToken" | "setProjectToken" | "removeProjectToken"
  | "providerClis" | "checkProviderClis" | "updateProviderCli" | "enableProviderCliUpdates"
  | "listAutomations" | "runAutomation" | "enableAutomation"
  | "listRuns" | "cancelRun"
  | "storage" | "compactStorage" | "cleanupImpact" | "cleanup";

const MIN_ID_PREFIX_LENGTH = 4;
const RECENT_RUN_COUNT = 30;
const DEFAULT_AZURE_API_VERSION = "2024-06-01";
const ACTIVE_RUN_STATUSES = new Set<string>(["queued", "preparing", "running"]);

/** Which `provider add` options a provider type has, and where its configuration keeps them. */
const PROVIDER_OPTION_KEYS: Record<ProviderType, Partial<Record<ProviderOptionName, string>>> = {
  "codex-cli": { binary: PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY, home: PROVIDER_CONFIG_CODEX_HOME_PATH_KEY },
  "claude-code": { binary: PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY, "launch-args": PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY },
  "cursor-agent": { binary: PROVIDER_CONFIG_CURSOR_BINARY_PATH_KEY, endpoint: PROVIDER_CONFIG_CURSOR_API_ENDPOINT_KEY },
  acp: { command: PROVIDER_CONFIG_ACP_COMMAND_KEY, env: PROVIDER_CONFIG_ACP_ENV_KEY },
  "azure-legacy": { "api-version": PROVIDER_CONFIG_AZURE_API_VERSION_KEY },
  "ai-sdk": {},
  openrouter: {},
};
const JSON_CONFIG_TYPES = new Set<ProviderType>(["ai-sdk", "openrouter", "acp"]);
const PROVIDER_FAMILIES = ["openai", "anthropic", "google", "xai", "openai-compatible"];

const isProviderType = (value: unknown): value is ProviderType =>
  Object.values(PROVIDER_TYPES_BY_CONNECTION_KIND).flat().some((type) => type === value);

const isLocalProvider = (type: ProviderType): boolean => connectionKindForProviderType(type) === "local-sdk-cli";

const sameText = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Finds what a person typed: a full id, an exact name, or the start of an id as the lists print it. */
const resolveEntry = <Entry extends { id: string }>(
  entries: readonly Entry[],
  reference: unknown,
  label: string,
  namesOf: (entry: Entry) => string[] = () => [],
): Entry => {
  const text = requireText(reference, label).trim();
  const byId = entries.find((entry) => entry.id === text);
  if (byId) return byId;
  const byName = entries.filter((entry) => namesOf(entry).some((name) => sameText(name, text)));
  const matches = byName.length > 0 || text.length < MIN_ID_PREFIX_LENGTH
    ? byName
    : entries.filter((entry) => entry.id.toLowerCase().startsWith(text.toLowerCase()));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length === 0
    ? `${label} not found: ${text}`
    : `${label} is not unique: ${text}. Use the id: ${matches.map((entry) => entry.id).join(", ")}`);
};

const parseConfigJson = (raw: unknown, type: ProviderType): Record<string, unknown> => {
  if (raw === undefined) return {};
  if (!JSON_CONFIG_TYPES.has(type)) throw new Error("This provider type has no --config.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText(raw, "Provider configuration"));
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The provider configuration must be a JSON object.");
  }
  return { ...parsed };
};

const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const toHostProject = (project: ProjectRecord): HostProject =>
  ({ id: project.id, name: project.name, path: project.repoPath, kind: project.kind });

const toHostRun = (run: RunListItem, project: ProjectRecord): HostRun => ({
  id: run.id,
  status: run.status,
  project: project.name,
  title: (run.title || run.prompt).split("\n", 1)[0].slice(0, 80),
  createdAt: run.createdAt,
});

/** Terminal commands that set up and maintain what the host works with. */
export const createHostSetupHandlers = (deps: HostSetupDependencies): Pick<HostControlHandlers, SetupMethod> => {
  const { db, controller } = deps;
  const findProvider = (reference: unknown): ProviderAccountRecord =>
    resolveEntry(db.listProviderAccounts(), reference, "Provider", (provider) => [provider.label]);
  const findModel = (reference: unknown): ModelRecord =>
    resolveEntry(db.listModels(), reference, "Model", (model) => [model.modelId, model.displayName]);
  const findProject = (reference: unknown): ProjectRecord =>
    resolveEntry(db.listProjects(), reference, "Project", (project) => [project.name, project.repoPath]);
  const findAutomation = (reference: unknown): ProjectAutomationRecord =>
    resolveEntry(db.listProjectAutomations(), reference, "Automation", (automation) => [automation.name]);
  const listRuns = (): Array<{ id: string; run: RunListItem; project: ProjectRecord }> =>
    db.listProjects().flatMap((project) => db.listRunsForProject(project.id, true).map((run) => ({ id: run.id, run, project })));

  const toHostProvider = (provider: ProviderAccountRecord): HostProvider => ({
    id: provider.id,
    label: provider.label,
    type: provider.providerType,
    models: db.listModels().filter((model) => model.providerAccountId === provider.id).length,
  });
  const toHostModel = (model: ModelRecord): HostModel => ({
    id: model.id,
    modelId: model.modelId,
    name: model.displayName,
    provider: db.listProviderAccounts().find((provider) => provider.id === model.providerAccountId)?.label ?? "",
  });
  const toHostAutomation = (automation: ProjectAutomationRecord): HostAutomation => ({
    id: automation.id,
    name: automation.name,
    project: db.listProjects().find((project) => project.id === automation.projectId)?.name ?? "",
    enabled: Boolean(automation.enabled),
    nextRunAt: automation.nextRunAt,
    lastError: automation.lastError,
  });
  const detectInstallation = (type: ProviderType): Promise<{ binaryPath: string | null; message?: string }> => {
    if (type === "codex-cli") return controller.getDetectedCodexInstallation();
    if (type === "claude-code") return controller.getDetectedClaudeInstallation();
    if (type === "cursor-agent") return controller.getDetectedCursorInstallation();
    return Promise.resolve({ binaryPath: null });
  };

  const buildProviderConfig = async (type: ProviderType, options: unknown, configJson: unknown): Promise<Record<string, unknown>> => {
    const config = parseConfigJson(configJson, type);
    const keys = PROVIDER_OPTION_KEYS[type];
    for (const [name, value] of Object.entries(options && typeof options === "object" ? options : {})) {
      const key = Object.hasOwn(keys, name) ? keys[name as ProviderOptionName] : undefined;
      if (!key) throw new Error(`--${name} does not apply to this provider type.`);
      config[key] = requireText(value, `--${name}`).trim();
    }
    if (typeof config[PROVIDER_CONFIG_ACP_ENV_KEY] === "string") parseAcpEnvironment(config[PROVIDER_CONFIG_ACP_ENV_KEY]);
    if (type === "azure-legacy") config[PROVIDER_CONFIG_AZURE_API_VERSION_KEY] ??= DEFAULT_AZURE_API_VERSION;
    if (keys.binary && !config[keys.binary]) {
      const { binaryPath } = await detectInstallation(type);
      if (binaryPath) config[keys.binary] = binaryPath;
    }
    return config;
  };

  return {
    listProviders: async () => db.listProviderAccounts().map(toHostProvider),
    findProvider: async (input) => toHostProvider(findProvider(input?.provider)),
    detectProviders: async () => Promise.all(([["codex-cli", "Codex"], ["claude-code", "Claude Code"], ["cursor-agent", "Cursor"]] as const)
      .map(async ([type, label]) => {
        const found = await detectInstallation(type);
        return { type, label, path: found.binaryPath, ...(found.message ? { message: found.message } : {}) };
      })),
    addProvider: async (input) => {
      const type = input?.providerType;
      if (!isProviderType(type)) throw new Error("Unknown provider type.");
      const config = await buildProviderConfig(type, input.options, input.configJson);
      if (type === "ai-sdk") {
        if (!input.family || !PROVIDER_FAMILIES.includes(input.family)) throw new Error("Unknown provider family.");
        config[PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY] = input.family;
      }
      const label = requireText(input.label, "Provider name").trim();
      // Commands refer to providers by name.
      if (db.listProviderAccounts().some((provider) => sameText(provider.label, label))) {
        throw new Error(`A provider named ${label} already exists. Choose another name with --label.`);
      }
      if (input.apiBaseUrl !== undefined && isLocalProvider(type)) throw new Error("--base-url does not apply to this provider type.");
      const provider = await controller.addProviderAccount({
        providerType: type,
        label,
        apiKey: !isLocalProvider(type) && typeof input.apiKey === "string" ? input.apiKey : "",
        ...(input.apiBaseUrl === undefined ? {} : { apiBaseUrl: requireText(input.apiBaseUrl, "Base URL") }),
        config,
      });
      deps.onDataChanged();
      return toHostProvider(provider);
    },
    setProviderKey: async (input) => {
      const provider = findProvider(input?.provider);
      await controller.setProviderApiKey(provider.id, requireText(input.apiKey, "API key"));
      return toHostProvider(provider);
    },
    checkProvider: async (input) => {
      const { message } = await controller.recheckProviderCapabilities(findProvider(input?.provider).id);
      deps.onDataChanged();
      return { message };
    },
    removeProvider: async (input) => {
      await controller.deleteProviderAccount(findProvider(input?.provider).id);
      deps.onDataChanged();
      return null;
    },

    listModels: async () => db.listModels().map(toHostModel),
    availableModels: async (input) => {
      const provider = findProvider(input?.provider);
      const added = new Set(db.listModels().filter((model) => model.providerAccountId === provider.id).map((model) => model.modelId));
      const result = await controller.listAvailableProviderModels({ providerAccountId: provider.id });
      return {
        models: result.models.map((model) => ({ modelId: model.modelId, name: model.displayName, added: added.has(model.modelId) })),
        ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      };
    },
    addModel: async (input) => {
      const provider = findProvider(input?.provider);
      const modelId = requireText(input.modelId, "Model id").trim();
      if (db.listModels().some((model) => model.providerAccountId === provider.id && model.modelId === modelId)) {
        throw new Error(`${provider.label} already has the model ${modelId}.`);
      }
      const available = (await controller.listAvailableProviderModels({ providerAccountId: provider.id })).models
        .find((model) => model.modelId === modelId);
      const model = await controller.addModel({
        providerAccountId: provider.id,
        modelId,
        displayName: input.name?.trim() || available?.displayName || modelId,
        ...(input.baseUrl === undefined ? {} : { baseUrlOverride: requireText(input.baseUrl, "Base URL") }),
        ...(available?.config ? { config: available.config } : {}),
        ...(available?.capabilities ? { capabilities: available.capabilities } : {}),
      });
      deps.onDataChanged();
      return toHostModel(model);
    },
    modelImpact: async (input) => controller.getModelDeletionImpact(findModel(input?.model).id),
    removeModel: async (input) => {
      await controller.deleteModel(requireText(input?.modelId, "Model id"));
      deps.onDataChanged();
      return null;
    },

    listProjects: async () => db.listProjects().map(toHostProject),
    addProject: async (input) => {
      const path = requireAbsolutePath(input?.path, "Project path");
      const existing = db.listProjects().find((project) => realPath(project.repoPath) === realPath(path));
      if (existing) throw new Error(`This folder is already the project ${existing.name}.`);
      const name = typeof input.name === "string" ? input.name : undefined;
      const project = await controller.addProject({ repoPath: path, ...(name ? { name } : {}) });
      deps.onDataChanged();
      return toHostProject(project);
    },
    projectImpact: async (input) => {
      const project = findProject(input?.project);
      const runs = db.listRunsForProject(project.id, true);
      return {
        project: toHostProject(project),
        runs: runs.length,
        activeRuns: runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length,
      };
    },
    removeProject: async (input) => {
      await controller.deleteProject(requireText(input?.projectId, "Project id"));
      await deps.onForgeSettingsChanged();
      deps.onDataChanged();
      return null;
    },
    projectToken: async (input) => controller.getProjectForgeAuthStatus(findProject(input?.project).id),
    setProjectToken: async (input) => {
      const status = await controller.saveProjectForgeAuthToken(findProject(input?.project).id, requireText(input.token, "Access token"));
      await deps.onForgeSettingsChanged();
      return status;
    },
    removeProjectToken: async (input) => {
      const status = await controller.deleteProjectForgeAuthToken(findProject(input?.project).id);
      await deps.onForgeSettingsChanged();
      return status;
    },

    providerClis: () => controller.getProviderCliUpdates(),
    checkProviderClis: () => controller.checkProviderCliUpdates(),
    updateProviderCli: async (input) => {
      if (!isProviderCliUpdateProviderType(input?.providerType)) throw new Error("Unknown command-line tool.");
      return controller.runProviderCliUpdate(input.providerType);
    },
    enableProviderCliUpdates: async (input) => {
      const settings = parseProviderCliUpdateSettings(db.getSettings()[APP_SETTING_KEYS.providerCliUpdates]);
      await controller.setAppSetting(
        APP_SETTING_KEYS.providerCliUpdates,
        serializeProviderCliUpdateSettings({ ...settings, enabled: input?.enabled === true }),
      );
      deps.onDataChanged();
      return controller.getProviderCliUpdates();
    },

    listAutomations: async () => db.listProjectAutomations().map(toHostAutomation),
    runAutomation: async (input) => ({ runId: (await controller.runProjectAutomationNow(findAutomation(input?.automation).id)).id }),
    enableAutomation: async (input) => {
      const automation = await controller.updateProjectAutomation(findAutomation(input?.automation).id, { enabled: input.enabled === true });
      deps.onDataChanged();
      return toHostAutomation(automation);
    },

    listRuns: async (input) => {
      const runs = listRuns().sort((left, right) => right.run.createdAt.localeCompare(left.run.createdAt));
      // Every active run is listed, so each of them can be found and cancelled.
      let finished = 0;
      return runs
        .filter(({ run }) => ACTIVE_RUN_STATUSES.has(run.status) || (input?.all === true && ++finished <= RECENT_RUN_COUNT))
        .map(({ run, project }) => toHostRun(run, project));
    },
    cancelRun: async (input) => {
      const { run, project } = resolveEntry(listRuns(), input?.run, "Run");
      if (!ACTIVE_RUN_STATUSES.has(run.status)) throw new Error("This run is not active.");
      await controller.cancelRun(run.id);
      const { status } = db.getRun(run.id);
      // A run without a worker yet cannot be stopped, and the controller then leaves it alone.
      if (ACTIVE_RUN_STATUSES.has(status)) throw new Error("This run is still starting and was not cancelled. Try again in a moment.");
      if (status !== "cancelled") throw new Error(`This run ended before it could be cancelled (${status}).`);
      return toHostRun({ ...run, status }, project);
    },

    storage: async () => {
      const disk = await statfs(deps.dataDir);
      return { ...await controller.getDatabaseStorageInfo(), diskFreeBytes: disk.bavail * disk.bsize };
    },
    compactStorage: () => controller.compactDatabase(),
    cleanupImpact: async (input) => controller.getDataRetentionCleanupImpact(Number(input?.days)),
    cleanup: async (input) => {
      const impact = await controller.deleteDataRetentionCandidates(Number(input?.days), requireText(input.cutoffAt, "Cutoff"));
      deps.onDataChanged();
      return impact;
    },
  };
};
