import { useEffect, useState } from "react";
import type {
  AppSnapshot,
  IntegratedSkillDefinition,
  NetworkProxySettingsInput,
  NetworkProxySettingsSnapshot,
  ProviderType,
  SupportedIdeKind,
  UiTheme,
  UnifiedProviderFamily,
} from "@easycode/shared";
import {
  parseIdePathConfig,
  serializeIdePathConfig,
  type KeyboardShortcutId,
} from "@easycode/shared";
import { ArrowLeft, Cpu, Database, FolderGit2, Globe, Settings2 } from "lucide-react";
import { APP_VERSION, APP_VERSION_DATE } from "../../lib/app-build-meta";
import {
  MODEL_PRESET_CUSTOM,
  emptyModelPresetsByGroup,
  getAiSdkProviderFamilyFromConfigJson,
  getModelPresetsByGroupForProvider,
  getModelPresetsForProvider,
} from "../../lib/openai-model-presets";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ProviderModelsSettingsTab } from "./settings-provider-models-tab";
import { GitWorkspaceSettingsTab } from "./settings-git-workspace-tab";
import { NetworkSettingsTab, type NetworkProxyDraft } from "./settings-network-tab";
import { SkillsSettingsTab } from "./settings-skills-tab";
import { UserSettingsTab } from "./settings-user-tab";

type SettingsTab = "provider-models" | "git-workspace" | "skills" | "network" | "user";

interface SettingsPageProps {
  busy: boolean;
  projects: AppSnapshot["projects"];
  projectName: string;
  projectPath: string;
  providerLabel: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily;
  apiKey: string;
  codexBinaryPath: string;
  codexHomePath: string;
  detectedCodexBinaryPath: string | null;
  claudeBinaryPath: string;
  claudeLaunchArgs: string;
  detectedClaudeBinaryPath: string | null;
  providerBaseUrl: string;
  providerConfigJson: string;
  providerAzureApiVersion: string;
  selectedProviderId: string;
  modelId: string;
  modelDisplayName: string;
  modelBaseUrl: string;
  autoCheckoutRunBranchOnOpen: boolean;
  autoReleaseRunBranchOnLeave: boolean;
  uiTheme: UiTheme;
  worktreeRootOverrideSettingValue: string;
  enableDevMode: boolean;
  appLogDirPath: string;
  networkProxySettings: NetworkProxySettingsSnapshot;
  providerAccounts: AppSnapshot["providerAccounts"];
  models: AppSnapshot["models"];
  onBack: () => void;
  onChooseDirectory: () => void;
  onPickDirectory: () => Promise<string | null>;
  onSubmitProject: () => void;
  onSubmitProvider: () => void;
  onSubmitModel: () => void;
  onDeleteProject: (projectId: string) => void;
  onDeleteProviderAccount: (providerAccountId: string) => void;
  onDeleteModel: (modelId: string) => void;
  onAutoCheckoutRunBranchOnOpenChange: (value: boolean) => void;
  onAutoReleaseRunBranchOnLeaveChange: (value: boolean) => void;
  onUiThemeChange: (theme: UiTheme) => void;
  onSaveWorktreeRootOverride: (value: string) => void | Promise<void>;
  onEnableDevModeChange: (value: boolean) => void;
  onProjectNameChange: (value: string) => void;
  onProjectPathChange: (value: string) => void;
  onProviderLabelChange: (value: string) => void;
  onProviderTypeChange: (value: ProviderType) => void;
  onProviderFamilyChange: (value: UnifiedProviderFamily) => void;
  onApiKeyChange: (value: string) => void;
  onCodexBinaryPathChange: (value: string) => void;
  onCodexHomePathChange: (value: string) => void;
  onClaudeBinaryPathChange: (value: string) => void;
  onClaudeLaunchArgsChange: (value: string) => void;
  onProviderBaseUrlChange: (value: string) => void;
  onProviderConfigJsonChange: (value: string) => void;
  onProviderAzureApiVersionChange: (value: string) => void;
  onSelectedProviderIdChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onModelDisplayNameChange: (value: string) => void;
  onModelBaseUrlChange: (value: string) => void;
  keyboardShortcuts: Record<KeyboardShortcutId, string>;
  onKeyboardShortcutChange: (id: KeyboardShortcutId, value: string) => void;
  builtInShellAllowlistPatterns: readonly string[];
  shellAllowlistExtraText: string;
  onShellAllowlistExtraSave: (text: string) => void | Promise<void>;
  onOpenAppLogDirectory: () => void | Promise<void>;
  onResetDatabase: () => void | Promise<void>;
  onSaveNetworkProxySettings: (input: NetworkProxySettingsInput) => Promise<NetworkProxySettingsSnapshot>;
  idePathsSettingValue: string;
  onSaveIdePaths: (serialized: string) => void | Promise<void>;
  onPickIdeExecutable: () => Promise<string | null>;
  integratedSkills: IntegratedSkillDefinition[];
  globallyDisabledIntegratedSkillIds: string[];
  onGloballyDisabledIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
}

const TAB_CONFIG: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: "provider-models", label: "Provider & Models", icon: <Cpu className="h-4 w-4" /> },
  { id: "git-workspace", label: "GIT & Workspace", icon: <FolderGit2 className="h-4 w-4" /> },
  { id: "skills", label: "Skills", icon: <Database className="h-4 w-4" /> },
  { id: "network", label: "Network", icon: <Globe className="h-4 w-4" /> },
  { id: "user", label: "User Settings", icon: <Settings2 className="h-4 w-4" /> },
];

const userShellLinesFromSavedText = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

const SettingsHeroMetric = ({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) => (
  <div className="app-surface-stat-tile rounded-2xl border px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[11px] uppercase tracking-[0.28em] text-zinc-500">{label}</p>
        <p className="mt-2 text-lg font-semibold text-zinc-50">{value}</p>
        <p className="mt-1 text-xs text-zinc-400">{hint}</p>
      </div>
      <span className="rounded-xl border border-cyan-400/15 bg-cyan-400/8 p-2 text-cyan-200">{icon}</span>
    </div>
  </div>
);

export const SettingsPage = ({
  busy,
  projects,
  projectName,
  projectPath,
  providerLabel,
  providerType,
  providerFamily,
  apiKey,
  codexBinaryPath,
  codexHomePath,
  detectedCodexBinaryPath,
  claudeBinaryPath,
  claudeLaunchArgs,
  detectedClaudeBinaryPath,
  providerBaseUrl,
  providerConfigJson,
  providerAzureApiVersion,
  selectedProviderId,
  modelId,
  modelDisplayName,
  modelBaseUrl,
  autoCheckoutRunBranchOnOpen,
  autoReleaseRunBranchOnLeave,
  uiTheme,
  worktreeRootOverrideSettingValue,
  enableDevMode,
  appLogDirPath,
  networkProxySettings,
  providerAccounts,
  models,
  onBack,
  onChooseDirectory,
  onPickDirectory,
  onSubmitProject,
  onSubmitProvider,
  onSubmitModel,
  onDeleteProject,
  onDeleteProviderAccount,
  onDeleteModel,
  onAutoCheckoutRunBranchOnOpenChange,
  onAutoReleaseRunBranchOnLeaveChange,
  onUiThemeChange,
  onSaveWorktreeRootOverride,
  onEnableDevModeChange,
  onProjectNameChange,
  onProjectPathChange,
  onProviderLabelChange,
  onProviderTypeChange,
  onProviderFamilyChange,
  onApiKeyChange,
  onCodexBinaryPathChange,
  onCodexHomePathChange,
  onClaudeBinaryPathChange,
  onClaudeLaunchArgsChange,
  onProviderBaseUrlChange,
  onProviderConfigJsonChange,
  onProviderAzureApiVersionChange,
  onSelectedProviderIdChange,
  onModelIdChange,
  onModelDisplayNameChange,
  onModelBaseUrlChange,
  keyboardShortcuts,
  onKeyboardShortcutChange,
  builtInShellAllowlistPatterns,
  shellAllowlistExtraText,
  onShellAllowlistExtraSave,
  onOpenAppLogDirectory,
  onResetDatabase,
  onSaveNetworkProxySettings,
  idePathsSettingValue,
  onSaveIdePaths,
  onPickIdeExecutable,
  integratedSkills,
  globallyDisabledIntegratedSkillIds,
  onGloballyDisabledIntegratedSkillIdsChange,
}: SettingsPageProps) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>("provider-models");
  const [openAiPresetUserChoseCustom, setOpenAiPresetUserChoseCustom] = useState(false);
  const [userShellPatternsDraft, setUserShellPatternsDraft] = useState(() => userShellLinesFromSavedText(shellAllowlistExtraText));
  const [shellAllowlistSaving, setShellAllowlistSaving] = useState(false);
  const [ideDraft, setIdeDraft] = useState(() => parseIdePathConfig(idePathsSettingValue));
  const [idePathsSaving, setIdePathsSaving] = useState(false);
  const [worktreeRootDraft, setWorktreeRootDraft] = useState(worktreeRootOverrideSettingValue);
  const [worktreeRootSaving, setWorktreeRootSaving] = useState(false);
  const [networkProxyDraft, setNetworkProxyDraft] = useState<NetworkProxyDraft>({
    ...networkProxySettings,
    password: "",
    clearSavedPassword: false,
  });
  const [networkProxySaving, setNetworkProxySaving] = useState(false);

  const selectedProviderAccount = providerAccounts.find((provider) => provider.id === selectedProviderId) ?? null;
  const modelPresetsForSelected = (() => {
    if (!selectedProviderAccount) return [];
    const fam =
      selectedProviderAccount.providerType === "ai-sdk"
        ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
        : undefined;
    return getModelPresetsForProvider(selectedProviderAccount.providerType, fam);
  })();
  const showModelPresets = modelPresetsForSelected.length > 0;
  const openAiPresetMatch = modelPresetsForSelected.find(
    (preset) => preset.modelId === modelId.trim() && preset.displayName === modelDisplayName.trim(),
  );
  const openAiPresetSelectValue =
    !showModelPresets || openAiPresetUserChoseCustom || !openAiPresetMatch ? MODEL_PRESET_CUSTOM : openAiPresetMatch.modelId;
  const openAiPresetsGrouped = selectedProviderAccount
    ? getModelPresetsByGroupForProvider(
        selectedProviderAccount.providerType,
        selectedProviderAccount.providerType === "ai-sdk"
          ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
          : undefined,
      )
    : emptyModelPresetsByGroup();

  useEffect(() => {
    setOpenAiPresetUserChoseCustom(false);
  }, [selectedProviderId]);

  useEffect(() => {
    if (!selectedProviderAccount) return;
    const fam =
      selectedProviderAccount.providerType === "ai-sdk"
        ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
        : undefined;
    const list = getModelPresetsForProvider(selectedProviderAccount.providerType, fam);
    if (list.length === 0) return;
    const stillValid = list.some(
      (preset) => preset.modelId === modelId.trim() && preset.displayName === modelDisplayName.trim(),
    );
    if (!stillValid) {
      const first = list[0]!;
      onModelIdChange(first.modelId);
      onModelDisplayNameChange(first.displayName);
    }
    // intentionally omit modelId / modelDisplayName and stable callbacks: revalidate only when the selected connection (or its config) changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProviderId, selectedProviderAccount?.id, selectedProviderAccount?.configJson, selectedProviderAccount?.providerType]);

  useEffect(() => {
    setUserShellPatternsDraft(userShellLinesFromSavedText(shellAllowlistExtraText));
  }, [shellAllowlistExtraText]);

  useEffect(() => {
    setIdeDraft(parseIdePathConfig(idePathsSettingValue));
  }, [idePathsSettingValue]);

  useEffect(() => {
    setWorktreeRootDraft(worktreeRootOverrideSettingValue);
  }, [worktreeRootOverrideSettingValue]);

  useEffect(() => {
    setNetworkProxyDraft({
      ...networkProxySettings,
      password: "",
      clearSavedPassword: false,
    });
  }, [networkProxySettings]);

  const normalizedSavedIdePaths = serializeIdePathConfig(parseIdePathConfig(idePathsSettingValue));
  const normalizedIdeDraft = serializeIdePathConfig(ideDraft);
  const idePathsDirty = normalizedIdeDraft !== normalizedSavedIdePaths;
  const normalizedSavedWorktreeRoot = worktreeRootOverrideSettingValue.trim();
  const normalizedWorktreeRootDraft = worktreeRootDraft.trim();
  const worktreeRootDirty = normalizedWorktreeRootDraft !== normalizedSavedWorktreeRoot;
  const savedUserShellLines = userShellLinesFromSavedText(shellAllowlistExtraText);
  const shellAllowlistDirty = JSON.stringify(userShellPatternsDraft) !== JSON.stringify(savedUserShellLines);
  const networkProxyDirty =
    networkProxyDraft.enabled !== networkProxySettings.enabled ||
    networkProxyDraft.protocol !== networkProxySettings.protocol ||
    networkProxyDraft.host.trim() !== networkProxySettings.host ||
    networkProxyDraft.port.trim() !== networkProxySettings.port ||
    networkProxyDraft.username.trim() !== networkProxySettings.username ||
    networkProxyDraft.password.length > 0 ||
    networkProxyDraft.clearSavedPassword;

  const browseIdeExecutable = async (kind: SupportedIdeKind) => {
    try {
      const picked = await onPickIdeExecutable();
      if (picked) {
        setIdeDraft((prev) => ({ ...prev, [kind]: picked }));
      }
    } catch {
      /* App may surface errors */
    }
  };

  const browseWorktreeRootDirectory = async () => {
    try {
      const picked = await onPickDirectory();
      if (picked) {
        setWorktreeRootDraft(picked);
      }
    } catch {
      /* App may surface errors */
    }
  };

  return (
    <div className="space-y-5">
      <Card className="app-surface-settings-hero overflow-hidden border p-0">
        <div className="border-b border-white/6 px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-4">
              <Button variant="ghost" size="sm" onClick={onBack} className="h-9 rounded-full px-3 text-zinc-300 hover:bg-white/5 hover:text-white">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </Button>
              <div className="space-y-2">
                <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-300/70">EasyCode Settings</p>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-3xl font-semibold tracking-tight text-zinc-50">Current version</h2>
                  <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">
                    v{APP_VERSION} • {APP_VERSION_DATE}
                  </span>
                </div>
                <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
                  Configure providers, shape your model registry, and tune how Easycode manages repositories, terminals, and local
                  developer workflows.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 xl:min-w-[34rem]">
              <SettingsHeroMetric
                icon={<Cpu className="h-4 w-4" />}
                label="Providers"
                value={String(providerAccounts.length)}
                hint={providerAccounts.length === 1 ? "1 provider configured" : "Connected provider accounts"}
              />
              <SettingsHeroMetric
                icon={<Database className="h-4 w-4" />}
                label="Models"
                value={String(models.length)}
                hint={models.length === 1 ? "1 registered model" : "Models available in Easycode"}
              />
              <SettingsHeroMetric
                icon={<Settings2 className="h-4 w-4" />}
                label="Focus"
                value={TAB_CONFIG.find((tab) => tab.id === activeTab)?.label ?? "Settings"}
                hint="Switch sections below"
              />
            </div>
          </div>
        </div>

        <div className="px-3 py-3 sm:px-4">
          <div className="flex flex-wrap gap-2">
            {TAB_CONFIG.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
                  activeTab === tab.id
                    ? "border-cyan-400/35 bg-cyan-400/12 text-cyan-200 shadow-[0_0_0_1px_rgba(34,211,238,0.14)]"
                    : "border-transparent bg-white/[0.03] text-zinc-400 hover:border-white/10 hover:bg-white/[0.05] hover:text-zinc-200"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {activeTab === "provider-models" ? (
        <ProviderModelsSettingsTab
          busy={busy}
          providerLabel={providerLabel}
          providerType={providerType}
          providerFamily={providerFamily}
          apiKey={apiKey}
          codexBinaryPath={codexBinaryPath}
          codexHomePath={codexHomePath}
          detectedCodexBinaryPath={detectedCodexBinaryPath}
          claudeBinaryPath={claudeBinaryPath}
          claudeLaunchArgs={claudeLaunchArgs}
          detectedClaudeBinaryPath={detectedClaudeBinaryPath}
          providerBaseUrl={providerBaseUrl}
          providerConfigJson={providerConfigJson}
          providerAzureApiVersion={providerAzureApiVersion}
          selectedProviderId={selectedProviderId}
          modelId={modelId}
          modelDisplayName={modelDisplayName}
          modelBaseUrl={modelBaseUrl}
          providerAccounts={providerAccounts}
          models={models}
          showOpenAiModelPresets={showModelPresets}
          openAiPresetSelectValue={openAiPresetSelectValue}
          openAiPresetsGrouped={openAiPresetsGrouped}
          modelPresetsForSelected={modelPresetsForSelected}
          onSubmitProvider={onSubmitProvider}
          onSubmitModel={onSubmitModel}
          onDeleteProviderAccount={onDeleteProviderAccount}
          onDeleteModel={onDeleteModel}
          onProviderLabelChange={onProviderLabelChange}
          onProviderTypeChange={onProviderTypeChange}
          onProviderFamilyChange={onProviderFamilyChange}
          onApiKeyChange={onApiKeyChange}
          onCodexBinaryPathChange={onCodexBinaryPathChange}
          onCodexHomePathChange={onCodexHomePathChange}
          onClaudeBinaryPathChange={onClaudeBinaryPathChange}
          onClaudeLaunchArgsChange={onClaudeLaunchArgsChange}
          onProviderBaseUrlChange={onProviderBaseUrlChange}
          onProviderConfigJsonChange={onProviderConfigJsonChange}
          onProviderAzureApiVersionChange={onProviderAzureApiVersionChange}
          onSelectedProviderIdChange={onSelectedProviderIdChange}
          onModelIdChange={onModelIdChange}
          onModelDisplayNameChange={onModelDisplayNameChange}
          onModelBaseUrlChange={onModelBaseUrlChange}
          onSetOpenAiPresetUserChoseCustom={setOpenAiPresetUserChoseCustom}
        />
      ) : null}

      {activeTab === "git-workspace" ? (
        <GitWorkspaceSettingsTab
          busy={busy}
          projects={projects}
          projectName={projectName}
          projectPath={projectPath}
          autoCheckoutRunBranchOnOpen={autoCheckoutRunBranchOnOpen}
          autoReleaseRunBranchOnLeave={autoReleaseRunBranchOnLeave}
          worktreeRootDraft={worktreeRootDraft}
          worktreeRootOverrideSettingValue={worktreeRootOverrideSettingValue}
          worktreeRootDirty={worktreeRootDirty}
          worktreeRootSaving={worktreeRootSaving}
          builtInShellAllowlistPatterns={builtInShellAllowlistPatterns}
          userShellPatternsDraft={userShellPatternsDraft}
          shellAllowlistDirty={shellAllowlistDirty}
          shellAllowlistSaving={shellAllowlistSaving}
          onChooseDirectory={onChooseDirectory}
          onBrowseWorktreeRootDirectory={browseWorktreeRootDirectory}
          onSubmitProject={onSubmitProject}
          onDeleteProject={onDeleteProject}
          onAutoCheckoutRunBranchOnOpenChange={onAutoCheckoutRunBranchOnOpenChange}
          onAutoReleaseRunBranchOnLeaveChange={onAutoReleaseRunBranchOnLeaveChange}
          onProjectNameChange={onProjectNameChange}
          onProjectPathChange={onProjectPathChange}
          onWorktreeRootDraftChange={setWorktreeRootDraft}
          onSaveWorktreeRootOverride={async () => {
            setWorktreeRootSaving(true);
            try {
              await onSaveWorktreeRootOverride(worktreeRootDraft);
            } finally {
              setWorktreeRootSaving(false);
            }
          }}
          onResetWorktreeRootDraft={() => setWorktreeRootDraft(worktreeRootOverrideSettingValue)}
          onUseDefaultWorktreeRoot={() => setWorktreeRootDraft("")}
          onUserShellPatternsDraftChange={setUserShellPatternsDraft}
          onShellAllowlistExtraSave={async () => {
            setShellAllowlistSaving(true);
            try {
              await onShellAllowlistExtraSave(userShellPatternsDraft.join("\n"));
            } finally {
              setShellAllowlistSaving(false);
            }
          }}
          onResetShellAllowlistDraft={() => setUserShellPatternsDraft([...savedUserShellLines])}
        />
      ) : null}

      {activeTab === "user" ? (
        <UserSettingsTab
          busy={busy}
          uiTheme={uiTheme}
          enableDevMode={enableDevMode}
          appLogDirPath={appLogDirPath}
          ideDraft={ideDraft}
          idePathsDirty={idePathsDirty}
          idePathsSaving={idePathsSaving}
          keyboardShortcuts={keyboardShortcuts}
          onUiThemeChange={onUiThemeChange}
          onEnableDevModeChange={onEnableDevModeChange}
          onKeyboardShortcutChange={onKeyboardShortcutChange}
          onOpenAppLogDirectory={onOpenAppLogDirectory}
          onResetDatabase={onResetDatabase}
          onIdeDraftChange={setIdeDraft}
          onSaveIdePaths={async () => {
            setIdePathsSaving(true);
            try {
              await onSaveIdePaths(serializeIdePathConfig(ideDraft));
            } finally {
              setIdePathsSaving(false);
            }
          }}
          onResetIdeDraft={() => setIdeDraft(parseIdePathConfig(idePathsSettingValue))}
          onPickIdeExecutable={browseIdeExecutable}
        />
      ) : null}

      {activeTab === "skills" ? (
        <SkillsSettingsTab
          skills={integratedSkills}
          globallyDisabledSkillIds={globallyDisabledIntegratedSkillIds}
          onDisabledSkillIdsChange={onGloballyDisabledIntegratedSkillIdsChange}
        />
      ) : null}

      {activeTab === "network" ? (
        <NetworkSettingsTab
          draft={networkProxyDraft}
          dirty={networkProxyDirty}
          saving={networkProxySaving}
          onDraftChange={setNetworkProxyDraft}
          onSave={async () => {
            setNetworkProxySaving(true);
            try {
              const saved = await onSaveNetworkProxySettings({
                enabled: networkProxyDraft.enabled,
                protocol: networkProxyDraft.protocol,
                host: networkProxyDraft.host,
                port: networkProxyDraft.port,
                username: networkProxyDraft.username,
                ...(networkProxyDraft.password ? { password: networkProxyDraft.password } : {}),
                clearSavedPassword: networkProxyDraft.clearSavedPassword,
              });
              setNetworkProxyDraft({
                ...saved,
                password: "",
                clearSavedPassword: false,
              });
            } finally {
              setNetworkProxySaving(false);
            }
          }}
          onReset={() =>
            setNetworkProxyDraft({
              ...networkProxySettings,
              password: "",
              clearSavedPassword: false,
            })
          }
        />
      ) : null}

      <footer className="mt-8 overflow-x-auto border-t border-zinc-800/90 pt-4 pb-1 text-center text-[11px] text-zinc-500">
        <p className="whitespace-nowrap text-zinc-400">
          <span className="font-medium text-zinc-400">
            Easycode <span className="tabular-nums">v{APP_VERSION}</span>
            {APP_VERSION_DATE && APP_VERSION_DATE !== "—" ? (
              <>
                {" "}
                · <span className="tabular-nums">{APP_VERSION_DATE}</span>
              </>
            ) : null}
          </span>
          <span className="text-zinc-600"> · </span>
          <span className="text-zinc-500">invetalcom</span>
          <span className="text-zinc-600"> · </span>
          <a
            href="mailto:ai-support@r-kellner.de"
            className="text-cyan-500/85 underline decoration-cyan-500/30 underline-offset-2 transition hover:text-cyan-400"
          >
            ai-support@r-kellner.de
          </a>
        </p>
      </footer>
    </div>
  );
};
