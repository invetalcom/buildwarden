import { useEffect, useState } from "react";
import type {
  AppLogDirectorySizeInfo,
  AppSnapshot,
  IntegratedSkillMetadata,
  NetworkProxySettingsInput,
  NetworkProxySettingsSnapshot,
  ProviderType,
  SupportedIdeKind,
  UiTheme,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  DEFAULT_RECENT_RUN_DAYS,
  MAX_RECENT_RUN_DAYS,
  MIN_RECENT_RUN_DAYS,
  parseRecentRunDaysSetting,
  parseIdePathConfig,
  serializeIdePathConfig,
  type KeyboardShortcutId,
} from "@buildwarden/shared";
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
  recentRunDays: number;
  uiTheme: UiTheme;
  worktreeRootOverrideSettingValue: string;
  enableDevMode: boolean;
  appLogDirPath: string;
  appLogDirectorySize: AppLogDirectorySizeInfo;
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
  onRecentRunDaysChange: (value: number) => void | Promise<void>;
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
  integratedSkills: IntegratedSkillMetadata[];
  globallyDisabledIntegratedSkillIds: string[];
  onGloballyDisabledIntegratedSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
}

const TAB_CONFIG: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: "provider-models", label: "Provider & Models", icon: <Cpu className="h-4 w-4" /> },
  { id: "git-workspace", label: "Git & Workspace", icon: <FolderGit2 className="h-4 w-4" /> },
  { id: "skills", label: "Skills", icon: <Database className="h-4 w-4" /> },
  { id: "network", label: "Network", icon: <Globe className="h-4 w-4" /> },
  { id: "user", label: "User Settings", icon: <Settings2 className="h-4 w-4" /> },
];

const userShellLinesFromSavedText = (text: string): string[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean);

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
  recentRunDays,
  uiTheme,
  worktreeRootOverrideSettingValue,
  enableDevMode,
  appLogDirPath,
  appLogDirectorySize,
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
  onRecentRunDaysChange,
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
  const [activeTab, setActiveTab] = useState<SettingsTab>("user");
  const [openAiPresetUserChoseCustom, setOpenAiPresetUserChoseCustom] = useState(false);
  const [userShellPatternsDraft, setUserShellPatternsDraft] = useState(() => userShellLinesFromSavedText(shellAllowlistExtraText));
  const [shellAllowlistSaving, setShellAllowlistSaving] = useState(false);
  const [ideDraft, setIdeDraft] = useState(() => parseIdePathConfig(idePathsSettingValue));
  const [idePathsSaving, setIdePathsSaving] = useState(false);
  const [worktreeRootDraft, setWorktreeRootDraft] = useState(worktreeRootOverrideSettingValue);
  const [worktreeRootSaving, setWorktreeRootSaving] = useState(false);
  const [recentRunDaysDraft, setRecentRunDaysDraft] = useState(() => String(recentRunDays));
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
    setRecentRunDaysDraft(String(recentRunDays));
  }, [recentRunDays]);

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
  const recentRunDaysDraftNumber = Number(recentRunDaysDraft);
  const recentRunDaysInvalid =
    !recentRunDaysDraft.trim() ||
    !Number.isFinite(recentRunDaysDraftNumber) ||
    !Number.isInteger(recentRunDaysDraftNumber) ||
    recentRunDaysDraftNumber < MIN_RECENT_RUN_DAYS ||
    recentRunDaysDraftNumber > MAX_RECENT_RUN_DAYS;
  const normalizedRecentRunDaysDraft = recentRunDaysInvalid ? recentRunDays : parseRecentRunDaysSetting(recentRunDaysDraftNumber);
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

  useEffect(() => {
    if (recentRunDaysInvalid || normalizedRecentRunDaysDraft === recentRunDays) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void onRecentRunDaysChange(normalizedRecentRunDaysDraft);
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [normalizedRecentRunDaysDraft, onRecentRunDaysChange, recentRunDays, recentRunDaysInvalid]);

  return (
    <div className="flex min-h-[calc(100vh-5.25rem)] overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]">
      <aside className="w-64 shrink-0 border-r border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 h-8 px-2 text-xs">
          <ArrowLeft data-icon="inline-start" />
          Back
        </Button>
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--ec-accent)]">Workspace</p>
        <h2 className="mt-1 text-xl font-semibold text-[var(--ec-text)]">Settings</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--ec-muted)]">Global app behavior, providers, models, network, and user preferences.</p>
        <div className="mt-5 flex flex-col gap-1">
          {TAB_CONFIG.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition ${
                activeTab === tab.id
                  ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                  : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
              }`}
            >
              <span className={activeTab === tab.id ? "text-[var(--ec-accent)]" : "text-[var(--ec-faint)]"}>{tab.icon}</span>
              <span className="min-w-0 truncate">{tab.label}</span>
            </button>
          ))}
        </div>
      </aside>

      <div className="app-scrollbar min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <header className="mb-5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-4">
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--ec-text)]">{TAB_CONFIG.find((tab) => tab.id === activeTab)?.label ?? "Settings"}</h1>
          <p className="mt-1 text-sm text-[var(--ec-muted)]">
            Configure providers, model registry, workspace behavior, skills, network access, and user preferences.
          </p>
          <p className="mt-2 font-mono text-[11px] text-[var(--ec-faint)]">
            BuildWarden v{APP_VERSION} - {APP_VERSION_DATE}
          </p>
        </header>
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
          recentRunDaysDraft={recentRunDaysDraft}
          recentRunDaysInvalid={recentRunDaysInvalid}
          recentRunDaysMin={MIN_RECENT_RUN_DAYS}
          recentRunDaysMax={MAX_RECENT_RUN_DAYS}
          recentRunDaysDefault={DEFAULT_RECENT_RUN_DAYS}
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
          onRecentRunDaysDraftChange={setRecentRunDaysDraft}
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
          appLogDirectorySize={appLogDirectorySize}
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

      <footer className="mt-8 overflow-x-auto border-t border-[var(--ec-border)] pt-4 pb-1 text-center text-[11px] text-[var(--ec-muted)]">
        <p className="whitespace-nowrap">
          <span className="font-medium text-[var(--ec-muted)]">
            BuildWarden <span className="tabular-nums">v{APP_VERSION}</span>
            {APP_VERSION_DATE && APP_VERSION_DATE !== "—" ? (
              <>
                {" "}
                - <span className="tabular-nums">{APP_VERSION_DATE}</span>
              </>
            ) : null}
          </span>
          <span className="text-[var(--ec-faint)]"> - </span>
          <span>invetalcom</span>
          <span className="text-[var(--ec-faint)]"> - </span>
          <a
            href="mailto:ai-support@r-kellner.de"
            className="text-[var(--ec-accent)] underline decoration-[var(--ec-accent-ring)] underline-offset-2 transition hover:text-[var(--ec-accent-strong)]"
          >
            ai-support@r-kellner.de
          </a>
        </p>
      </footer>
      </div>
    </div>
  );
};
