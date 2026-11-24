import type { ModelDeletionTargets } from "@buildwarden/db";
import {
  APP_SETTING_KEYS,
  type ComposerCommandContext,
  type ComposerCommandDescriptor,
  filterComposerCommandDescriptors,
  getAiSdkProviderFamilyFromConfigJson,
  getDefaultProviderCapabilities,
  getModelPresetsForProvider,
  type ListAvailableProviderModelsInput,
  type ListAvailableProviderModelsResult,
  listComposerCommandsForProvider,
  type ListComposerCommandsInput,
  mergeComposerCommandDescriptors,
  type ModelDeletionImpact,
  type ModelInput,
  type ModelRecord,
  type OrchestrationRecord,
  parseCouncilSettings,
  parseOrchestrationTeamSettings,
  parseProjectLabSettingsSetting,
  parseProjectRunDefaultsSetting,
  type ProviderAccountInput,
  type ProviderAccountRecord,
  type ProviderAvailableModel,
  type ProviderCapabilityRecheckResult,
  removeCouncilReviewerModel,
  type RunRecord,
  serializeProjectLabSettingsSetting,
} from "@buildwarden/shared";
import { listAcpRegistryAgents } from "../acp-registry";
import { logError } from "../logger";
import { loadClaudeProvider, loadCodexProvider, loadCursorProvider, loadProxyAwareFetch } from "../provider-modules";
import { AppService } from "./app-service";
import { parseProviderConfigJson } from "./provider-model-support";

const dedupeAvailableProviderModels = (models: readonly ProviderAvailableModel[]): ProviderAvailableModel[] => {
  const seen = new Set<string>();
  const deduped: ProviderAvailableModel[] = [];
  for (const model of models) {
    const modelId = model.modelId.trim();
    if (!modelId) {
      continue;
    }
    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({
      ...model,
      modelId,
      displayName: model.displayName.trim() || modelId,
    });
  }
  return deduped;
};

const getCuratedAvailableModelsForProvider = (provider: ProviderAccountRecord): ProviderAvailableModel[] => {
  const providerFamily =
    provider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : undefined;
  return getModelPresetsForProvider(provider.providerType, providerFamily).map((preset) => ({
    modelId: preset.modelId,
    displayName: preset.displayName,
    source: "curated" as const,
  }));
};

const makeNativeComposerCommand = (
  providerType: ProviderAccountRecord["providerType"],
  command: `/${string}`,
  description: string,
  argumentHint?: string,
): ComposerCommandDescriptor => ({
  id: `${providerType}:${command.slice(1).replace(/[^a-z0-9_.:-]+/gi, "-")}`,
  command: command.toLowerCase() as `/${string}`,
  label: command.slice(1),
  description,
  providerType,
  effect: "native-prompt",
  ...(argumentHint ? { argumentHint } : {}),
  source: "provider",
  supportsRun: true,
  supportsFollowUp: true,
});

const CODEX_NATIVE_COMPOSER_COMMANDS: readonly ComposerCommandDescriptor[] = [
  makeNativeComposerCommand("codex-cli", "/agent", "Manage or switch Codex agents."),
  makeNativeComposerCommand("codex-cli", "/apps", "Manage Codex apps and connectors."),
  makeNativeComposerCommand("codex-cli", "/approve", "Review pending approvals."),
  makeNativeComposerCommand("codex-cli", "/clear", "Clear the current conversation context."),
  makeNativeComposerCommand("codex-cli", "/compact", "Compact the conversation context."),
  makeNativeComposerCommand("codex-cli", "/copy", "Copy the latest assistant response."),
  makeNativeComposerCommand("codex-cli", "/debug-config", "Show Codex debug configuration."),
  makeNativeComposerCommand("codex-cli", "/diff", "Show current code changes."),
  makeNativeComposerCommand("codex-cli", "/exit", "Exit the session."),
  makeNativeComposerCommand("codex-cli", "/experimental", "Open experimental Codex features."),
  makeNativeComposerCommand("codex-cli", "/fast", "Switch to a faster model or effort profile."),
  makeNativeComposerCommand("codex-cli", "/feedback", "Send feedback."),
  makeNativeComposerCommand("codex-cli", "/fork", "Fork the current conversation."),
  makeNativeComposerCommand("codex-cli", "/hooks", "Manage Codex hooks."),
  makeNativeComposerCommand("codex-cli", "/ide", "Manage IDE integration."),
  makeNativeComposerCommand("codex-cli", "/init", "Create or update repository instructions."),
  makeNativeComposerCommand("codex-cli", "/keymap", "Change keyboard shortcuts."),
  makeNativeComposerCommand("codex-cli", "/logout", "Sign out of Codex."),
  makeNativeComposerCommand("codex-cli", "/mcp", "Manage MCP servers and tools."),
  makeNativeComposerCommand("codex-cli", "/memories", "Manage saved memories."),
  makeNativeComposerCommand("codex-cli", "/mention", "Mention a file, symbol, or resource.", "<target>"),
  makeNativeComposerCommand("codex-cli", "/model", "Change the active model."),
  makeNativeComposerCommand("codex-cli", "/new", "Start a new session."),
  makeNativeComposerCommand("codex-cli", "/permissions", "Review or update permissions."),
  makeNativeComposerCommand("codex-cli", "/personality", "Adjust the assistant personality."),
  makeNativeComposerCommand("codex-cli", "/plugins", "Manage Codex plugins."),
  makeNativeComposerCommand("codex-cli", "/ps", "Show active Codex sessions."),
  makeNativeComposerCommand("codex-cli", "/quit", "Quit the session."),
  makeNativeComposerCommand("codex-cli", "/raw", "Send raw text without command interpretation."),
  makeNativeComposerCommand("codex-cli", "/resume", "Resume a previous session."),
  makeNativeComposerCommand("codex-cli", "/review", "Review current code changes."),
  makeNativeComposerCommand("codex-cli", "/sandbox-add-read-dir", "Allow Codex to read another directory.", "<path>"),
  makeNativeComposerCommand("codex-cli", "/side", "Open side-by-side mode."),
  makeNativeComposerCommand("codex-cli", "/skills", "List or manage Codex skills."),
  makeNativeComposerCommand("codex-cli", "/status", "Show session status."),
  makeNativeComposerCommand("codex-cli", "/statusline", "Configure the status line."),
  makeNativeComposerCommand("codex-cli", "/stop", "Stop the current response."),
  makeNativeComposerCommand("codex-cli", "/theme", "Change the theme."),
  makeNativeComposerCommand("codex-cli", "/title", "Set the session title.", "<title>"),
  makeNativeComposerCommand("codex-cli", "/vim", "Toggle Vim keybindings."),
];

type ClaudeSlashCommand = Awaited<ReturnType<typeof import("@buildwarden/provider-claude-code").listClaudeCodeSlashCommands>>[number];

const normalizeProviderSlashCommandName = (value: string): `/${string}` | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return /^\/[A-Za-z][A-Za-z0-9_.:-]*$/.test(withSlash) ? (withSlash.toLowerCase() as `/${string}`) : null;
};

const buildClaudeComposerCommandDescriptors = (
  commands: ClaudeSlashCommand[],
  providerType: ProviderAccountRecord["providerType"],
): ComposerCommandDescriptor[] => commands.flatMap((command) =>
  [command.name, ...(command.aliases ?? [])].flatMap((name) => {
    const normalized = normalizeProviderSlashCommandName(name);
    if (!normalized) {
      return [];
    }
    return [{
      id: `${providerType}:${normalized.slice(1)}`,
      command: normalized,
      label: normalized.slice(1),
      description: command.description || command.argumentHint || "Run this Claude Code slash command.",
      providerType,
      effect: "native-prompt" as const,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      source: "provider" as const,
      supportsRun: true,
      supportsFollowUp: true,
    }];
  }),
);

/** Manages provider accounts, models and composer commands. */
export class ProviderAccountService extends AppService<"appState" | "controller" | "providerRuntime" | "settings"> {
  readonly composerCommandCache = new Map<string, { expiresAt: number; commands: ComposerCommandDescriptor[] }>();
  private readonly composerCommandInflight = new Map<string, Promise<ComposerCommandDescriptor[]>>();

  async addProviderAccount(input: ProviderAccountInput): Promise<ProviderAccountRecord> {
    (await this.services.providerRuntime.getProviderAdapter(input.providerType)).validateConfiguration(input);
    if (input.providerType === "codex-cli") {
      (await loadCodexProvider()).assertCodexCliAvailable(input.config);
    } else if (input.providerType === "claude-code") {
      (await loadClaudeProvider()).assertClaudeCodeAvailable(input.config);
    } else if (input.providerType === "cursor-agent") {
      await (await loadCursorProvider()).assertCursorAgentAvailable(input.config);
    }

    const keyRef = `provider:${crypto.randomUUID()}`;
    await this.secrets.saveSecret(keyRef, input.apiKey);

    return this.db.addProviderAccount({
      providerType: input.providerType,
      label: input.label.trim(),
      apiBaseUrl: input.apiBaseUrl?.trim() || null,
      apiKeyRef: keyRef,
      configJson: JSON.stringify(input.config ?? {}),
    });
  }

  async addModel(input: ModelInput): Promise<ModelRecord> {
    const provider = this.db.getProviderAccount(input.providerAccountId);
    return this.db.addModel({
      ...input,
      capabilities: {
        ...getDefaultProviderCapabilities(provider.providerType),
        ...input.capabilities,
        supportsToolsSource: typeof input.capabilities?.supportsTools === "boolean" ? "model" : "provider-default",
      },
      config: input.config,
    });
  }

  async listAvailableProviderModels(
    input: ListAvailableProviderModelsInput,
  ): Promise<ListAvailableProviderModelsResult> {
    const provider = this.db.getProviderAccount(input.providerAccountId);
    const fallbackModels = dedupeAvailableProviderModels(getCuratedAvailableModelsForProvider(provider));
    try {
      const adapter = await this.services.providerRuntime.getProviderAdapter(provider.providerType);
      if (!adapter.listAvailableModels) {
        return { models: fallbackModels };
      }
      const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
      const apiKey = provider.providerType === "openrouter"
        ? await this.secrets.readSecret(provider.apiKeyRef)
        : null;
      const models = await adapter.listAvailableModels({
        providerAccountId: provider.id,
        providerType: provider.providerType,
        config: parseProviderConfigJson(provider.configJson),
        ...(apiKey !== null ? { apiKey } : {}),
        apiBaseUrl: provider.apiBaseUrl,
        ...(networkProxy ? { networkProxy } : {}),
      });
      return { models: dedupeAvailableProviderModels(models) };
    } catch (error) {
      logError("provider.models.load.failed", { providerType: provider.providerType, error });
      const detail = error instanceof Error ? error.message : "Available models could not be loaded.";
      return {
        models: fallbackModels,
        errorMessage: detail,
      };
    }
  }

  async listComposerCommands(input: ListComposerCommandsInput): Promise<ComposerCommandDescriptor[]> {
    const modelId = input.modelId.trim();
    if (!modelId) {
      return [];
    }

    let model: ModelRecord;
    let provider: ProviderAccountRecord;
    let projectPath: string | undefined;
    try {
      model = this.db.getModel(modelId);
      provider = this.db.getProviderAccount(model.providerAccountId);
      if (input.projectId?.trim()) {
        projectPath = this.db.getProject(input.projectId).repoPath;
      }
    } catch {
      return [];
    }

    const context: ComposerCommandContext = input.context;
    const cacheKey = [provider.id, provider.providerType, model.id, projectPath ?? "", context].join("|");
    const now = Date.now();
    const cached = this.composerCommandCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return filterComposerCommandDescriptors(cached.commands, input.query);
    }

    const existing = this.composerCommandInflight.get(cacheKey);
    const pending = existing ?? this.loadComposerCommandsForProvider(provider, projectPath, context);
    this.composerCommandInflight.set(cacheKey, pending);

    try {
      const commands = await pending;
      this.composerCommandCache.set(cacheKey, {
        commands,
        expiresAt: Date.now() + 30_000,
      });
      return filterComposerCommandDescriptors(commands, input.query);
    } finally {
      if (this.composerCommandInflight.get(cacheKey) === pending) {
        this.composerCommandInflight.delete(cacheKey);
      }
    }
  }

  private async loadComposerCommandsForProvider(
    provider: ProviderAccountRecord,
    projectPath: string | undefined,
    context: ComposerCommandContext,
  ): Promise<ComposerCommandDescriptor[]> {
    const staticCommands = listComposerCommandsForProvider(provider.providerType, context);
    const providerCommands = await this.loadNativeComposerCommands(provider, projectPath);

    return mergeComposerCommandDescriptors([...staticCommands, ...providerCommands], context);
  }

  private async loadNativeComposerCommands(
    provider: ProviderAccountRecord,
    projectPath: string | undefined,
  ): Promise<ComposerCommandDescriptor[]> {
    if (provider.providerType === "codex-cli") {
      return [...CODEX_NATIVE_COMPOSER_COMMANDS];
    }
    if (provider.providerType !== "claude-code") {
      return [];
    }
    try {
      const commands = await (await loadClaudeProvider()).listClaudeCodeSlashCommands({
        cwd: projectPath,
        config: parseProviderConfigJson(provider.configJson),
        networkProxy: await this.services.settings.resolveNetworkProxyRuntimeConfig(),
      });
      return buildClaudeComposerCommandDescriptors(commands, provider.providerType);
    } catch (error) {
      this.logControllerWarn("Failed to probe Claude Code slash commands.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async deleteProviderAccount(providerAccountId: string): Promise<void> {
    const provider = this.db.getProviderAccount(providerAccountId);
    const referenceCount = this.db.countProviderAccountReferences(providerAccountId);

    if (referenceCount > 0) {
      throw new Error("This provider cannot be deleted because existing runs or automations reference it.");
    }

    await this.secrets.deleteSecret(provider.apiKeyRef);
    this.db.deleteProviderAccount(providerAccountId);
    this.services.providerRuntime.forgetSessionCapabilities(providerAccountId);
  }

  async recheckProviderCapabilities(providerAccountId: string): Promise<ProviderCapabilityRecheckResult> {
    const provider = this.db.getProviderAccount(providerAccountId);
    this.services.providerRuntime.forgetSessionCapabilities(provider.id);
    const adapter = await this.services.providerRuntime.getProviderAdapter(provider.providerType);
    if (!adapter.probeSessionCapabilities) {
      return { report: null, message: `${provider.label} reports its capabilities when its next session starts.` };
    }
    const networkProxy = await this.services.settings.resolveNetworkProxyRuntimeConfig();
    const probed = await adapter.probeSessionCapabilities({
      providerAccountId: provider.id,
      providerType: provider.providerType,
      config: parseProviderConfigJson(provider.configJson),
      apiBaseUrl: provider.apiBaseUrl,
      ...(networkProxy ? { networkProxy } : {}),
    });
    const report = this.services.providerRuntime.rememberSessionCapabilities(provider, probed);
    const agent = [report.agentName, report.agentVersion].filter(Boolean).join(" ") || provider.label;
    const loginMethods = report.authMethods?.map((method) => `${method.name} (${method.id})`).join(", ");
    return { report, message: `Checked ${agent} again.${loginMethods ? ` Available agent login methods: ${loginMethods}. Set acpAuthMethod in the provider's advanced configuration to select one.` : ""}` };
  }

  async listAcpRegistryAgents() {
    const proxyFetch = await loadProxyAwareFetch(await this.services.settings.resolveNetworkProxyRuntimeConfig()) ?? fetch;
    return listAcpRegistryAgents(proxyFetch);
  }

  async deleteModel(modelId: string): Promise<void> {
    this.db.getModel(modelId);
    const targets = this.db.getModelDeletionTargets(modelId);
    const previousSelection = this.db.getSettings();

    try {
      await this.deleteModelRelatedData(modelId, targets);
    } finally {
      this.services.appState.restoreSelectionAfterDeletion(previousSelection);
    }
  }

  private async deleteModelRelatedData(modelId: string, targets: ModelDeletionTargets): Promise<void> {

    for (const threadId of targets.projectLabThreadIds) {
      try {
        this.db.getProjectLabThread(threadId);
      } catch {
        continue;
      }
      await this.services.controller.deleteProjectLabThread(threadId);
    }

    for (const loopId of targets.projectLoopIds) {
      try {
        this.db.getProjectLoop(loopId);
      } catch {
        continue;
      }
      await this.services.controller.loopRunner.deleteLoop(loopId);
    }

    for (const orchestrationId of targets.orchestrationIds) {
      let orchestration: OrchestrationRecord;
      try {
        orchestration = this.db.getOrchestration(orchestrationId);
      } catch {
        continue;
      }
      try {
        this.db.getRun(orchestration.coordinatorRunId);
      } catch {
        continue;
      }
      await this.services.controller.deleteRun(orchestration.coordinatorRunId);
    }

    for (const runId of targets.runIds) {
      let targetRun: RunRecord;
      try {
        targetRun = this.db.getRun(runId);
      } catch {
        continue;
      }
      if (targetRun.kind === "council-review") {
        // The parent run may use another model, and its saved results do not need this run.
        if (targetRun.parentRunId) await this.services.controller.getCouncilService().stopForRun(targetRun.parentRunId);
        await this.services.controller.deleteCouncilChildRun(runId);
        continue;
      }
      const ownedTask = this.db.getOrchestrationTaskByChildRunId(runId);
      if (ownedTask) {
        let orchestration: OrchestrationRecord | null = null;
        try {
          orchestration = this.db.getOrchestration(ownedTask.orchestrationId);
        } catch {
          /* A stale task row must not prevent deleting its surviving child run. */
        }
        await this.services.controller.deleteRun(orchestration?.coordinatorRunId ?? runId);
      } else {
        await this.services.controller.deleteRun(runId);
      }
    }

    for (const chatId of targets.chatIds) {
      try {
        this.db.getChat(chatId);
      } catch {
        continue;
      }
      await this.services.controller.deleteChat(chatId);
    }

    this.db.deleteProjectInsights(targets.projectInsightIds);
    for (const automationId of targets.automationIds) {
      try {
        this.db.deleteProjectAutomation(automationId);
      } catch {
        /* Re-check below reports any surviving automation reference. */
      }
    }
    const remainingTargets = this.db.getModelDeletionTargets(modelId);
    if (
      remainingTargets.runIds.length > 0 ||
      remainingTargets.chatIds.length > 0 ||
      remainingTargets.projectInsightIds.length > 0 ||
      remainingTargets.projectLabThreadIds.length > 0 ||
      remainingTargets.projectLoopIds.length > 0 ||
      remainingTargets.orchestrationIds.length > 0 ||
      remainingTargets.automationIds.length > 0
    ) {
      throw new Error("Some model-related data could not be deleted. Retry after active work has stopped.");
    }
    this.removeModelFromPersistedSettings(modelId);
    this.db.deleteModel(modelId);
  }

  private removeModelFromPersistedSettings(modelId: string): void {
    const settings = this.db.getSettings();
    if (settings[APP_SETTING_KEYS.sessionTitleModelId] === modelId) this.db.deleteSetting(APP_SETTING_KEYS.sessionTitleModelId);
    const projectLabSettingsJson = settings[APP_SETTING_KEYS.projectLabSettings];
    if (projectLabSettingsJson?.includes(modelId)) {
      const projectLabSettings = parseProjectLabSettingsSetting(projectLabSettingsJson);
      const nextProjectLabSettings = Object.fromEntries(
        Object.entries(projectLabSettings).map(([projectId, projectSettings]) => [projectId, {
          ...projectSettings,
          implementationModelId: projectSettings.implementationModelId === modelId
            ? null
            : projectSettings.implementationModelId,
          reviewModelId: projectSettings.reviewModelId === modelId ? null : projectSettings.reviewModelId,
        }]),
      );
      this.db.setSetting(
        APP_SETTING_KEYS.projectLabSettings,
        serializeProjectLabSettingsSetting(nextProjectLabSettings),
      );
    }

    const runDefaultsJson = settings[APP_SETTING_KEYS.projectRunDefaults];
    if (runDefaultsJson?.includes(modelId)) {
      const runDefaults = parseProjectRunDefaultsSetting(runDefaultsJson);
      const nextRunDefaults = Object.fromEntries(Object.entries(runDefaults).map(([projectId, defaults]) => {
        const modelConfigurations = { ...defaults.modelConfigurations };
        delete modelConfigurations[modelId];
        return [projectId, {
          ...defaults,
          modelId: defaults.modelId === modelId ? "" : defaults.modelId,
          worktreeModelIds: defaults.worktreeModelIds.filter((id) => id !== modelId),
          modelConfigurations,
        }];
      }));
      this.db.setSetting(APP_SETTING_KEYS.projectRunDefaults, JSON.stringify(nextRunDefaults));
    }

    const orchestrationTeamJson = settings[APP_SETTING_KEYS.orchestrationTeam];
    if (orchestrationTeamJson?.includes(modelId)) {
      const team = parseOrchestrationTeamSettings(orchestrationTeamJson);
      const roles = team.roles.flatMap((role) => {
        const eligibleModelIds = role.eligibleModelIds.filter((id) => id !== modelId);
        if (eligibleModelIds.length === 0) return [];
        return [{
          ...role,
          eligibleModelIds,
          preferredModelId: role.preferredModelId === modelId ? eligibleModelIds[0] : role.preferredModelId,
        }];
      });
      this.db.setSetting(APP_SETTING_KEYS.orchestrationTeam, JSON.stringify({
        ...team,
        models: team.models.filter((entry) => entry.modelId !== modelId),
        roles,
      }));
    }

    const councilJson = settings[APP_SETTING_KEYS.council];
    if (councilJson?.includes(modelId)) {
      this.db.setSetting(APP_SETTING_KEYS.council, JSON.stringify(removeCouncilReviewerModel(parseCouncilSettings(councilJson), modelId)));
    }
  }

  async getModelDeletionImpact(modelId: string): Promise<ModelDeletionImpact> {
    const model = this.db.getModel(modelId);
    const targets = this.db.getModelDeletionTargets(modelId);
    const runIds = targets.runIds.filter((runId) => !this.services.controller.isCouncilReviewRun(runId));
    return {
      modelId: model.id,
      modelDisplayName: model.displayName,
      runIds,
      chatIds: targets.chatIds,
      runCount: runIds.length,
      chatCount: targets.chatIds.length,
      projectInsightCount: targets.projectInsightIds.length,
      projectLabThreadCount: targets.projectLabThreadIds.length,
      projectLoopCount: targets.projectLoopIds.length,
      orchestrationCount: targets.orchestrationIds.length,
      automationCount: targets.automationIds.length,
    };
  }
}
