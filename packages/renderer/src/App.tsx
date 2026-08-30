import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import {
  APP_SETTING_KEYS,
  getDefaultDesignScheme,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  buildDefaultProjectLabSettings,
  isDetachedHeadProjectErrorMessage,
  getAiSdkProviderFamilyFromConfigJson,
  DEFAULT_ADD_MODEL_DRAFT,
  DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES,
  parseConsecutiveToolCallCollapseThresholdSetting,
  parseDataRetentionCleanupDaysSetting,
  parsePastedTextAttachmentThresholdSetting,
  parseRecentRunDaysSetting,
  parseRemoteAccessEnabledSetting,
  parseRunTimelineDensitySetting,
  parseSidebarContrastStrengthSetting,
  parseSidebarGroupRunsByProjectSetting,
  parseSidebarRunEntrySizeSetting,
  parseDesignScheme,
  serializeDesignScheme,
  SUPPORTED_IDE_KINDS,
  parseIdePathConfig,
  parseOrchestrationTeamSettings,
  parseShellAllowlistExtraSetting,
  type AppMenuSection,
  type AppSnapshot,
  type AppWarning,
  type AutomationStartedNotificationPayload,
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatRecord,
  type DesignScheme,
  type KeyboardShortcutId,
  type ModelDeletionImpact,
  type NetworkProxySettingsSnapshot,
  type ProjectFolderGitStatus,
  type ProjectForgeRequestOpenPayload,
  type ProjectLoopAvailability,
  type ProjectMcpServerConfig,
  type ProjectSnapshot,
  type ProjectTaskInput,
  type UpdateProjectTaskInput,
  type ProjectInsightKind,
  type ProviderExecutionOptions,
  type FollowUpChatOptions,
  type ProviderType,
  type RunDetail,
  type RunDeletionImpact,
  type RunMode,
  type RunModelConfiguration,
  type RunRecord,
  type RunTokenUsage,
  type RunTimelineDensity,
  type SidebarRunEntrySize,
  type RunWorkspacePanelId,
  type RunWorkspaceType,
  type ShellApprovalDecision,
  type SupportedIdeKind,
  type UnifiedProviderFamily,
  uiThemeToLegacyDarkMode,
} from "@buildwarden/shared";
import { applyDesignSchemeToDocument } from "./lib/design-scheme";
import {
  Globe,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquareText,
  MessagesSquare,
  SquareTerminal,
  StickyNote,
  UsersRound,
} from "lucide-react";
const AllRunsPage = lazy(() => import("./components/app/AllRunsPage").then((m) => ({ default: m.AllRunsPage })));
const BookmarkDetailPage = lazy(() => import("./components/app/BookmarkDetailPage").then((m) => ({ default: m.BookmarkDetailPage })));
import { AppTitleBar } from "./components/app/AppTitleBar";
const BookmarksPage = lazy(() => import("./components/app/BookmarksPage").then((m) => ({ default: m.BookmarksPage })));
import { type BookmarkItem } from "./components/app/BookmarksPage";
const ChatBookmarkDetailPage = lazy(() => import("./components/app/ChatBookmarkDetailPage").then((m) => ({ default: m.ChatBookmarkDetailPage })));
// Heavy detail surfaces are code-split so the startup chunk stays small; they
// load on first navigation and stay cached afterwards.
const ChatDetailPage = lazy(() => import("./components/app/ChatDetailPage").then((m) => ({ default: m.ChatDetailPage })));
const ChatPage = lazy(() => import("./components/app/ChatPage").then((m) => ({ default: m.ChatPage })));
import { CommandPalette, type CommandPaletteItem } from "./components/app/CommandPalette";
import { LandingPage } from "./components/app/LandingPage";
import { pickRandomLandingJoke } from "./components/app/landing-page-jokes";
const ProjectPage = lazy(() => import("./components/app/ProjectPage").then((m) => ({ default: m.ProjectPage })));
import { type ProjectPageTab } from "./components/app/project-page-tabs";
import {
  DEFAULT_RUN_BROWSER_SESSION,
  EMPTY_APP_LOG_DIRECTORY_SIZE,
  EMPTY_SNAPSHOT,
  RUN_DRAG_MIME_TYPE,
  RUN_PANE_IDS,
  buildModelExecutionProfile,
  buildRunReasoningInput,
  cloneDefaultRunWorkspaceLayoutPreference,
  findProjectRun,
  firstOpenRunId,
  getOpenRunPaneEntries,
  harnessTypeForProvider,
  isRunContinuable,
  latestRunTokenUsage,
  paneForOpenRunId,
  parseKeyboardShortcuts,
  parseRunDragPayload,
  readRunTokenUsage,
  removeRunIdsFromOpenPanes,
  resolveRunModelConfiguration,
  resolveProviderComposerPrompt,
  runIdIsOpenInPanes,
  snapshotContainsRunId,
  type ConfirmDialogState,
  type OpenRunPanes,
  type RunBrowserSessionState,
  type RunDragPayload,
  type RunPaneId,
} from "./components/app/app-model";
import { buildRunDeletionPlan } from "./components/app/run-deletion-plan";
import { StartupDataRetentionDialog, type StartupDataRetentionState } from "./components/app/StartupDataRetentionDialog";
import { StartupAutomationDialog, type StartupAutomationState } from "./components/app/StartupAutomationDialog";
import {
  AppNotifications,
  type ProjectForgeRequestToast,
  type ShellApprovalRequestState,
} from "./components/app/AppNotifications";
import { createAppKeyboardShortcutHandler } from "./components/app/app-keyboard-shortcuts";
import {
  computeMainViewFlags,
  normalizeProjectFeatureTab,
  reconcileSettingsPreviousPageAfterModelDeletion,
  type SettingsPreviousPageState,
} from "./components/app/app-navigation";
import { buildCommandPaletteItems } from "./components/app/command-palette-items";
import { useRunActionDialogs } from "./components/app/use-run-action-dialogs";
import { useProjectBranches } from "./components/app/use-project-branches";
import { useRunWorkspaceLayouts } from "./components/app/use-run-workspace-layouts";
import {
  isRunWorkspacePanelAvailable,
  resolveRunWorkspacePanelVisibility,
} from "./components/app/run-workspace-layout";
import { useShellApprovalQueue } from "./components/app/use-shell-approval-queue";
import { useSkillsSettings } from "./components/app/use-skills-settings";
import {
  applyLiveChatEventToDetail,
  applyLiveChatToSnapshot,
  applyLiveRunEventToDetail,
  applyLiveRunToSnapshot,
  mergeOrderedRecords,
} from "./lib/live-state";
import { useWelcomeFlow } from "./components/app/use-welcome-flow";
import { buildProviderAccountConfig } from "./lib/provider-account-config";
import { RunActionDialogs } from "./components/app/RunActionDialogs";
import { RunDetailHeader, RunPaneDropPreviewOverlay, type RunPanelToggleItem } from "./components/app/RunDetailHeader";
const RunDetailPage = lazy(() => import("./components/app/RunDetailPage").then((m) => ({ default: m.RunDetailPage })));
const SettingsPage = lazy(() => import("./components/app/SettingsPage").then((m) => ({ default: m.SettingsPage })));
import { Sidebar } from "./components/app/Sidebar";
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth, parseSidebarWidthSetting } from "./components/app/sidebar-width";
import { WelcomeDialog } from "./components/app/WelcomeDialog";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { cn } from "./lib/cn";
import {
  emptyModelPresetsByGroup,
  getModelPresetsByGroupForProvider,
  getModelPresetsForProvider,
} from "./lib/openai-model-presets";
import { useAvailableProviderModels } from "./lib/use-available-provider-models";
import { useProjectRunDefaults } from "./lib/use-project-run-defaults";
import { useRendererErrorReporting } from "./lib/use-renderer-error-reporting";
import { useStableCallback } from "./lib/use-stable-callback";
import { reportRendererError, reportRendererLog } from "./lib/report-renderer-error";
import { useBuildWardenClient } from "./lib/buildwarden-client";
import { PastedTextAttachmentThresholdProvider } from "./lib/pasted-text-attachment-settings";
import { RunToolCallCollapseThresholdProvider } from "./lib/run-tool-call-collapse-settings";

const isLocalProviderType = (type: ProviderType): boolean =>
  type === "codex-cli" || type === "claude-code" || type === "cursor-agent";

const panelVisibilitySubtitle = (visible: boolean, hiddenSubtitle: string): string =>
  visible ? "Visible" : hiddenSubtitle;

const computeProjectFolderGitWarning = (status: ProjectFolderGitStatus | null): string | null => {
  if (status?.exists === true && status.isDirectory && !status.isGitRepo) {
    return "The selected folder is not a Git repository. It will be added as a plain folder project; Git-only features like branches, commits, worktrees, and PR/MR tools will be unavailable.";
  }
  return null;
};

interface RunPanelToggleDefinition {
  key: RunWorkspacePanelId;
  label: string;
  icon: RunPanelToggleItem["icon"];
  hiddenSubtitle: string;
  requiresWorktree: boolean;
}

const RUN_PANEL_TOGGLE_DEFINITIONS: readonly RunPanelToggleDefinition[] = [
  { key: "activity", label: "Activity Log", icon: MessageSquareText, hiddenSubtitle: "Show agent activity", requiresWorktree: false },
  { key: "agents", label: "Agents", icon: UsersRound, hiddenSubtitle: "Show orchestrated tasks", requiresWorktree: false },
  { key: "diff", label: "Diff View", icon: GitBranch, hiddenSubtitle: "Show changes", requiresWorktree: true },
  { key: "terminal", label: "Terminal", icon: SquareTerminal, hiddenSubtitle: "Show terminal", requiresWorktree: true },
  { key: "browser", label: "Browser", icon: Globe, hiddenSubtitle: "Show in-app browser", requiresWorktree: false },
  { key: "notes", label: "Notes", icon: StickyNote, hiddenSubtitle: "Show run notes", requiresWorktree: false },
  { key: "chat", label: "Chat", icon: MessagesSquare, hiddenSubtitle: "Ask about this run", requiresWorktree: false },
  { key: "pull-request", label: "Pull Request", icon: GitPullRequest, hiddenSubtitle: "Show review status", requiresWorktree: false },
];

const addProjectForgeRequestToast = (
  current: ProjectForgeRequestToast[],
  toast: ProjectForgeRequestToast,
): ProjectForgeRequestToast[] => [toast, ...current.filter((existing) => existing.id !== toast.id)].slice(0, 4);

const addAutomationStartedToast = (
  current: AutomationStartedNotificationPayload[],
  toast: AutomationStartedNotificationPayload,
): AutomationStartedNotificationPayload[] => [toast, ...current.filter((existing) => existing.runId !== toast.runId)].slice(0, 4);

export const App = () => {
  const buildwarden = useBuildWardenClient();
  const readOnly = !buildwarden.capabilities.mutations;
  useRendererErrorReporting();
  const showCustomWindowsTitleBar = buildwarden.capabilities.nativeTitleBar
    && typeof navigator !== "undefined"
    && navigator.userAgent.includes("Windows");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [snapshotLoadedSuccessfully, setSnapshotLoadedSuccessfully] = useState(false);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [openRunPanes, setOpenRunPanes] = useState<OpenRunPanes>({});
  const [focusedRunPane, setFocusedRunPane] = useState<RunPaneId>("left");
  const [runDetailsById, setRunDetailsById] = useState<Record<string, RunDetail>>({});
  const [runPaneDropPreview, setRunPaneDropPreview] = useState<RunPaneId | null>(null);
  const [runLiveUsageById, setRunLiveUsageById] = useState<Record<string, Partial<RunTokenUsage>>>({});
  const [busy, setBusy] = useState(false);
  /** Runs whose deletion IPC is in flight (does not block the rest of the UI). */
  const [pendingDeleteRunIds, setPendingDeleteRunIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [appWarning, setAppWarning] = useState<AppWarning | null>(null);
  const [automationStartedToasts, setAutomationStartedToasts] = useState<AutomationStartedNotificationPayload[]>([]);
  const [projectForgeRequestToasts, setProjectForgeRequestToasts] = useState<ProjectForgeRequestToast[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectFolderGitStatus, setProjectFolderGitStatus] = useState<ProjectFolderGitStatus | null>(null);
  const [providerLabel, setProviderLabel] = useState("AI SDK");
  const [providerType, setProviderType] = useState<ProviderType>("ai-sdk");
  const [providerFamily, setProviderFamily] = useState<UnifiedProviderFamily>("openai");
  const [apiKey, setApiKey] = useState("");
  const [codexBinaryPath, setCodexBinaryPath] = useState("");
  const [codexHomePath, setCodexHomePath] = useState("");
  const [detectedCodexBinaryPath, setDetectedCodexBinaryPath] = useState<string | null>(null);
  const [claudeBinaryPath, setClaudeBinaryPath] = useState("");
  const [claudeLaunchArgs, setClaudeLaunchArgs] = useState("");
  const [detectedClaudeBinaryPath, setDetectedClaudeBinaryPath] = useState<string | null>(null);
  const [cursorBinaryPath, setCursorBinaryPath] = useState("");
  const [cursorApiEndpoint, setCursorApiEndpoint] = useState("");
  const [detectedCursorBinaryPath, setDetectedCursorBinaryPath] = useState<string | null>(null);
  const [detectedCursorMessage, setDetectedCursorMessage] = useState<string | null>(null);
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerConfigJson, setProviderConfigJson] = useState("{}");
  const [providerAzureApiVersion, setProviderAzureApiVersion] = useState("2024-06-01");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modelId, setModelId] = useState(() => DEFAULT_ADD_MODEL_DRAFT.modelId);
  const [modelDisplayName, setModelDisplayName] = useState(() => DEFAULT_ADD_MODEL_DRAFT.displayName);
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [welcomeOpenAiPresetUserChoseCustom, setWelcomeOpenAiPresetUserChoseCustom] = useState(false);
  const { availableModelsByProviderId, availableModelsByProviderIdRef, ensureAvailableModels } = useAvailableProviderModels({
    buildwarden,
  });
  const [runProjectId, setRunProjectId] = useState("");
  const [runModelId, setRunModelId] = useState("");
  const [runWorktreeModelIds, setRunWorktreeModelIds] = useState<string[]>([]);
  const [runModelConfigurations, setRunModelConfigurations] = useState<Record<string, RunModelConfiguration>>({});
  const [runMode, setRunMode] = useState<RunMode>("code");
  const [runWorkspaceType, setRunWorkspaceType] = useState<RunWorkspaceType>("worktree");
  const [runPrompt, setRunPrompt] = useState("");
  const [runReasoningEffort, setRunReasoningEffort] = useState("auto");
  const [runAnthropicEffort, setRunAnthropicEffort] = useState("auto");
  const [runExecutionMode, setRunExecutionMode] = useState("auto");
  const [runYoloMode, setRunYoloMode] = useState(false);
  const [runVerificationCommands, setRunVerificationCommands] = useState<string[]>([]);
  const [runMaxMinutes, setRunMaxMinutes] = useState(0);
  const [runMaxTokens, setRunMaxTokens] = useState(0);
  const [runMcpServers, setRunMcpServers] = useState<ProjectMcpServerConfig[]>([]);
  const [runDelegationEnabled, setRunDelegationEnabled] = useState(false);
  const [chatReasoningEffort, setChatReasoningEffort] = useState("auto");
  const [chatAnthropicEffort, setChatAnthropicEffort] = useState("auto");
  const [chatExecutionMode, setChatExecutionMode] = useState("auto");
  const [selectedRunId, setSelectedRunId] = useState<string | null | undefined>(undefined);
  const selectedRunIdRef = useRef<string | null | undefined>(undefined);
  selectedRunIdRef.current = selectedRunId;
  const openRunPanesRef = useRef<OpenRunPanes>({});
  openRunPanesRef.current = openRunPanes;
  const runDetailsByIdRef = useRef<Record<string, RunDetail>>({});
  runDetailsByIdRef.current = runDetailsById;
  const diffRefreshTimersRef = useRef<Partial<Record<string, ReturnType<typeof setTimeout>>>>({});
  const runDetailLoadTokenRef = useRef<Record<string, number>>({});
  const diffLoadPromisesRef = useRef<Partial<Record<string, Promise<void>>>>({});
  const diffLoadGenerationRef = useRef<Record<string, number>>({});
  const diffSummaryLoadGenerationRef = useRef<Record<string, number>>({});
  const [landingSelected, setLandingSelected] = useState(true);
  const [allRunsSelected, setAllRunsSelected] = useState(false);
  const [bookmarksSelected, setBookmarksSelected] = useState(false);
  const [chatsSelected, setChatsSelected] = useState(false);
  const [selectedBookmark, setSelectedBookmark] = useState<BookmarkItem | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatRecord | null>(null);
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [projectPageTab, setProjectPageTab] = useState<ProjectPageTab>("overview");
  const [loopAvailabilityByProjectId, setLoopAvailabilityByProjectId] = useState<Record<string, ProjectLoopAvailability>>({});
  const dismissedGitConversionProjectIdsRef = useRef<Set<string>>(new Set());
  const gitConversionCheckInFlightRef = useRef<Set<string>>(new Set());
  const [reviewRequestTarget, setReviewRequestTarget] = useState<{
    projectId: string;
    url: string;
    requestId: number;
  } | null>(null);
  const [settingsPreviousPage, setSettingsPreviousPage] = useState<SettingsPreviousPageState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => buildwarden.capabilities.platform === "web" && window.innerWidth < 900,
  );
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [landingPageJoke] = useState(() => pickRandomLandingJoke());
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [startupDataRetentionState, setStartupDataRetentionState] = useState<StartupDataRetentionState>(
    () => buildwarden.capabilities.platform === "electron" ? { status: "checking" } : { status: "ready" },
  );
  const startupDataRetentionCheckStartedRef = useRef(false);
  const [startupAutomationState, setStartupAutomationState] = useState<StartupAutomationState>(
    () => buildwarden.capabilities.platform === "electron" ? { status: "checking" } : { status: "ready" },
  );
  const startupAutomationCheckStartedRef = useRef(false);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [runPanelsMenuOpen, setRunPanelsMenuOpen] = useState(false);
  const [runDensityMenuOpen, setRunDensityMenuOpen] = useState(false);
  const [subagentFocusRequest, setSubagentFocusRequest] = useState<{ runId: string; subagentId: string; nonce: number } | null>(null);
  const publishMenuAnchorRef = useRef<HTMLDivElement>(null);
  const runPanelsMenuAnchorRef = useRef<HTMLDivElement>(null);
  const runDensityMenuAnchorRef = useRef<HTMLDivElement>(null);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [runBrowserSessions, setRunBrowserSessions] = useState<Record<string, RunBrowserSessionState>>({});
  const [runTerminalOpenLinksInApp, setRunTerminalOpenLinksInApp] = useState<Record<string, boolean>>({});
  const {
    removeRunWorkspaceLayoutsForRuns,
    runWorkspaceLayoutsByRunId,
    selectedRunWorkspaceLayout,
    runWorkspaceSecondaryPosition,
    runWorkspaceShowActivity,
    runWorkspaceShowAgents,
    runWorkspaceShowBrowser,
    runWorkspaceShowChat,
    runWorkspaceShowDiff,
    runWorkspaceShowNotes,
    runWorkspaceShowTerminal,
    runWorkspaceShowPullRequest,
    setRunWorkspaceSecondaryPosition,
    setRunWorkspaceShowActivity,
    setRunWorkspaceShowAgents,
    setRunWorkspaceShowBrowser,
    setRunWorkspaceShowChat,
    setRunWorkspaceShowDiff,
    setRunWorkspaceShowNotes,
    setRunWorkspaceShowTerminal,
    setRunWorkspaceShowPullRequest,
    updateRunWorkspaceLayout,
  } = useRunWorkspaceLayouts({
    buildwarden,
    selectedRunId,
    settings: snapshot.settings,
    setError,
  });
  const [appLogDirPath, setAppLogDirPath] = useState("");
  const [appLogDirectorySize, setAppLogDirectorySize] = useState(EMPTY_APP_LOG_DIRECTORY_SIZE);
  const [networkProxySettings, setNetworkProxySettings] = useState<NetworkProxySettingsSnapshot>({
    ...DEFAULT_NETWORK_PROXY_SETTINGS,
    hasPassword: false,
  });
  const projectFolderGitWarning = computeProjectFolderGitWarning(projectFolderGitStatus);
  const preferredRunModelId = snapshot.settings[APP_SETTING_KEYS.lastUsedRunModelId] ?? "";
  const persistedSidebarWidthSetting = snapshot.settings[APP_SETTING_KEYS.sidebarWidth];
  const orchestrationTeam = useMemo(
    () => parseOrchestrationTeamSettings(snapshot.settings[APP_SETTING_KEYS.orchestrationTeam]),
    [snapshot.settings],
  );
  const delegationAvailable = orchestrationTeam.roles.length > 0;

  useEffect(() => {
    setRunDelegationEnabled(delegationAvailable);
  }, [delegationAvailable]);
  const {
    welcomeOpen,
    welcomeStepIndex,
    welcomeStepKey,
    welcomeStepKeys,
    welcomeKnownCompletedCheckIds,
    welcomeSkippedCheckIds,
    welcomeProviderModelsOpenPanel,
    setWelcomeProviderModelsOpenPanel,
    handleWelcomeNext,
    handleWelcomeBack,
    handleWelcomeSkipCheck,
    handleWelcomeFinish,
  } = useWelcomeFlow({ buildwarden, snapshot, snapshotLoaded, disabled: !buildwarden.capabilities.settings });
  const shouldCheckProjectFolderGitStatus = settingsOpen || (welcomeOpen && welcomeStepKey === "project");
  const selectedProviderAccount = snapshot.providerAccounts.find((provider) => provider.id === selectedProviderId) ?? null;
  const openAiPresetsGroupedForSelectedProvider = useMemo(() => {
    if (!selectedProviderAccount) {
      return emptyModelPresetsByGroup();
    }
    const family =
      selectedProviderAccount.providerType === "ai-sdk"
        ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
        : undefined;
    return getModelPresetsByGroupForProvider(selectedProviderAccount.providerType, family);
  }, [selectedProviderAccount]);
  const loadSnapshot = useCallback(async () => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable. Restart the app with `pnpm dev`.");
      setSnapshotLoaded(true);
      return;
    }

    const next = await buildwarden.refreshSnapshot();
    setSnapshot(next);
    setSnapshotLoaded(true);
    setSnapshotLoadedSuccessfully(true);
    setRunProjectId((current) =>
      current && next.projects.some((entry) => entry.project.id === current)
        ? current
        : next.selectedProjectId || next.projects[0]?.project.id || "",
    );
    setSelectedProviderId((current) =>
      current && next.providerAccounts.some((entry) => entry.id === current)
        ? current
        : next.providerAccounts[0]?.id || "",
    );
    setRunModelId((current) => {
      if (current && next.models.some((entry) => entry.id === current)) {
        return current;
      }
      const preferred = next.settings[APP_SETTING_KEYS.lastUsedRunModelId];
      if (preferred && next.models.some((entry) => entry.id === preferred)) {
        return preferred;
      }
      return next.models[0]?.id || "";
    });
    setSelectedRunId((current) => {
      if (current === null) {
        return null;
      }
      if (current && snapshotContainsRunId(next.projects, current)) {
        return current;
      }
      return next.selectedRunId || next.projects[0]?.recentRuns[0]?.id || null;
    });
  }, [buildwarden]);

  const checkStartupDataRetention = useCallback(async () => {
    if (buildwarden.capabilities.platform !== "electron" || snapshot.settings[APP_SETTING_KEYS.dataRetentionCleanupEnabled] !== "true") {
      setStartupDataRetentionState({ status: "ready" });
      return;
    }
    const dayCount = parseDataRetentionCleanupDaysSetting(snapshot.settings[APP_SETTING_KEYS.dataRetentionCleanupDays]);
    setStartupDataRetentionState({ status: "checking" });
    try {
      const impact = await buildwarden.getDataRetentionCleanupImpact(dayCount);
      const totalCount = impact.runCount + impact.chatCount + impact.projectLabThreadCount + impact.projectLoopCount;
      setStartupDataRetentionState(totalCount > 0 ? { status: "review", impact } : { status: "ready" });
    } catch (caught) {
      setStartupDataRetentionState({
        status: "error",
        phase: "checking",
        message: caught instanceof Error ? caught.message : "Could not inspect old saved data.",
      });
    }
  }, [buildwarden, snapshot.settings]);

  const checkStartupAutomations = useCallback(async () => {
    if (buildwarden.capabilities.platform !== "electron") {
      setStartupAutomationState({ status: "ready" });
      return;
    }
    setStartupAutomationState({ status: "checking" });
    try {
      const result = await buildwarden.getStartupAutomationCatchUp();
      const items = Array.isArray(result) ? result : [];
      if (items.length === 0) {
        await buildwarden.resolveStartupAutomationCatchUp([]);
        setStartupAutomationState({ status: "ready" });
      } else {
        setStartupAutomationState({ status: "review", items });
      }
    } catch (caught) {
      setStartupAutomationState({ status: "error", message: caught instanceof Error ? caught.message : "Could not inspect missed automations." });
    }
  }, [buildwarden]);

  const loadAppPaths = useCallback(async () => {
    if (!buildwarden) {
      return;
    }

    try {
      const paths = await buildwarden.getAppPaths();
      setAppLogDirPath(paths.logDirPath);
      setAppLogDirectorySize(paths.logDirectorySize);
    } catch {
      setAppLogDirPath("");
      setAppLogDirectorySize(EMPTY_APP_LOG_DIRECTORY_SIZE);
    }
  }, [buildwarden]);

  /**
   * Streaming runs emit bursts of events; refreshing the full snapshot for each
   * one wastes IPC and re-renders. Coalesce to at most one refresh per 300ms.
   */
  const snapshotRefreshTimerRef = useRef<number | null>(null);
  const scheduleSnapshotRefresh = useCallback(() => {
    if (snapshotRefreshTimerRef.current !== null) {
      return;
    }
    snapshotRefreshTimerRef.current = window.setTimeout(() => {
      snapshotRefreshTimerRef.current = null;
      void loadSnapshot();
    }, 300);
  }, [loadSnapshot]);

  useEffect(
    () => () => {
      if (snapshotRefreshTimerRef.current !== null) {
        window.clearTimeout(snapshotRefreshTimerRef.current);
        snapshotRefreshTimerRef.current = null;
      }
    },
    [],
  );

  /**
   * Loop availability (Git remote + saved forge token + local-provider models) gates the
   * Loops entry in the sidebar. Keyed on project ids and the active tab so it refreshes
   * after e.g. saving a hosting token in PR Review, without re-running on every
   * streaming snapshot refresh.
   */
  const snapshotProjectsRef = useRef(snapshot.projects);
  snapshotProjectsRef.current = snapshot.projects;
  const loopAvailabilityProjectsKey = useMemo(
    () => snapshot.projects.map((entry) => `${entry.project.id}:${entry.project.kind}`).join("|"),
    [snapshot.projects],
  );
  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    let disposed = false;
    void (async () => {
      const next: Record<string, ProjectLoopAvailability> = {};
      for (const entry of snapshotProjectsRef.current) {
        if (entry.project.kind !== "git") {
          continue;
        }
        try {
          next[entry.project.id] = await buildwarden.getProjectLoopAvailability(entry.project.id);
        } catch {
          /* project without resolvable remote: leave it unavailable */
        }
      }
      if (!disposed) {
        setLoopAvailabilityByProjectId(next);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [buildwarden, loopAvailabilityProjectsKey, projectPageTab]);

  const loopEnabledProjectIds = useMemo(
    () =>
      new Set(
        Object.entries(loopAvailabilityByProjectId)
          .filter(([, availability]) => availability.hasToken)
          .map(([projectId]) => projectId),
      ),
    [loopAvailabilityByProjectId],
  );

  useEffect(() => {
    const nextWidth = parseSidebarWidthSetting(persistedSidebarWidthSetting);
    if (nextWidth == null) {
      return;
    }
    setSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [persistedSidebarWidthSetting]);

  useEffect(() => {
    setWelcomeOpenAiPresetUserChoseCustom(false);
  }, [selectedProviderId]);

  useEffect(() => {
    if (!selectedProviderAccount) return;
    const family =
      selectedProviderAccount.providerType === "ai-sdk"
        ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
        : undefined;
    const list = getModelPresetsForProvider(selectedProviderAccount.providerType, family);
    if (list.length === 0) return;
    const stillValid = list.some(
      (preset) => preset.modelId === modelId.trim() && preset.displayName === modelDisplayName.trim(),
    );
    if (!stillValid) {
      const first = list[0]!;
      setModelId(first.modelId);
      setModelDisplayName(first.displayName);
    }
    // intentionally omit modelId / modelDisplayName: revalidate only when the selected connection changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProviderId, selectedProviderAccount?.id, selectedProviderAccount?.configJson, selectedProviderAccount?.providerType]);

  const loadDetectedCodexInstallation = useCallback(async () => {
    if (!buildwarden) {
      return;
    }
    const detected = await buildwarden.getDetectedCodexInstallation();
    setDetectedCodexBinaryPath(detected.binaryPath);
  }, [buildwarden]);

  const loadDetectedClaudeInstallation = useCallback(async () => {
    if (!buildwarden) {
      return;
    }
    const detected = await buildwarden.getDetectedClaudeInstallation();
    setDetectedClaudeBinaryPath(detected.binaryPath);
  }, [buildwarden]);

  const loadDetectedCursorInstallation = useCallback(async () => {
    if (!buildwarden) {
      return;
    }
    const detected = await buildwarden.getDetectedCursorInstallation();
    setDetectedCursorBinaryPath(detected.binaryPath);
    setDetectedCursorMessage(detected.message ?? null);
  }, [buildwarden]);

  const loadNetworkProxySettings = useCallback(async () => {
    if (!buildwarden) {
      return;
    }
    const next = await buildwarden.getNetworkProxySettings();
    setNetworkProxySettings(next);
  }, [buildwarden]);

  useEffect(() => {
    const validSet = new Set(snapshot.models.map((m) => m.id));
    setRunWorktreeModelIds((prev) => {
      if (runWorkspaceType === "local") {
        if (runModelId && validSet.has(runModelId)) {
          return [runModelId];
        }
        const fb = snapshot.models[0]?.id;
        return fb ? [fb] : [];
      }
      const next = prev.filter((id) => validSet.has(id));
      if (next.length > 0) {
        return next;
      }
      let fallback = snapshot.models[0]?.id;
      if (runModelId && validSet.has(runModelId)) {
        fallback = runModelId;
      } else if (preferredRunModelId && validSet.has(preferredRunModelId)) {
        fallback = preferredRunModelId;
      }
      return fallback ? [fallback] : [];
    });
  }, [preferredRunModelId, snapshot.models, runModelId, runWorkspaceType]);

  const handleRunWorktreeModelIdsChange = useCallback((ids: string[]) => {
    setRunWorktreeModelIds(ids);
    setRunModelId(ids[0] ?? "");
  }, []);

  const persistLastUsedRunModelId = useCallback(
    async (modelId: string) => {
      if (!buildwarden || !modelId.trim()) {
        return;
      }
      await buildwarden.setAppSetting(APP_SETTING_KEYS.lastUsedRunModelId, modelId);
    },
    [buildwarden],
  );

  const handleRunModelChange = useCallback(
    (modelId: string) => {
      setRunModelId(modelId);
      void persistLastUsedRunModelId(modelId).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Could not save default run model.");
      });
    },
    [persistLastUsedRunModelId],
  );

  const handleRunWorktreeModelIdsChangeAndPersist = useCallback(
    (ids: string[]) => {
      handleRunWorktreeModelIdsChange(ids);
      if (ids[0]) {
        void persistLastUsedRunModelId(ids[0]).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Could not save default run model.");
        });
      }
    },
    [handleRunWorktreeModelIdsChange, persistLastUsedRunModelId],
  );

  const clearDiffRefreshTimer = useCallback((runId?: string) => {
    if (runId) {
      const timer = diffRefreshTimersRef.current[runId];
      if (timer != null) {
        clearTimeout(timer);
        delete diffRefreshTimersRef.current[runId];
      }
      return;
    }

    for (const timer of Object.values(diffRefreshTimersRef.current)) {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
    diffRefreshTimersRef.current = {};
  }, []);

  const replaceRunDetailForRun = useCallback((runId: string, detail: RunDetail) => {
    setRunDetailsById((current) => {
      if (current[runId] === detail) {
        return current;
      }
      return { ...current, [runId]: detail };
    });
    if (selectedRunIdRef.current === runId) {
      setRunDetail(detail);
    }
  }, []);

  const mergeRunDetailForRun = useCallback((runId: string, merger: (detail: RunDetail) => RunDetail) => {
    setRunDetailsById((current) => {
      const previous = current[runId];
      if (!previous) {
        return current;
      }
      const next = merger(previous);
      return { ...current, [runId]: next };
    });
    setRunDetail((current) => (current?.run.id === runId ? merger(current) : current));
  }, []);

  const loadRunDetailForRun = useCallback(
    async (runId: string) => {
      if (!buildwarden) {
        return;
      }

      clearDiffRefreshTimer(runId);
      const loadToken = (runDetailLoadTokenRef.current[runId] ?? 0) + 1;
      runDetailLoadTokenRef.current[runId] = loadToken;
      const summaryGeneration = (diffSummaryLoadGenerationRef.current[runId] ?? 0) + 1;
      diffSummaryLoadGenerationRef.current[runId] = summaryGeneration;
      mergeRunDetailForRun(runId, (previous) => ({ ...previous, diffSummaryPending: true }));

      let fast: RunDetail;
      try {
        fast = await buildwarden.getRunDetail(runId);
      } catch (caught) {
        if (
          diffSummaryLoadGenerationRef.current[runId] === summaryGeneration
          && runDetailLoadTokenRef.current[runId] === loadToken
        ) {
          mergeRunDetailForRun(runId, (previous) => ({
            ...previous,
            diffSummary: undefined,
            diffSummaryPending: false,
          }));
        }
        throw caught;
      }
      if (runDetailLoadTokenRef.current[runId] !== loadToken) {
        return;
      }
      const summaryLoadIsCurrent = diffSummaryLoadGenerationRef.current[runId] === summaryGeneration;
      const previous = runDetailsByIdRef.current[runId];
      replaceRunDetailForRun(runId, {
        ...fast,
        diff: "",
        diffLoaded: false,
        diffPending: false,
        diffSummary: summaryLoadIsCurrent ? undefined : previous?.diffSummary,
        diffSummaryPending: summaryLoadIsCurrent ? true : (previous?.diffSummaryPending ?? false),
        worktreeUnavailable: summaryLoadIsCurrent ? false : (previous?.worktreeUnavailable ?? false),
      });
      if (!summaryLoadIsCurrent) return;

      try {
        const summaryResult = await buildwarden.getRunWorktreeDiffSummary(runId);
        if (diffSummaryLoadGenerationRef.current[runId] !== summaryGeneration) return;
        if (runDetailLoadTokenRef.current[runId] !== loadToken) return;
        mergeRunDetailForRun(runId, (previous) => ({
          ...previous,
          diffSummary: summaryResult.summary,
          diffSummaryPending: false,
          worktreeUnavailable: summaryResult.worktreeUnavailable,
        }));
      } catch {
        if (diffSummaryLoadGenerationRef.current[runId] !== summaryGeneration) return;
        if (runDetailLoadTokenRef.current[runId] !== loadToken) return;
        mergeRunDetailForRun(runId, (previous) => ({ ...previous, diffSummaryPending: false }));
      }
    },
    [buildwarden, clearDiffRefreshTimer, mergeRunDetailForRun, replaceRunDetailForRun],
  );

  const loadRunDetail = useCallback(
    async (runId: string | null | undefined) => {
      if (!runId) {
        setRunDetail(null);
        return;
      }
      await loadRunDetailForRun(runId);
    },
    [loadRunDetailForRun],
  );

  const loadEarlierRunHistory = useCallback(async (runId: string) => {
    if (!buildwarden) return;
    const detail = runDetailsByIdRef.current[runId];
    const page = detail?.historyPage;
    if (!page?.hasMore || !page.beforeCursor) return;
    const request = { beforeCursor: page.beforeCursor, snapshotRevision: page.snapshotRevision };
    const result = await buildwarden.getEarlierRunHistory(runId, request);
    const current = runDetailsByIdRef.current[runId];
    if (!current || current.historyPage?.beforeCursor !== request.beforeCursor ||
      current.historyPage.snapshotRevision !== request.snapshotRevision) return;
    if (result.stale) {
      await loadRunDetailForRun(runId);
      return;
    }
    mergeRunDetailForRun(runId, (previous) => ({
      ...previous,
      steps: mergeOrderedRecords(result.steps, previous.steps),
      historyPage: result.page,
    }));
  }, [buildwarden, loadRunDetailForRun, mergeRunDetailForRun]);

  const loadDiffSummaryForOpenRun = useCallback(
    async (eventRunId: string) => {
      const shouldLoadDiff =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!buildwarden || !shouldLoadDiff) {
        return;
      }
      const generation = (diffSummaryLoadGenerationRef.current[eventRunId] ?? 0) + 1;
      diffSummaryLoadGenerationRef.current[eventRunId] = generation;
      mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffSummaryPending: true }));
      let result;
      try {
        result = await buildwarden.getRunWorktreeDiffSummary(eventRunId);
      } catch {
        if (diffSummaryLoadGenerationRef.current[eventRunId] !== generation) return;
        mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffSummaryPending: false }));
        return;
      }
      if (diffSummaryLoadGenerationRef.current[eventRunId] !== generation) return;
      const stillShouldApply =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!stillShouldApply) {
        return;
      }
      mergeRunDetailForRun(eventRunId, (prev) => ({
        ...prev,
        diffSummary: result.summary,
        diffSummaryPending: false,
        worktreeUnavailable: result.worktreeUnavailable,
      }));
    },
    [buildwarden, mergeRunDetailForRun],
  );

  const loadDiffForOpenRun = useCallback(
    async (eventRunId: string) => {
      if (!buildwarden) return;
      const existing = diffLoadPromisesRef.current[eventRunId];
      if (existing) return existing;
      const generation = diffLoadGenerationRef.current[eventRunId] ?? 0;
      mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffPending: true }));
      const request = buildwarden
        .getRunWorktreeDiff(eventRunId)
        .then((result) => {
          if ((diffLoadGenerationRef.current[eventRunId] ?? 0) !== generation) return;
          mergeRunDetailForRun(eventRunId, (previous) => ({
            ...previous,
            diff: result.diff,
            diffLoaded: true,
            diffPending: false,
            worktreeUnavailable: result.worktreeUnavailable,
          }));
        })
        .catch(() => {
          if ((diffLoadGenerationRef.current[eventRunId] ?? 0) !== generation) return;
          mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffLoaded: true, diffPending: false }));
        })
        .finally(() => {
          delete diffLoadPromisesRef.current[eventRunId];
          if ((diffLoadGenerationRef.current[eventRunId] ?? 0) !== generation) {
            mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffPending: false }));
          }
        });
      diffLoadPromisesRef.current[eventRunId] = request;
      return request;
    },
    [buildwarden, mergeRunDetailForRun],
  );

  const refreshOpenRunDetailForEvent = useCallback(
    async (eventRunId: string, options?: { refreshDiff?: boolean }) => {
      const shouldRefresh =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!buildwarden || !shouldRefresh) {
        return;
      }

      const summaryGeneration = options?.refreshDiff
        ? (diffSummaryLoadGenerationRef.current[eventRunId] ?? 0) + 1
        : undefined;
      if (summaryGeneration !== undefined) {
        diffSummaryLoadGenerationRef.current[eventRunId] = summaryGeneration;
        mergeRunDetailForRun(eventRunId, (previous) => ({ ...previous, diffSummaryPending: true }));
      }

      let fast: RunDetail;
      try {
        fast = await buildwarden.getRunDetail(eventRunId);
      } catch (caught) {
        if (
          summaryGeneration !== undefined
          && diffSummaryLoadGenerationRef.current[eventRunId] === summaryGeneration
        ) {
          mergeRunDetailForRun(eventRunId, (previous) => ({
            ...previous,
            diffSummary: undefined,
            diffSummaryPending: false,
          }));
        }
        throw caught;
      }
      const stillOpen =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!stillOpen) {
        if (
          summaryGeneration !== undefined
          && diffSummaryLoadGenerationRef.current[eventRunId] === summaryGeneration
        ) {
          mergeRunDetailForRun(eventRunId, (previous) => ({
            ...previous,
            diffSummary: undefined,
            diffSummaryPending: false,
          }));
        }
        return;
      }

      const previous = runDetailsByIdRef.current[eventRunId];
      const previousHistoryPage = previous?.historyPage;
      const historyWasExpanded = Boolean(previousHistoryPage &&
        (previousHistoryPage.beforeCursor !== fast.historyPage?.beforeCursor || previousHistoryPage.hasMore === false));
      const summaryRefreshIsCurrent = summaryGeneration !== undefined
        && diffSummaryLoadGenerationRef.current[eventRunId] === summaryGeneration;
      if (options?.refreshDiff) {
        diffLoadGenerationRef.current[eventRunId] = (diffLoadGenerationRef.current[eventRunId] ?? 0) + 1;
      }
      replaceRunDetailForRun(eventRunId, {
        ...fast,
        steps: historyWasExpanded && previous ? mergeOrderedRecords(fast.steps, previous.steps) : fast.steps,
        historyPage: historyWasExpanded && previous ? previous.historyPage : fast.historyPage,
        diff: options?.refreshDiff ? "" : (previous?.diff ?? ""),
        diffLoaded: options?.refreshDiff ? false : (previous?.diffLoaded ?? false),
        worktreeUnavailable: previous?.worktreeUnavailable ?? false,
        diffPending: options?.refreshDiff ? Boolean(diffLoadPromisesRef.current[eventRunId]) : false,
        diffSummary: options?.refreshDiff && summaryRefreshIsCurrent ? undefined : previous?.diffSummary,
        diffSummaryPending: options?.refreshDiff && summaryRefreshIsCurrent
          ? true
          : (previous?.diffSummaryPending ?? false),
      });

      if (options?.refreshDiff && summaryRefreshIsCurrent) {
        clearDiffRefreshTimer(eventRunId);
        diffRefreshTimersRef.current[eventRunId] = setTimeout(() => {
          delete diffRefreshTimersRef.current[eventRunId];
          void loadDiffSummaryForOpenRun(eventRunId);
        }, 500);
      }
    },
    [buildwarden, clearDiffRefreshTimer, loadDiffSummaryForOpenRun, mergeRunDetailForRun, replaceRunDetailForRun],
  );

  /**
   * Refetching the full run detail (entire step history) for every streaming
   * event is O(n²) over a run's lifetime. Trail-throttle per run and flush
   * immediately on terminal events so the final state is never delayed.
   */
  const runDetailRefreshTimersRef = useRef<Partial<Record<string, number>>>({});
  const runDetailDiffRefreshRequestedRef = useRef<Partial<Record<string, boolean>>>({});
  const refreshRunDetailForActiveRunEvent = useCallback(
    async (eventRunId: string, options?: { immediate?: boolean; refreshDiff?: boolean }) => {
      if (options?.refreshDiff) runDetailDiffRefreshRequestedRef.current[eventRunId] = true;
      if (options?.immediate) {
        const pending = runDetailRefreshTimersRef.current[eventRunId];
        if (pending !== undefined) {
          window.clearTimeout(pending);
          delete runDetailRefreshTimersRef.current[eventRunId];
        }
        const refreshDiff = runDetailDiffRefreshRequestedRef.current[eventRunId] === true;
        delete runDetailDiffRefreshRequestedRef.current[eventRunId];
        await refreshOpenRunDetailForEvent(eventRunId, { refreshDiff });
        return;
      }
      if (runDetailRefreshTimersRef.current[eventRunId] !== undefined) {
        return;
      }
      runDetailRefreshTimersRef.current[eventRunId] = window.setTimeout(() => {
        delete runDetailRefreshTimersRef.current[eventRunId];
        const refreshDiff = runDetailDiffRefreshRequestedRef.current[eventRunId] === true;
        delete runDetailDiffRefreshRequestedRef.current[eventRunId];
        void refreshOpenRunDetailForEvent(eventRunId, { refreshDiff });
      }, 400);
    },
    [refreshOpenRunDetailForEvent],
  );
  const {
    enqueue: enqueueShellApproval,
    pending: pendingShellApproval,
    queuedCount: queuedShellApprovalCount,
    queue: shellApprovalQueue,
    removeByRequestId: removeShellApprovalByRequestId,
    removeByRunId: removeShellApprovalsByRunId,
    submitDecision: submitShellApprovalDecision,
    visible: visibleShellApprovals,
    visibleStartedAtById: visibleShellApprovalStartedAtById,
  } = useShellApprovalQueue({ buildwarden, loadRunDetailForRun, loadSnapshot, selectedRunId, setError });

  const purgeDeletedRunState = useCallback((runIds: readonly string[]) => {
    if (runIds.length === 0) return;
    const deletedIds = new Set(runIds);
    const omitDeleted = <T,>(current: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(current).filter(([runId]) => !deletedIds.has(runId)));

    for (const runId of deletedIds) {
      delete diffSummaryLoadGenerationRef.current[runId];
      clearDiffRefreshTimer(runId);
      const refreshTimer = runDetailRefreshTimersRef.current[runId];
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        delete runDetailRefreshTimersRef.current[runId];
      }
      removeShellApprovalsByRunId(runId);
    }
    setRunDetailsById(omitDeleted);
    setRunLiveUsageById(omitDeleted);
    setRunBrowserSessions(omitDeleted);
    setRunTerminalOpenLinksInApp(omitDeleted);
    setOpenRunPanes((current) => removeRunIdsFromOpenPanes(current, deletedIds));
    removeRunWorkspaceLayoutsForRuns(runIds.slice());
    if (typeof selectedRunIdRef.current === "string" && deletedIds.has(selectedRunIdRef.current)) {
      selectedRunIdRef.current = null;
      setSelectedRunId(null);
      setRunDetail(null);
    }
  }, [clearDiffRefreshTimer, removeRunWorkspaceLayoutsForRuns, removeShellApprovalsByRunId]);

  const confirmStartupDataRetentionCleanup = useCallback(async () => {
    if (startupDataRetentionState.status !== "review") return;
    const impact = startupDataRetentionState.impact;
    setStartupDataRetentionState({ status: "deleting", impact });
    try {
      const deleted = await buildwarden.deleteDataRetentionCandidates(impact.dayCount, impact.cutoffAt);
      purgeDeletedRunState(deleted.runIds);
      await loadSnapshot();
      setStartupDataRetentionState({ status: "ready" });
    } catch (caught) {
      await loadSnapshot().catch(() => undefined);
      setStartupDataRetentionState({
        status: "error",
        phase: "deleting",
        message: caught instanceof Error ? caught.message : "Could not delete all selected old data.",
      });
    }
  }, [buildwarden, loadSnapshot, purgeDeletedRunState, startupDataRetentionState]);

  const resolveStartupAutomations = useCallback(async (start: boolean) => {
    if (startupAutomationState.status === "error") {
      setStartupAutomationState({ status: "ready" });
      return;
    }
    if (startupAutomationState.status !== "review") return;
    const items = startupAutomationState.items;
    if (items.length > 0) setStartupAutomationState({ status: "starting", items });
    try {
      await buildwarden.resolveStartupAutomationCatchUp(start ? items.map((item) => item.automationId) : []);
      await loadSnapshot();
      setStartupAutomationState({ status: "ready" });
    } catch (caught) {
      setStartupAutomationState({ status: "error", message: caught instanceof Error ? caught.message : "Could not resolve missed automations." });
    }
  }, [buildwarden, loadSnapshot, startupAutomationState]);

  useEffect(
    () => () => {
      for (const timer of Object.values(runDetailRefreshTimersRef.current)) {
        window.clearTimeout(timer);
      }
      runDetailRefreshTimersRef.current = {};
    },
    [],
  );

  useEffect(() => () => clearDiffRefreshTimer(), [clearDiffRefreshTimer]);

  useEffect(() => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      setRunDetail(null);
      return;
    }

    const cachedDetail = runDetailsById[selectedRunId];
    if (cachedDetail) {
      setRunDetail(cachedDetail);
    }
  }, [runDetailsById, selectedRunId]);

  useEffect(() => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable. Restart the app with `pnpm dev`.");
      return;
    }

    void loadSnapshot().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Could not load the app snapshot.");
      setSnapshotLoaded(true);
    });
    void loadDetectedCodexInstallation();
    void loadDetectedClaudeInstallation();
    void loadDetectedCursorInstallation();
    void loadNetworkProxySettings();
    void loadAppPaths();

    const unsubscribe = buildwarden.onRunEvent((event) => {
      const approvalRequestId = typeof event.metadata?.approvalRequestId === "string" ? event.metadata.approvalRequestId : null;
      const approvalCommand = typeof event.metadata?.command === "string" ? event.metadata.command : null;
      const usageTotals = readRunTokenUsage(event.metadata?.usageTotals);

      if (usageTotals) {
        setRunLiveUsageById((current) => ({
          ...current,
          [event.runId]: {
            ...(current[event.runId] ?? {}),
            ...usageTotals,
          },
        }));
      }

      if (event.metadata?.shellApprovalRequest === true && approvalRequestId && approvalCommand) {
        const request: ShellApprovalRequestState = {
          runId: event.runId,
          requestId: approvalRequestId,
          command: approvalCommand,
          requestedAt: Date.now(),
        };
        enqueueShellApproval(request);
      }

      if (approvalRequestId && event.metadata?.shellApprovalDecision) {
        removeShellApprovalByRequestId(approvalRequestId);
      }

      if (event.title === "Run cancelled") {
        removeShellApprovalsByRunId(event.runId);
      }

      const isTerminalRunEvent =
        event.title === "Run completed" || event.title === "Run failed" || event.title === "Run cancelled";
      if (event.run) {
        setSnapshot((current) => applyLiveRunToSnapshot(current, event.run!));
      } else if (!event.step) {
        scheduleSnapshotRefresh();
      }
      if (event.step || event.run) {
        mergeRunDetailForRun(event.runId, (detail) => applyLiveRunEventToDetail(detail, event));
      }
      if (!event.step || event.type === "diff-updated" || isTerminalRunEvent) {
        void refreshRunDetailForActiveRunEvent(event.runId, {
          immediate: isTerminalRunEvent,
          refreshDiff: event.type === "diff-updated" || isTerminalRunEvent,
        });
      }
    });

    const unsubscribeChat = buildwarden.onChatEvent((event) => {
      if (event.chat) {
        setSnapshot((current) => applyLiveChatToSnapshot(current, event.chat!));
        setSelectedChat((current) => current?.id === event.chatId ? event.chat! : current);
      } else if (!event.step) {
        scheduleSnapshotRefresh();
      }
      if (event.step || event.chat) {
        setChatDetail((current) => current?.chat.id === event.chatId ? applyLiveChatEventToDetail(current, event) : current);
      }
    });

    const unsubscribeWarning = buildwarden.onAppWarning((warning) => {
      setAppWarning(warning);
    });

    const unsubscribeAutomationStarted = buildwarden.onAutomationStarted((payload) => {
      setAutomationStartedToasts((current) => addAutomationStartedToast(current, payload));
      scheduleSnapshotRefresh();
    });

    const unsubscribeLoopChanged = buildwarden.onProjectLoopChanged(() => {
      scheduleSnapshotRefresh();
    });
    const unsubscribeOrchestrationChanged = buildwarden.onOrchestrationChanged((payload) => {
      scheduleSnapshotRefresh();
      if (payload.deletedRunIds?.length) {
        purgeDeletedRunState(payload.deletedRunIds);
      } else {
        void refreshRunDetailForActiveRunEvent(payload.coordinatorRunId, { immediate: true });
      }
    });
    const unsubscribeForgeChanged = buildwarden.onRunForgeRequestChanged((payload) => {
      scheduleSnapshotRefresh();
      void refreshRunDetailForActiveRunEvent(payload.runId, { immediate: true });
    });

    return () => {
      unsubscribe();
      unsubscribeChat();
      unsubscribeWarning();
      unsubscribeAutomationStarted();
      unsubscribeLoopChanged();
      unsubscribeOrchestrationChanged();
      unsubscribeForgeChanged();
    };
  }, [
    buildwarden,
    loadAppPaths,
    loadDetectedClaudeInstallation,
    loadDetectedCodexInstallation,
    loadDetectedCursorInstallation,
    loadNetworkProxySettings,
    loadSnapshot,
    mergeRunDetailForRun,
    enqueueShellApproval,
    refreshRunDetailForActiveRunEvent,
    removeShellApprovalByRequestId,
    removeShellApprovalsByRunId,
    purgeDeletedRunState,
    scheduleSnapshotRefresh,
  ]);

  useEffect(() => {
    const oldest = automationStartedToasts.at(-1);
    if (!oldest) return;
    const timeoutId = window.setTimeout(() => {
      setAutomationStartedToasts((current) => current.filter((toast) => toast.runId !== oldest.runId));
    }, 8_000);
    return () => window.clearTimeout(timeoutId);
  }, [automationStartedToasts]);

  useEffect(() => {
    if (!snapshotLoaded || startupDataRetentionCheckStartedRef.current) return;
    startupDataRetentionCheckStartedRef.current = true;
    void checkStartupDataRetention();
  }, [checkStartupDataRetention, snapshotLoaded]);

  useEffect(() => {
    if (!snapshotLoaded || startupDataRetentionState.status !== "ready" || startupAutomationCheckStartedRef.current) return;
    startupAutomationCheckStartedRef.current = true;
    void checkStartupAutomations();
  }, [checkStartupAutomations, snapshotLoaded, startupDataRetentionState.status]);

  useEffect(() => {
    if (buildwarden.capabilities.liveEvents) return;
    const refreshRemoteView = () => {
      void loadSnapshot();
      const activeRunId = selectedRunIdRef.current;
      if (typeof activeRunId === "string") {
        void refreshOpenRunDetailForEvent(activeRunId);
      }
    };
    const intervalId = window.setInterval(refreshRemoteView, 3000);
    return () => window.clearInterval(intervalId);
  }, [buildwarden.capabilities.liveEvents, loadSnapshot, refreshOpenRunDetailForEvent]);

  useEffect(() => {
    if (typeof selectedRunId !== "string") return;
    void buildwarden.refreshRunForgeRequest(selectedRunId)
      .then(() => refreshOpenRunDetailForEvent(selectedRunId))
      .catch(() => undefined);
  }, [buildwarden, refreshOpenRunDetailForEvent, selectedRunId]);

  useEffect(() => {
    let lastRefreshAt = 0;
    const refreshVisibleForgeRequests = () => {
      const now = Date.now();
      if (now - lastRefreshAt < 30_000) return;
      lastRefreshAt = now;
      const runIds = new Set<string>();
      if (typeof selectedRunIdRef.current === "string") runIds.add(selectedRunIdRef.current);
      for (const entry of getOpenRunPaneEntries(openRunPanesRef.current)) runIds.add(entry.runId);
      for (const runId of runIds) {
        void buildwarden.refreshRunForgeRequest(runId)
          .then(() => refreshOpenRunDetailForEvent(runId))
          .catch(() => undefined);
      }
    };
    window.addEventListener("focus", refreshVisibleForgeRequests);
    return () => window.removeEventListener("focus", refreshVisibleForgeRequests);
  }, [buildwarden, refreshOpenRunDetailForEvent]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    void loadAppPaths();
    void loadDetectedCodexInstallation();
    void loadDetectedClaudeInstallation();
    void loadDetectedCursorInstallation();
  }, [
    loadAppPaths,
    loadDetectedClaudeInstallation,
    loadDetectedCodexInstallation,
    loadDetectedCursorInstallation,
    settingsOpen,
  ]);

  useEffect(() => {
    if (providerType === "cursor-agent") {
      void loadDetectedCursorInstallation();
    }
  }, [loadDetectedCursorInstallation, providerType]);

  useEffect(() => {
    if (!buildwarden || !shouldCheckProjectFolderGitStatus) {
      setProjectFolderGitStatus(null);
      return;
    }

    const repoPath = projectPath.trim();
    if (!repoPath) {
      setProjectFolderGitStatus(null);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      void buildwarden
        .checkProjectFolderGitStatus(repoPath)
        .then((status) => {
          if (!cancelled && status.path === repoPath) {
            setProjectFolderGitStatus(status);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProjectFolderGitStatus(null);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [buildwarden, projectPath, shouldCheckProjectFolderGitStatus]);

  useEffect(() => {
    void loadRunDetail(selectedRunId);
  }, [loadRunDetail, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return;
    }
    if (runIdIsOpenInPanes(openRunPanes, selectedRunId)) {
      return;
    }
    if (getOpenRunPaneEntries(openRunPanes).length > 0) {
      return;
    }

    setOpenRunPanes({ left: selectedRunId });
    setFocusedRunPane("left");
  }, [openRunPanes, selectedRunId]);

  const selectedProject = useMemo<ProjectSnapshot | null>(() => {
    return snapshot.projects.find((entry) => entry.project.id === runProjectId) ?? snapshot.projects[0] ?? null;
  }, [runProjectId, snapshot.projects]);
  const selectedProjectId = selectedProject?.project.id ?? "";
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;
  const {
    availableRunBranches,
    currentProjectBranch,
    currentProjectBranchStatus,
    detachedCheckoutBranch,
    loadProjectBranches,
    projectCheckoutBusy,
    runBaseBranch,
    setDetachedCheckoutBranch,
    setRunBaseBranch,
    submitCheckoutDetachedProjectBranch,
  } = useProjectBranches({ buildwarden, selectedProject, setError });
  const {
    changeRunMode,
    changeRunWorkspaceType,
    changeRunReasoningEffort,
    changeRunAnthropicEffort,
    changeRunExecutionMode,
    changeRunYoloMode,
    changeRunVerificationCommands,
    changeRunMaxMinutes,
    changeRunMaxTokens,
    changeRunMcpServers,
    changeRunModel,
    changeRunWorktreeModelIds,
    changeRunModelConfigurations,
  } = useProjectRunDefaults({
    buildwarden,
    snapshotLoaded,
    projectRunDefaultsSetting: snapshot.settings[APP_SETTING_KEYS.projectRunDefaults],
    models: snapshot.models,
    preferredRunModelId,
    selectedProjectId,
    setRunMode,
    setRunWorkspaceType,
    setRunReasoningEffort,
    setRunAnthropicEffort,
    setRunExecutionMode,
    setRunYoloMode,
    setRunVerificationCommands,
    setRunMaxMinutes,
    setRunMaxTokens,
    setRunMcpServers,
    setRunModelId,
    setRunWorktreeModelIds,
    setRunModelConfigurations,
    onRunModelChange: handleRunModelChange,
    onRunWorktreeModelIdsChange: handleRunWorktreeModelIdsChangeAndPersist,
    onError: setError,
  });

  useEffect(() => {
    if (selectedProject?.project.kind === "folder" && runWorkspaceType !== "copy" && runWorkspaceType !== "local") {
      setRunWorkspaceType("copy");
    }
    if (selectedProject?.project.kind === "git" && runWorkspaceType === "copy") {
      setRunWorkspaceType("worktree");
    }
  }, [runWorkspaceType, selectedProject?.project.kind]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    const hasActiveLabThread = selectedProject.labThreads.some(
      (detail) => detail.thread.status === "queued" || detail.thread.status === "running" || detail.thread.status === "reviewing",
    );
    if (!hasActiveLabThread) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadSnapshot();
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [loadSnapshot, selectedProject]);

  const projectRunStats = useMemo(() => {
    const runs = [...(selectedProject?.runs ?? []), ...(selectedProject?.forLaterRuns ?? [])];
    const inputTokens = selectedProject?.project.cumulativeInputTokens ?? 0;
    const outputTokens = selectedProject?.project.cumulativeOutputTokens ?? 0;
    return {
      total: runs.length,
      active: runs.filter((run) => ["queued", "preparing", "running"].includes(run.status)).length,
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      cancelled: runs.filter((run) => run.status === "cancelled").length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }, [selectedProject]);
  const selectedRunTokenUsage = useMemo(
    () => (runDetail ? latestRunTokenUsage(runDetail, runLiveUsageById[runDetail.run.id]) : null),
    [runDetail, runLiveUsageById],
  );

  const autoCheckoutRunBranchOnOpen = snapshot.settings[APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen] !== "false";
  const autoReleaseRunBranchOnLeave = snapshot.settings[APP_SETTING_KEYS.autoReleaseRunBranchOnLeave] !== "false";
  const dataRetentionCleanupEnabled = snapshot.settings[APP_SETTING_KEYS.dataRetentionCleanupEnabled] === "true";
  const dataRetentionCleanupDays = parseDataRetentionCleanupDaysSetting(snapshot.settings[APP_SETTING_KEYS.dataRetentionCleanupDays]);
  const pastedTextAttachmentThreshold = parsePastedTextAttachmentThresholdSetting(
    snapshot.settings[APP_SETTING_KEYS.pastedTextAttachmentThreshold],
  );
  const consecutiveToolCallCollapseThreshold = parseConsecutiveToolCallCollapseThresholdSetting(
    snapshot.settings[APP_SETTING_KEYS.consecutiveToolCallCollapseThreshold],
  );
  const recentRunDays = parseRecentRunDaysSetting(snapshot.settings[APP_SETTING_KEYS.recentRunDays]);
  const designScheme = useMemo(() => parseDesignScheme(snapshot.settings), [snapshot.settings]);
  const uiTheme = designScheme.mode;
  const persistedSidebarContrastStrength = parseSidebarContrastStrengthSetting(snapshot.settings[APP_SETTING_KEYS.sidebarContrast]);
  const [sidebarContrastStrength, setSidebarContrastStrength] = useState(persistedSidebarContrastStrength);
  useEffect(() => setSidebarContrastStrength(persistedSidebarContrastStrength), [persistedSidebarContrastStrength]);
  const sidebarRunEntrySize = parseSidebarRunEntrySizeSetting(snapshot.settings[APP_SETTING_KEYS.sidebarRunEntrySize]);
  const sidebarGroupRunsByProject = parseSidebarGroupRunsByProjectSetting(snapshot.settings[APP_SETTING_KEYS.sidebarGroupRunsByProject]);
  const runTimelineDensity = parseRunTimelineDensitySetting(snapshot.settings[APP_SETTING_KEYS.runTimelineDensity]);
  const updateRunTimelineDensity = useCallback(
    (density: RunTimelineDensity) => {
      if (!buildwarden) {
        return;
      }
      void buildwarden.setAppSetting(APP_SETTING_KEYS.runTimelineDensity, density)
        .then(() => loadSnapshot())
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Could not save run timeline density.");
        });
    },
    [buildwarden, loadSnapshot],
  );
  const selectedRun = useMemo(() => {
    if (runDetail?.run) {
      return runDetail.run;
    }
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return null;
    }
    return findProjectRun(snapshot.projects, selectedRunId)?.run ?? null;
  }, [runDetail?.run, selectedRunId, snapshot.projects]);
  const openRunPaneEntries = useMemo(() => getOpenRunPaneEntries(openRunPanes), [openRunPanes]);
  const openRunPaneCount = openRunPaneEntries.length;
  const isSplitRunView = openRunPaneCount > 1;
  const openRunPaneDetails = useMemo(
    () =>
      openRunPaneEntries.map((entry) => ({
        ...entry,
        detail: runDetailsById[entry.runId] ?? null,
      })),
    [openRunPaneEntries, runDetailsById],
  );
  const providerAccountById = useMemo(
    () => new Map(snapshot.providerAccounts.map((provider) => [provider.id, provider])),
    [snapshot.providerAccounts],
  );
  const configuredModelOptions = useMemo(
    () =>
      snapshot.models
        .filter((model) => model.enabled !== 0)
        .map((model) => {
          const provider = providerAccountById.get(model.providerAccountId) ?? null;
          const providerLabel = provider?.label ?? "Provider";

          const providerType = provider?.providerType ?? "ai-sdk";
          const providerFamily = providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider?.configJson ?? "{}") : null;
          return {
            id: model.id,
            label: `${model.displayName} - ${providerLabel}`,
            modelId: model.modelId,
            providerType,
            providerFamily,
            executionProfile: buildModelExecutionProfile(providerType, providerFamily, model.modelId, model.configJson),
          };
        }),
    [providerAccountById, snapshot.models],
  );
  const configuredRunModelOptions = configuredModelOptions;
  const configuredChatModelOptions = configuredModelOptions;

  const configuredIdeKinds = useMemo(() => {
    const cfg = parseIdePathConfig(snapshot.settings[APP_SETTING_KEYS.idePaths]);
    return SUPPORTED_IDE_KINDS.filter((k) => (cfg[k]?.trim() ?? "").length > 0);
  }, [snapshot.settings]);

  const getShellApprovalTarget = useCallback(
    (request: ShellApprovalRequestState) =>
      findProjectRun(snapshot.projects, request.runId) ??
      (runDetail?.run.id === request.runId
        ? {
            project: snapshot.projects.find((entry) => entry.project.id === runDetail.run.projectId) ?? null,
            run: runDetail.run,
          }
        : null),
    [runDetail?.run, snapshot.projects],
  );
  const runWorktreeUnavailable = runDetail?.worktreeUnavailable === true;
  const selectedRunHasOrchestrationSurface = Boolean(
    runDetail?.run &&
    runDetail.run.kind !== "orchestration-task" &&
    (runDetail.run.delegationEnabled || runDetail.orchestration),
  );
  const runWorkspacePanelVisibility = resolveRunWorkspacePanelVisibility({
    activity: runWorkspaceShowActivity,
    agents: runWorkspaceShowAgents && selectedRunHasOrchestrationSurface,
    diff: runWorkspaceShowDiff,
    terminal: runWorkspaceShowTerminal,
    browser: runWorkspaceShowBrowser,
    notes: runWorkspaceShowNotes,
    chat: runWorkspaceShowChat,
    "pull-request": runWorkspaceShowPullRequest && Boolean(runDetail?.run.forgeRequest),
  }, buildwarden.capabilities);
  const runWorkspacePanelSetters: Record<RunWorkspacePanelId, (visible: boolean) => void> = {
    activity: setRunWorkspaceShowActivity,
    agents: setRunWorkspaceShowAgents,
    diff: setRunWorkspaceShowDiff,
    terminal: setRunWorkspaceShowTerminal,
    browser: setRunWorkspaceShowBrowser,
    notes: setRunWorkspaceShowNotes,
    chat: setRunWorkspaceShowChat,
    "pull-request": setRunWorkspaceShowPullRequest,
  };
  const runWorkspaceVisiblePanelCount = Object.values(runWorkspacePanelVisibility).filter(Boolean).length;

  const setSelectedRunWorkspacePanelVisibility = (panelId: RunWorkspacePanelId, visible: boolean) => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return;
    }

    updateRunWorkspaceLayout(selectedRunId, (current) => ({
      ...current,
      visiblePanels: {
        ...current.visiblePanels,
        [panelId]: visible,
      },
    }));
  };

  const toggleRunWorkspacePanelForRun = (
    runId: string,
    panelId: RunWorkspacePanelId,
    worktreeUnavailableForRun = false,
    agentsAvailableForRun = false,
  ) => {
    const layout = runWorkspaceLayoutsByRunId[runId] ?? cloneDefaultRunWorkspaceLayoutPreference();
    if (worktreeUnavailableForRun && (panelId === "diff" || panelId === "terminal")) {
      return;
    }

    const visiblePanels = resolveRunWorkspacePanelVisibility({
      ...layout.visiblePanels,
      agents: layout.visiblePanels.agents && agentsAvailableForRun,
    }, buildwarden.capabilities);
    const visibleCount = Object.values(visiblePanels).filter(Boolean).length;
    const currentlyVisible = visiblePanels[panelId];
    if (currentlyVisible && visibleCount === 1) {
      return;
    }

    const nextVisible = !currentlyVisible;
    updateRunWorkspaceLayout(runId, (current) => ({
      ...current,
      visiblePanels: {
        ...current.visiblePanels,
        [panelId]: nextVisible,
      },
    }));
  };

  const toggleSelectedRunWorkspacePanel = (panelId: RunWorkspacePanelId) => {
    const visible = runWorkspacePanelVisibility[panelId];
    if (visible && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !visible;
    runWorkspacePanelSetters[panelId](next);
    setSelectedRunWorkspacePanelVisibility(panelId, next);
  };

  const runPanelToggleItems = RUN_PANEL_TOGGLE_DEFINITIONS
    .filter((definition) => definition.key !== "agents" || selectedRunHasOrchestrationSurface)
    .filter((definition) => definition.key !== "pull-request" || Boolean(runDetail?.run.forgeRequest))
    .filter((definition) => isRunWorkspacePanelAvailable(definition.key, buildwarden.capabilities))
    .map((definition): RunPanelToggleItem => {
      const active = runWorkspacePanelVisibility[definition.key];
      const cannotHide = active && runWorkspaceVisiblePanelCount === 1;
      const unavailable = definition.requiresWorktree && runWorktreeUnavailable;
      return {
        key: definition.key,
        label: definition.label,
        icon: definition.icon,
        active,
        disabled: unavailable || cannotHide,
        subtitle: unavailable ? "Worktree unavailable" : panelVisibilitySubtitle(active, definition.hiddenSubtitle),
        onClick: () => toggleSelectedRunWorkspacePanel(definition.key),
      };
    });

  const openRunBrowserUrl = (runId: string, url: string) => {
    setRunBrowserSessions((current) => {
      const previous = current[runId] ?? DEFAULT_RUN_BROWSER_SESSION;
      const previousHistory = previous.history.length > 0 ? previous.history : [previous.currentUrl];
      const previousIndex = Math.min(Math.max(previous.historyIndex, 0), previousHistory.length - 1);
      return {
        ...current,
        [runId]: {
          draftUrl: url,
          currentUrl: url,
          history: [...previousHistory.slice(0, previousIndex + 1), url],
          historyIndex: previousIndex + 1,
          reloadKey: previous.reloadKey,
        },
      };
    });
    if (selectedRunIdRef.current === runId) {
      setRunWorkspaceShowDiff(false);
      setRunWorkspaceShowBrowser(true);
    }
    updateRunWorkspaceLayout(runId, (current) => ({
      ...current,
      visiblePanels: {
        ...current.visiblePanels,
        diff: false,
        browser: true,
      },
    }));
  };

  const openSelectedRunBrowserUrl = (url: string) => {
    if (!runDetail?.run) {
      return;
    }

    openRunBrowserUrl(runDetail.run.id, url);
  };

  const {
    onLandingOrEmptySelection,
    isAgentRunDetailView,
    isChatDetailView,
    isBookmarkDetailView,
    isProjectWorkspaceView,
    sectionLayoutClassName,
  } =
    computeMainViewFlags({
      settingsOpen,
      landingSelected,
      allRunsSelected,
      bookmarksSelected,
      chatsSelected,
      selectedRunId,
      hasSelectedProject: Boolean(selectedProject),
      hasRunDetail: Boolean(runDetail?.run),
      openRunPaneCount,
      hasChatDetail: Boolean(selectedChat && chatDetail),
      hasBookmarkDetail: Boolean(selectedBookmark),
    });

  useEffect(() => {
    setPublishMenuOpen(false);
    setRunPanelsMenuOpen(false);
  }, [selectedRunId, runDetail?.run.updatedAt]);

  useEffect(() => {
    if (!error) {
      return;
    }
    if (error && isDetachedHeadProjectErrorMessage(error)) {
      return;
    }

    const timeoutId = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  useEffect(() => {
    if (!appWarning) {
      return;
    }

    const timeoutId = window.setTimeout(() => setAppWarning(null), 12000);
    return () => window.clearTimeout(timeoutId);
  }, [appWarning]);

  const handleAction = useCallback(async (action: () => Promise<void>, options: { rethrow?: boolean } = {}) => {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
      if (options.rethrow) {
        throw caught;
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const openRunDetailInIde = useCallback(
    (detail: RunDetail, ideKind: SupportedIdeKind) =>
      void handleAction(async () => {
        if (!buildwarden) {
          throw new Error("The Electron desktop bridge is unavailable.");
        }
        await buildwarden.openRunWorktreeInIde(detail.run.id, ideKind);
      }),
    [buildwarden, handleAction],
  );

  const openRunDetailInFileManager = useCallback(
    (detail: RunDetail) =>
      void handleAction(async () => {
        if (!buildwarden) {
          throw new Error("The Electron desktop bridge is unavailable.");
        }
        const result = await buildwarden.openPathInFileManager(detail.run.worktreePath);
        if (!result.ok) {
          throw new Error(result.error || "Could not open the workspace folder.");
        }
      }),
    [buildwarden, handleAction],
  );

  const requestConfirmation = useCallback((input: ConfirmDialogState) => {
    return new Promise<boolean>((resolve) => {
      confirmDialogResolverRef.current = resolve;
      setConfirmDialog(input);
    });
  }, []);

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmDialogResolverRef.current;
    confirmDialogResolverRef.current = null;
    setConfirmDialog(null);
    resolve?.(confirmed);
  }, []);

  useEffect(() => {
    if (!buildwarden || !buildwarden.capabilities.gitMutations || !selectedProject || selectedProject.project.kind !== "folder") {
      return;
    }
    let cancelled = false;
    const projectId = selectedProject.project.id;
    if (dismissedGitConversionProjectIdsRef.current.has(projectId) || gitConversionCheckInFlightRef.current.has(projectId)) {
      return;
    }

    gitConversionCheckInFlightRef.current.add(projectId);
    void (async () => {
      try {
        const candidate = await buildwarden.checkProjectGitConversion(projectId);
        if (cancelled) {
          return;
        }
        if (!candidate) {
          return;
        }
        const confirmed = await requestConfirmation({
          title: "Git repository detected",
          message:
            "BuildWarden found that this project folder is now a Git repository. Convert it to a Git project? This enables branches, worktrees, commits, and pull/merge request tools. No files will be changed, and existing folder runs will stay unchanged.",
          confirmLabel: "Convert to Git project",
          cancelLabel: "Not now",
        });
        if (cancelled) {
          return;
        }
        if (!confirmed) {
          dismissedGitConversionProjectIdsRef.current.add(projectId);
          return;
        }
        await buildwarden.convertProjectToGit(projectId);
        if (cancelled) {
          return;
        }
        setRunWorkspaceType("worktree");
        await loadSnapshot();
        void loadProjectBranches();
      } catch (caught) {
        if (cancelled) {
          return;
        }
        reportRendererError("renderer.project.git-conversion", caught, { projectId });
        setError(caught instanceof Error ? caught.message : "Could not check whether this folder is now a Git repository.");
      } finally {
        gitConversionCheckInFlightRef.current.delete(projectId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildwarden, loadProjectBranches, loadSnapshot, requestConfirmation, selectedProject]);

  useEffect(() => {
    const normalizedTab = normalizeProjectFeatureTab(selectedProject?.project.kind, projectPageTab);
    if (normalizedTab !== projectPageTab) {
      setProjectPageTab(normalizedTab);
    }
  }, [projectPageTab, selectedProject]);

  const chooseDirectory = async () => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const picked = await buildwarden.pickProjectDirectory();
    if (picked) {
      const derivedName = picked.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
      const currentDerivedName = projectPath.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
      setProjectPath(picked);
      if (derivedName && (!projectName.trim() || projectName.trim() === currentDerivedName)) {
        setProjectName(derivedName);
      }
    }
  };

  const pickDirectory = async (): Promise<string | null> => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return null;
    }

    return buildwarden.pickProjectDirectory();
  };

  const submitProject = async () => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const project = await buildwarden.addProject({
        name: projectName || undefined,
        repoPath: projectPath,
      });
      setProjectName("");
      setProjectPath("");
      setProjectFolderGitStatus(null);
      await loadSnapshot();
      setRunProjectId(project.id);
    });
  };

  const updateProjectBaseBranch = async (projectId: string, branchName: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      const project = await buildwarden.updateProjectBaseBranch(projectId, branchName);
      if (selectedProjectIdRef.current === projectId) {
        setRunBaseBranch(project.baseBranch);
      }
      await loadSnapshot();
    });
  };

  const submitProvider = async () => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const config = buildProviderAccountConfig({
        providerType,
        providerFamily,
        providerConfigJson,
        providerAzureApiVersion,
        codexBinaryPath,
        codexHomePath,
        detectedCodexBinaryPath,
        claudeBinaryPath,
        claudeLaunchArgs,
        detectedClaudeBinaryPath,
        cursorBinaryPath,
        cursorApiEndpoint,
        detectedCursorBinaryPath,
      });

      const provider = await buildwarden.addProviderAccount({
        providerType,
        label: providerLabel,
        apiKey: isLocalProviderType(providerType) ? "" : apiKey,
        apiBaseUrl: isLocalProviderType(providerType) ? undefined : providerBaseUrl || undefined,
        config,
      });
      setApiKey("");
      setCodexBinaryPath("");
      setCodexHomePath("");
      setClaudeBinaryPath("");
      setClaudeLaunchArgs("");
      setCursorBinaryPath("");
      setCursorApiEndpoint("");
      setProviderFamily("openai");
      setProviderBaseUrl("");
      setProviderConfigJson("{}");
      setProviderAzureApiVersion("2024-06-01");
      await loadSnapshot();
      setSelectedProviderId(provider.id);
    });
  };

  const submitModel = async () => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const availableModel = availableModelsByProviderIdRef.current[selectedProviderId]?.models.find(
        (candidate) => candidate.modelId === modelId.trim(),
      );
      const model = await buildwarden.addModel({
        providerAccountId: selectedProviderId,
        modelId,
        displayName: modelDisplayName,
        baseUrlOverride: modelBaseUrl || undefined,
        config: availableModel?.config,
        capabilities: availableModel?.capabilities,
      });
      await loadSnapshot();
      handleRunModelChange(model.id);
      setModelBaseUrl("");
    });
  };

  const focusRunInPaneState = useCallback(
    (runId: string, projectId: string, preferredPaneId?: RunPaneId) => {
      const currentPanes = openRunPanesRef.current;
      const existingPaneId = paneForOpenRunId(currentPanes, runId);
      const hasOpenPane = getOpenRunPaneEntries(currentPanes).length > 0;
      const paneId = existingPaneId ?? (hasOpenPane ? preferredPaneId ?? focusedRunPane : "left");
      const nextPanes: OpenRunPanes = existingPaneId ? { ...currentPanes } : { ...currentPanes, [paneId]: runId };
      for (const id of RUN_PANE_IDS) {
        if (id !== paneId && nextPanes[id] === runId) {
          delete nextPanes[id];
        }
      }

      setOpenRunPanes(nextPanes);
      setFocusedRunPane(paneId);
      setRunProjectId(projectId);
      setSelectedRunId(runId);
      selectedRunIdRef.current = runId;
      setRunDetail(runDetailsByIdRef.current[runId] ?? null);
    },
    [focusedRunPane],
  );

  const {
    commitDialogRun,
    commitMessage,
    setCommitMessage,
    commitSuggestBusy,
    openCommitDialog: commitRun,
    closeCommitDialog,
    handleCommitDialogKeyDown,
    suggestCommitMessageWithAi,
    submitCommitRun,
    continueDialogRun,
    continuePrompt,
    setContinuePrompt,
    continueModelId,
    setContinueModelId,
    continueIncludeWorkspaceChanges,
    setContinueIncludeWorkspaceChanges,
    openContinueRunDialog,
    closeContinueRunDialog,
    submitContinueRun,
    publishDialogRun,
    publishOptions,
    pullRequestTitle,
    setPullRequestTitle,
    pullRequestTargetBranch,
    setPullRequestTargetBranch,
    pullRequestSourceBranchMode,
    setPullRequestSourceBranchMode,
    pullRequestSourceBranchName,
    setPullRequestSourceBranchName,
    pullRequestCommitMessage,
    setPullRequestCommitMessage,
    pullRequestDescription,
    setPullRequestDescription,
    pullRequestDraftBusy,
    openPublishDialog,
    closePublishDialog,
    handlePublishDialogKeyDown,
    generatePullRequestDraft,
    submitPullRequest,
    branchPublishDialogRun,
    branchPublishName,
    setBranchPublishName,
    branchPublishMode,
    branchSuggestBusy,
    openBranchPublishDialog,
    closeBranchPublishDialog,
    handleBranchPublishDialogKeyDown,
    suggestBranchNameWithAi,
    publishBranch,
  } = useRunActionDialogs({
    buildwarden,
    snapshot,
    runYoloMode,
    handleAction,
    setError,
    onRunMutated: async (runId, projectId) => {
      await loadSnapshot();
      await loadRunDetail(runId);
      focusRunInPaneState(runId, projectId);
    },
    onRunContinued: async (newRunId, projectId) => {
      await loadSnapshot();
      setLandingSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      focusRunInPaneState(newRunId, projectId, focusedRunPane);
      await loadRunDetail(newRunId);
    },
  });

  /** Creates one run for the model id using the shared composer settings; returns the new run id or null for stale model ids. */
  const createRunForModel = async (
    mid: string,
    prompt: string,
    attachments?: ChatAttachmentPayload[],
    projectTaskId?: string,
  ): Promise<string | null> => {
    if (!buildwarden) {
      throw new Error("The Electron desktop bridge is unavailable.");
    }
    const selectedModel = snapshot.models.find((model) => model.id === mid);
    if (!selectedModel) {
      return null;
    }
    const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
    if (!selectedProvider) {
      return null;
    }
    const providerFamilyForModel =
      selectedProvider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(selectedProvider.configJson) : null;
    const modelConfiguration = resolveRunModelConfiguration(
      mid,
      runWorkspaceType === "local" ? {} : runModelConfigurations,
      runReasoningEffort,
      runAnthropicEffort,
      runExecutionMode,
      selectedProvider.providerType === "claude-code" || (selectedProvider.providerType === "ai-sdk" && providerFamilyForModel === "anthropic"),
    );
    const reasoningInput = buildRunReasoningInput(
      selectedProvider.providerType,
      providerFamilyForModel,
      modelConfiguration.effort,
      modelConfiguration.effort,
      buildModelExecutionProfile(selectedProvider.providerType, providerFamilyForModel, selectedModel.modelId, selectedModel.configJson),
      modelConfiguration.executionMode,
    );
    const commandInput = resolveProviderComposerPrompt(prompt, selectedProvider.providerType, "run");
    if (commandInput.goalText !== undefined && !commandInput.prompt.trim() && !(attachments?.length ?? 0)) {
      throw new Error("Add a task on the next line after /goal when starting a new run.");
    }
    const run = await buildwarden.createRun({
      projectId: runProjectId,
      providerAccountId: selectedModel.providerAccountId,
      modelId: mid,
      harnessType: harnessTypeForProvider(selectedProvider.providerType),
      mode: commandInput.mode ?? runMode,
      workspaceType: runWorkspaceType,
      baseBranch: runBaseBranch,
      prompt: commandInput.prompt,
      ...(commandInput.goalText !== undefined ? { goalText: commandInput.goalText } : {}),
      attachments,
      projectTaskId,
      ...reasoningInput,
      yoloMode: runYoloMode,
      delegationEnabled: runDelegationEnabled,
    });
    return run.id;
  };

  const startRunsForModels = async (
    modelIds: string[],
    prompt: string,
    attachments?: ChatAttachmentPayload[],
    projectTaskId?: string,
  ) => {
    let lastRunId: string | null = null;
    for (const mid of modelIds) {
      lastRunId = (await createRunForModel(mid, prompt, attachments, projectTaskId)) ?? lastRunId;
    }
    await loadSnapshot();
    setLandingSelected(false);
    if (lastRunId) {
      setSelectedRunId(lastRunId);
    }
  };

  const filterConfiguredModelIds = (ids: string[]) => ids.filter((id) => snapshot.models.some((m) => m.id === id));

  const submitRun = async (payload?: { attachments?: ChatAttachmentPayload[] }) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const selectedIds = runWorkspaceType === "worktree" || runWorkspaceType === "copy" ? runWorktreeModelIds : [runModelId];
      const modelIds = filterConfiguredModelIds(selectedIds);
      if (modelIds.length === 0) {
        throw new Error("Select at least one configured model before starting a run.");
      }

      if (!runPrompt.trim() && !(payload?.attachments?.length ?? 0)) {
        throw new Error("Enter a task description or attach at least one file.");
      }

      await startRunsForModels(modelIds, runPrompt, payload?.attachments);
    });
  };

  const submitRunFromPrompt = async (prompt: string, modelId: string, projectTaskId?: string) => {
    const previousPrompt = runPrompt;
    setRunPrompt(prompt);
    try {
      await handleAction(async () => {
        if (!buildwarden) {
          throw new Error("The Electron desktop bridge is unavailable.");
        }

        const modelIds = filterConfiguredModelIds([modelId]);
        if (modelIds.length === 0) {
          throw new Error("Select a configured model before starting a run.");
        }

        if (!prompt.trim()) {
          throw new Error("Enter a task description before starting a run.");
        }

        await startRunsForModels(modelIds, prompt, undefined, projectTaskId);
      });
    } finally {
      setRunPrompt(previousPrompt);
    }
  };

  const createProjectTask = async (projectId: string, input: ProjectTaskInput) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.createProjectTask(projectId, input);
      await loadSnapshot();
    });
  };

  const updateProjectTask = async (
    taskId: string,
    input: UpdateProjectTaskInput,
  ) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.updateProjectTask(taskId, input);
      await loadSnapshot();
    }, { rethrow: true });
  };

  const deleteProjectTask = async (taskId: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.deleteProjectTask(taskId);
      await loadSnapshot();
    });
  };

  const generateProjectInsight = async (projectId: string, kind: ProjectInsightKind, modelId?: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      reportRendererLog({
        level: "warn",
        source: "renderer.project-insight.generate.start",
        message: "Requesting project insight generation.",
        metadata: {
          projectId,
          kind,
          modelId: modelId ?? null,
        },
      });
      await buildwarden.generateProjectInsight({ projectId, kind, modelId });
      await loadSnapshot();
      reportRendererLog({
        level: "warn",
        source: "renderer.project-insight.generate.success",
        message: "Project insight generation completed and snapshot reloaded.",
        metadata: {
          projectId,
          kind,
          modelId: modelId ?? null,
        },
      });
    });
  };

  const reorderProjects = async (projectIds: string[]) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.reorderProjects(projectIds);
      await loadSnapshot();
    });
  };

  const setRunForLater = async (runId: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.setRunListVisibility(runId, "for-later");
      await loadSnapshot();
      const paneId = paneForOpenRunId(openRunPanesRef.current, runId);
      if (paneId) {
        const nextPanes: OpenRunPanes = { ...openRunPanesRef.current };
        delete nextPanes[paneId];
        const remainingRunId = firstOpenRunId(nextPanes);
        const remainingPaneId = remainingRunId ? paneForOpenRunId(nextPanes, remainingRunId) ?? "left" : "left";
        setOpenRunPanes(nextPanes);
        setRunDetailsById((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
        if (selectedRunId === runId && remainingRunId) {
          void setFocusedRunSelection(remainingPaneId, remainingRunId).catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Unexpected error");
          });
        } else if (selectedRunId === runId) {
          clearRunSelectionState(null);
        }
      } else if (selectedRunId === runId) {
        clearRunSelectionState(null);
      }
    });
  };

  const restoreRunFromForLater = async (runId: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.setRunListVisibility(runId, "default");
      await loadSnapshot();
    });
  };

  const cancelRun = useCallback(async (run: RunRecord) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.cancelRun(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
    });
  }, [buildwarden, handleAction, loadRunDetail, loadSnapshot]);

  const cancelRunShell = async (run: RunRecord, toolCallId: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.cancelRunShell(run.id, toolCallId);
      await loadRunDetail(run.id);
    });
  };

  const followUpRun = async (
    run: RunRecord,
    prompt: string,
    options: {
      mode: RunRecord["mode"];
      modelId: string;
      attachments?: ChatAttachmentPayload[];
      reasoningEffort?: string;
      anthropicEffort?: string;
      yoloMode?: boolean;
      goalText?: string | null;
    },
  ) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const selectedModel = snapshot.models.find((model) => model.id === options.modelId);
      if (!selectedModel) {
        throw new Error("Select a configured model before sending a follow-up.");
      }
      const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
      if (!selectedProvider) {
        throw new Error("The selected model is missing its provider configuration.");
      }
      const commandInput = resolveProviderComposerPrompt(prompt, selectedProvider.providerType, "follow-up");
      const hasExplicitGoalText = Object.prototype.hasOwnProperty.call(options, "goalText");
      let goalText = commandInput.goalText;
      if (goalText === undefined && hasExplicitGoalText) {
        goalText = options.goalText;
      }
      if (!commandInput.prompt.trim() && !(options.attachments?.length ?? 0) && goalText === undefined) {
        throw new Error("Enter a follow-up command or attach at least one file.");
      }

      await buildwarden.followUpRun(run.id, commandInput.prompt.trim(), {
        ...options,
        mode: commandInput.mode ?? options.mode,
        ...(goalText !== undefined ? { goalText } : {}),
      });
      await loadSnapshot();
      await loadRunDetail(run.id);
      focusRunInPaneState(run.id, run.projectId);
    });
  };

  const undoRunToLastPrompt = async (run: RunRecord) => {
    const confirmed = await requestConfirmation({
      title: "Revert run changes",
      message:
        "Revert repository changes made after the last prompt in this run? This updates the run workspace and cannot be undone from BuildWarden.",
      confirmLabel: "Revert changes",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.undoRunToLastPrompt(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
      focusRunInPaneState(run.id, run.projectId);
    });
  };

  const recoverInterruptedRun = async (run: RunRecord) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.recoverInterruptedRun(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
      focusRunInPaneState(run.id, run.projectId);
    });
  };

  const respondToShellApproval = async (request: ShellApprovalRequestState, decision: ShellApprovalDecision) => {
    if (!buildwarden) {
      return;
    }

    await handleAction(async () => {
      await submitShellApprovalDecision(request, decision);
    });
  };

  const respondToPendingShellApproval = async (decision: ShellApprovalDecision) => {
    if (!pendingShellApproval) {
      return;
    }

    await respondToShellApproval(pendingShellApproval, decision);
  };

  const leaveSelectedRun = useCallback(async () => {
    if (!buildwarden || !selectedRunId) {
      return;
    }

    await buildwarden.releaseRun(selectedRunId);
  }, [buildwarden, selectedRunId]);

  const clearRunSelectionState = useCallback((nextSelectedRunId: string | null | undefined = null) => {
    setSelectedRunId(nextSelectedRunId);
    selectedRunIdRef.current = nextSelectedRunId;
    setRunDetail(null);
    setOpenRunPanes({});
    setFocusedRunPane("left");
    setRunDetailsById({});
  }, []);

  const setFocusedRunSelection = useCallback(
    async (paneId: RunPaneId, runId: string, projectId?: string) => {
      const target = findProjectRun(snapshot.projects, runId);
      const nextProjectId = projectId ?? target?.project.project.id ?? runDetailsByIdRef.current[runId]?.run.projectId ?? "";

      setFocusedRunPane(paneId);
      setSelectedRunId(runId);
      selectedRunIdRef.current = runId;
      if (nextProjectId) {
        setRunProjectId(nextProjectId);
      }
      setRunDetail(runDetailsByIdRef.current[runId] ?? null);

      if (!buildwarden) {
        return;
      }

      await buildwarden.activateRun(runId);
      await loadSnapshot();
      await loadRunDetailForRun(runId);
    },
    [buildwarden, loadRunDetailForRun, loadSnapshot, snapshot.projects],
  );

  const focusRunPane = useCallback(
    (paneId: RunPaneId) => {
      const runId = openRunPanesRef.current[paneId];
      if (!runId) {
        return;
      }

      void setFocusedRunSelection(paneId, runId).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Unexpected error");
      });
    },
    [setFocusedRunSelection],
  );

  const closeRunPane = useCallback(
    (paneId: RunPaneId) => {
      const currentPanes = openRunPanesRef.current;
      const closingRunId = currentPanes[paneId];
      if (!closingRunId) {
        return;
      }

      const wasFocused = selectedRunIdRef.current === closingRunId;
      const nextPanes: OpenRunPanes = { ...currentPanes };
      delete nextPanes[paneId];
      const remainingRunId = firstOpenRunId(nextPanes);
      const remainingPaneId = remainingRunId ? paneForOpenRunId(nextPanes, remainingRunId) ?? "left" : "left";

      setOpenRunPanes(nextPanes);
      setRunDetailsById((current) => {
        if (runIdIsOpenInPanes(nextPanes, closingRunId)) {
          return current;
        }
        const next = { ...current };
        delete next[closingRunId];
        return next;
      });

      if (!remainingRunId) {
        clearRunSelectionState(null);
        if (buildwarden && wasFocused) {
          void buildwarden.releaseRun(closingRunId).catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Unexpected error");
          });
        }
        return;
      }

      if (wasFocused) {
        void setFocusedRunSelection(remainingPaneId, remainingRunId).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Unexpected error");
        });
      }
    },
    [buildwarden, clearRunSelectionState, setFocusedRunSelection],
  );

  const handleProjectSelect = useCallback(async (projectId: string) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await leaveSelectedRun();
      await buildwarden.selectProject(projectId);
      await loadSnapshot();
      setLandingSelected(false);
      setAllRunsSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      setProjectPageTab("overview");
      setRunProjectId(projectId);
      clearRunSelectionState(null);
    });
  }, [buildwarden, clearRunSelectionState, handleAction, leaveSelectedRun, loadSnapshot]);

  const handleProjectFeatureSelect = useCallback(async (projectId: string, tab: ProjectPageTab) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const targetProject = snapshot.projects.find((entry) => entry.project.id === projectId);
      const nextTab = normalizeProjectFeatureTab(targetProject?.project.kind, tab);
      await leaveSelectedRun();
      await buildwarden.selectProject(projectId);
      await loadSnapshot();
      setLandingSelected(false);
      setAllRunsSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      setProjectPageTab(nextTab);
      setRunProjectId(projectId);
      clearRunSelectionState(null);
    });
  }, [buildwarden, clearRunSelectionState, handleAction, leaveSelectedRun, loadSnapshot, snapshot.projects]);

  const dismissProjectForgeRequestToast = useCallback((id: string) => {
    setProjectForgeRequestToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const openProjectForgeRequest = useCallback(
    (payload: ProjectForgeRequestOpenPayload) => {
      setProjectForgeRequestToasts((current) =>
        current.filter((toast) => toast.projectId !== payload.projectId || toast.prUrl !== payload.prUrl),
      );
      setReviewRequestTarget({
        projectId: payload.projectId,
        url: payload.prUrl,
        requestId: Date.now(),
      });
      void handleProjectFeatureSelect(payload.projectId, "reviews");
    },
    [handleProjectFeatureSelect],
  );

  const handleLandingSelect = useCallback(async () => {
    await handleAction(async () => {
      if (buildwarden) {
        await leaveSelectedRun();
        await loadSnapshot();
      }
      setLandingSelected(true);
      setAllRunsSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      clearRunSelectionState(null);
    });
  }, [buildwarden, clearRunSelectionState, handleAction, leaveSelectedRun, loadSnapshot]);

  const handleAllRunsSelect = useCallback(async () => {
    await handleAction(async () => {
      if (buildwarden) {
        await leaveSelectedRun();
        await loadSnapshot();
      }
      setLandingSelected(false);
      setAllRunsSelected(true);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      setSelectedBookmark(null);
      setSelectedChat(null);
      setChatDetail(null);
      clearRunSelectionState(null);
    });
  }, [buildwarden, clearRunSelectionState, handleAction, leaveSelectedRun, loadSnapshot]);

  const handleBookmarksSelect = useCallback(() => {
    void leaveSelectedRun();
    setBookmarksSelected(true);
    setAllRunsSelected(false);
    setChatsSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setLandingSelected(false);
    setSettingsOpen(false);
    clearRunSelectionState(null);
  }, [clearRunSelectionState, leaveSelectedRun]);

  const handleChatsSelect = useCallback(() => {
    void leaveSelectedRun();
    setChatsSelected(true);
    setAllRunsSelected(false);
    setBookmarksSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setLandingSelected(false);
    setSettingsOpen(false);
    clearRunSelectionState(null);
  }, [clearRunSelectionState, leaveSelectedRun]);

  const openSettingsPage = useCallback(() => {
    if (!buildwarden.capabilities.settings) return;
    setSettingsPreviousPage({
      landingSelected,
      allRunsSelected,
      bookmarksSelected,
      chatsSelected,
      projectPageTab,
      selectedBookmark,
      selectedChat,
      chatDetail,
      selectedRunId,
      runDetail,
      openRunPanes,
      focusedRunPane,
      runDetailsById,
    });
    void leaveSelectedRun();
    setSettingsOpen(true);
    setLandingSelected(false);
    setAllRunsSelected(false);
    setBookmarksSelected(false);
    setChatsSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    clearRunSelectionState(null);
  }, [
    buildwarden.capabilities.settings,
    allRunsSelected,
    bookmarksSelected,
    chatDetail,
    chatsSelected,
    clearRunSelectionState,
    focusedRunPane,
    landingSelected,
    leaveSelectedRun,
    openRunPanes,
    projectPageTab,
    runDetail,
    runDetailsById,
    selectedBookmark,
    selectedChat,
    selectedRunId,
  ]);

  const handleSettingsBack = useCallback(() => {
    setSettingsOpen(false);
    if (settingsPreviousPage) {
      setLandingSelected(settingsPreviousPage.landingSelected);
      setAllRunsSelected(settingsPreviousPage.allRunsSelected);
      setBookmarksSelected(settingsPreviousPage.bookmarksSelected);
      setChatsSelected(settingsPreviousPage.chatsSelected);
      setProjectPageTab(settingsPreviousPage.projectPageTab);
      setSelectedBookmark(settingsPreviousPage.selectedBookmark);
      setSelectedChat(settingsPreviousPage.selectedChat);
      setChatDetail(settingsPreviousPage.chatDetail);
      setSelectedRunId(settingsPreviousPage.selectedRunId);
      setRunDetail(settingsPreviousPage.runDetail);
      setOpenRunPanes(settingsPreviousPage.openRunPanes);
      setFocusedRunPane(settingsPreviousPage.focusedRunPane);
      setRunDetailsById(settingsPreviousPage.runDetailsById);
      if (settingsPreviousPage.selectedRunId && typeof settingsPreviousPage.selectedRunId === "string") {
        selectedRunIdRef.current = settingsPreviousPage.selectedRunId;
        void setFocusedRunSelection(
          settingsPreviousPage.focusedRunPane,
          settingsPreviousPage.selectedRunId,
          settingsPreviousPage.runDetail?.run.projectId,
        ).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Unexpected error");
        });
      }
      setSettingsPreviousPage(null);
      return;
    }
    setLandingSelected(true);
    setAllRunsSelected(false);
    setBookmarksSelected(false);
    setChatsSelected(false);
  }, [setFocusedRunSelection, settingsPreviousPage]);

  const toggleUiTheme = useCallback(
    () =>
      handleAction(async () => {
        if (!buildwarden) {
          throw new Error("The Electron desktop bridge is unavailable.");
        }
        const next = getDefaultDesignScheme(designScheme.mode === "dark" ? "light" : "dark");
        await buildwarden.setAppSetting(APP_SETTING_KEYS.designScheme, serializeDesignScheme(next));
        await buildwarden.setAppSetting(APP_SETTING_KEYS.uiTheme, next.mode);
        await buildwarden.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next.mode));
        await loadSnapshot();
      }),
    [buildwarden, designScheme.mode, handleAction, loadSnapshot],
  );

  useEffect(() => {
    if (!buildwarden) {
      return;
    }

    return buildwarden.onAppMenuCommand((command) => {
      if (command === "go-home") {
        void handleLandingSelect();
        return;
      }

      if (command === "new-chat") {
        handleChatsSelect();
        return;
      }

      if (command === "open-settings") {
        openSettingsPage();
        return;
      }

      if (command === "toggle-dark-mode") {
        void toggleUiTheme();
        return;
      }

      if (command === "new-agent-run") {
        const targetProjectId = runProjectId || selectedProject?.project.id || snapshot.projects[0]?.project.id || "";
        if (targetProjectId) {
          void handleProjectSelect(targetProjectId);
        } else {
          setSettingsOpen(true);
          setLandingSelected(false);
          setAllRunsSelected(false);
          setBookmarksSelected(false);
          setChatsSelected(false);
        }
      }
    });
  }, [buildwarden, handleChatsSelect, handleLandingSelect, handleProjectSelect, openSettingsPage, runProjectId, selectedProject, snapshot.projects, toggleUiTheme]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    return buildwarden.onProjectForgeRequestOpen((payload: ProjectForgeRequestOpenPayload) => {
      if (!payload.projectId || !payload.prUrl) {
        return;
      }
      openProjectForgeRequest(payload);
    });
  }, [buildwarden, openProjectForgeRequest]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    return buildwarden.onProjectForgeRequestNotification((payload) => {
      if (!payload.projectId || !payload.prUrl) {
        return;
      }
      const id = `${payload.projectId}:${payload.prUrl}`;
      setProjectForgeRequestToasts((current) => addProjectForgeRequestToast(current, { ...payload, id }));
    });
  }, [buildwarden]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    return buildwarden.onProjectTaskChanged(() => {
      scheduleSnapshotRefresh();
    });
  }, [buildwarden, scheduleSnapshotRefresh]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    return buildwarden.onAppSettingsChanged(() => {
      void loadSnapshot();
    });
  }, [buildwarden, loadSnapshot]);

  const addRunToBookmarks = async (runId: string) => {
    if (!buildwarden) return;
    await buildwarden.addBookmark(runId);
    await loadSnapshot();
  };

  const removeRunFromBookmarks = async (runId: string) => {
    if (!buildwarden) return;
    await buildwarden.removeBookmark(runId);
    await loadSnapshot();
  };

  const removeBookmarkById = async (bookmarkId: string) => {
    if (!buildwarden) return;
    await buildwarden.removeBookmarkById(bookmarkId);
    await loadSnapshot();
  };

  const removeChatBookmarkById = async (bookmarkId: string) => {
    if (!buildwarden) return;
    await buildwarden.removeChatBookmarkById(bookmarkId);
    await loadSnapshot();
  };

  const createChat = async (input: {
    prompt: string;
    modelId: string;
    attachments?: ChatAttachmentPayload[];
    reasoningEffort?: string;
    anthropicEffort?: string;
    executionOptions?: ProviderExecutionOptions;
  }) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      const next = await buildwarden.refreshSnapshot();
      const model = next.models.find((m) => m.id === input.modelId);
      if (!model) {
        throw new Error("Select a model in Settings before starting a chat.");
      }
      const chat = await buildwarden.createChat({
        providerAccountId: model.providerAccountId,
        modelId: input.modelId,
        prompt: input.prompt,
        attachments: input.attachments,
        reasoningEffort: input.reasoningEffort,
        anthropicEffort: input.anthropicEffort,
        executionOptions: input.executionOptions,
      });
      await loadSnapshot();
      setChatsSelected(true);
      setBookmarksSelected(false);
      setSelectedChat(chat);
      setChatDetail({ chat, steps: [] });
      const detail = await buildwarden.getChatDetail(chat.id);
      setChatDetail(detail);
    });
  };

  const handleChatSelect = useCallback(async (chat: Pick<ChatRecord, "id">) => {
    const detail = await buildwarden?.getChatDetail(chat.id);
    if (detail) {
      setSelectedChat(detail.chat);
      setChatDetail(detail);
    }
  }, [buildwarden]);

  const followUpChat = async (
    chatId: string,
    prompt: string,
    options?: FollowUpChatOptions,
  ) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.followUpChat(chatId, prompt, options);
      await loadSnapshot();
      const detail = await buildwarden.getChatDetail(chatId);
      setChatDetail(detail);
    });
  };

  const deleteChat = async (chatId: string) => {
    if (!buildwarden) return;
    await buildwarden.deleteChat(chatId);
    await loadSnapshot();
    if (selectedChat?.id === chatId) {
      setSelectedChat(null);
      setChatDetail(null);
    }
  };

  const cancelChat = async (chatId: string) => {
    if (!buildwarden) return;
    await buildwarden.cancelChat(chatId);
    await loadSnapshot();
    const detail = await buildwarden.getChatDetail(chatId);
    setChatDetail(detail);
  };

  const handleRunSelect = useCallback(async (projectId: string, runId: string) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    setLandingSelected(false);
    setAllRunsSelected(false);
    setBookmarksSelected(false);
    setChatsSelected(false);
    setSettingsOpen(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setRunProjectId(projectId);
    setOpenRunPanes({ left: runId });
    setFocusedRunPane("left");
    const cachedDetail = runDetailsByIdRef.current[runId] ?? null;
    setRunDetailsById(cachedDetail ? { [runId]: cachedDetail } : {});
    setSelectedRunId(runId);
    selectedRunIdRef.current = runId;
    setRunDetail(cachedDetail);

    const runActivateAndSnapshot = async () => {
      if (selectedRunId && selectedRunId !== runId) {
        await leaveSelectedRun();
      }
      await buildwarden.activateRun(runId);
      await loadSnapshot();
    };

    Promise.all([runActivateAndSnapshot(), loadRunDetail(runId)]).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
    });
  }, [buildwarden, leaveSelectedRun, loadRunDetail, loadSnapshot, selectedRunId]);

  const reviewChildRun = useCallback((projectId: string, childRunId: string) => {
    updateRunWorkspaceLayout(childRunId, (current) => ({
      ...current,
      visiblePanels: {
        ...current.visiblePanels,
        diff: true,
      },
    }));
    void handleRunSelect(projectId, childRunId);
  }, [handleRunSelect, updateRunWorkspaceLayout]);

  const openRunInSplitPane = useCallback(
    async (projectId: string, runId: string, targetPaneId?: RunPaneId) => {
      if (!selectedRunIdRef.current) {
        await handleRunSelect(projectId, runId);
        return;
      }

      const currentPanes = openRunPanesRef.current;
      const currentFocusedRunId = selectedRunIdRef.current;
      const existingPaneId = paneForOpenRunId(currentPanes, runId);
      if (existingPaneId) {
        if (runId === currentFocusedRunId) {
          return;
        }
        await setFocusedRunSelection(existingPaneId, runId, projectId);
        return;
      }

      if (runId === currentFocusedRunId) {
        return;
      }

      const openEntries = getOpenRunPaneEntries(currentPanes);
      let paneId: RunPaneId;
      if (openEntries.length <= 1) {
        paneId = currentPanes.left ? "right" : "left";
      } else {
        paneId = targetPaneId ?? (focusedRunPane === "left" ? "right" : "left");
      }

      const nextPanes: OpenRunPanes = { ...currentPanes, [paneId]: runId };
      for (const id of RUN_PANE_IDS) {
        if (id !== paneId && nextPanes[id] === runId) {
          delete nextPanes[id];
        }
      }
      setOpenRunPanes(nextPanes);
      await setFocusedRunSelection(paneId, runId, projectId);
    },
    [focusedRunPane, handleRunSelect, setFocusedRunSelection],
  );

  const handleRunDragStart = useCallback((event: ReactDragEvent<HTMLButtonElement>, projectId: string, runId: string) => {
    const payload: RunDragPayload = { type: "buildwarden/run", projectId, runId };
    const serialized = JSON.stringify(payload);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(RUN_DRAG_MIME_TYPE, serialized);
    event.dataTransfer.setData("text/plain", serialized);
  }, []);

  const resolveRunPaneDropPreview = useCallback(
    (targetPaneId?: RunPaneId): RunPaneId | null => {
      const currentPanes = openRunPanesRef.current;
      const openEntries = getOpenRunPaneEntries(currentPanes);
      if (!selectedRunIdRef.current || openEntries.length === 0) {
        return null;
      }

      if (openEntries.length <= 1) {
        return currentPanes.left ? "right" : "left";
      }

      return targetPaneId ?? (focusedRunPane === "left" ? "right" : "left");
    },
    [focusedRunPane],
  );

  const handleRunPaneDragOver = useCallback((event: ReactDragEvent<HTMLElement>, paneId?: RunPaneId) => {
    if (!selectedRunIdRef.current) {
      return;
    }
    if (!Array.from(event.dataTransfer.types).includes(RUN_DRAG_MIME_TYPE)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    const nextPreview = resolveRunPaneDropPreview(paneId);
    setRunPaneDropPreview((current) => (current === nextPreview ? current : nextPreview));
  }, [resolveRunPaneDropPreview]);

  const handleRunPaneDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }

    setRunPaneDropPreview(null);
  }, []);

  const handleRunDropOnPane = useCallback(
    (event: ReactDragEvent<HTMLElement>, paneId?: RunPaneId) => {
      const payload = parseRunDragPayload(event);
      if (!payload) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setRunPaneDropPreview(null);
      void openRunInSplitPane(payload.projectId, payload.runId, paneId).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Unexpected error");
      });
    },
    [openRunInSplitPane],
  );

  const openShellApprovalRun = useCallback(async (request: ShellApprovalRequestState) => {
    if (!buildwarden) {
      return;
    }

    const existingPaneId = paneForOpenRunId(openRunPanesRef.current, request.runId);
    if (existingPaneId) {
      focusRunPane(existingPaneId);
      return;
    }

    const target = getShellApprovalTarget(request);
    const knownProjectId = target?.project?.project.id ?? target?.run.projectId;
    if (knownProjectId) {
      await handleRunSelect(knownProjectId, request.runId);
      return;
    }

    try {
      const detail = await buildwarden.getRunDetail(request.runId);
      await handleRunSelect(detail.run.projectId, request.runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
    }
  }, [buildwarden, focusRunPane, getShellApprovalTarget, handleRunSelect]);

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(
    () =>
      buildCommandPaletteItems({
        snapshot,
        targetProjectId: runProjectId || selectedProject?.project.id || snapshot.projects[0]?.project.id || "",
        onSelectLanding: handleLandingSelect,
        onSelectAllRuns: handleAllRunsSelect,
        onSelectChats: handleChatsSelect,
        onSelectBookmarks: handleBookmarksSelect,
        onOpenSettings: openSettingsPage,
        onSelectProject: handleProjectSelect,
        onSelectProjectFeature: handleProjectFeatureSelect,
        onSelectRun: handleRunSelect,
        onSelectChat: handleChatSelect,
        onToggleTheme: toggleUiTheme,
      }).filter((item) => {
        if (!readOnly) return true;
        if (item.id === "workspace-settings" || item.id === "workspace-new-run") return false;
        if (item.section !== "Project") return true;
        return snapshot.projects.some((entry) => item.id === `project-${entry.project.id}`);
      }),
    [
      handleAllRunsSelect,
      handleBookmarksSelect,
      handleChatSelect,
      handleChatsSelect,
      handleProjectFeatureSelect,
      handleProjectSelect,
      handleRunSelect,
      handleLandingSelect,
      openSettingsPage,
      runProjectId,
      selectedProject?.project.id,
      snapshot,
      readOnly,
      toggleUiTheme,
    ],
  );

  const updateBooleanSetting = async (key: string, value: boolean) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.setAppSetting(key, String(value));
      await loadSnapshot();
    });
  };

  const persistSidebarWidth = useCallback(
    (width: number) => {
      const nextWidth = clampSidebarWidth(width);
      setSidebarWidth(nextWidth);
      if (!buildwarden) {
        return;
      }
      void buildwarden.setAppSetting(APP_SETTING_KEYS.sidebarWidth, String(nextWidth)).catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Could not save sidebar width.");
      });
    },
    [buildwarden],
  );

  const keyboardShortcuts = useMemo(
    () => parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]),
    [snapshot.settings],
  );

  const shellAllowlistExtraText = useMemo(
    () => parseShellAllowlistExtraSetting(snapshot.settings[APP_SETTING_KEYS.shellAllowlistExtra]).join("\n"),
    [snapshot.settings],
  );
  const {
    integratedSkillsCatalog,
    globallyDisabledIntegratedSkillIds,
    projectActiveSkillsByProjectId,
    projectLabSettingsByProjectId,
    enabledIntegratedSkills,
    updateGloballyDisabledIntegratedSkills,
    updateProjectActiveSkills,
    updateProjectLabSettings,
  } = useSkillsSettings({ buildwarden, snapshotSettings: snapshot.settings, loadSnapshot });

  const updateShellAllowlistExtra = useCallback(
    async (text: string) => {
      if (!buildwarden) {
        return;
      }
      const lines = text
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await buildwarden.setAppSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(lines));
      await loadSnapshot();
    },
    [buildwarden, loadSnapshot],
  );

  const updateKeyboardShortcut = useCallback(
    async (id: KeyboardShortcutId, value: string) => {
      if (!buildwarden) return;
      const current = parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]);
      const next = { ...current, [id]: value };
      await buildwarden.setAppSetting(APP_SETTING_KEYS.keyboardShortcuts, JSON.stringify(next));
      await loadSnapshot();
    },
    [buildwarden, loadSnapshot, snapshot.settings],
  );

  const openAppMenuSection = useCallback(
    async (section: AppMenuSection, anchor: HTMLButtonElement) => {
      if (!buildwarden) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      await buildwarden.showAppMenu(section, Math.round(rect.left), Math.round(rect.bottom));
    },
    [buildwarden],
  );

  const deleteProject = async (projectId: string) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const deletedRunIds = snapshot.projects.find((project) => project.project.id === projectId)?.runs.map((run) => run.id) ?? [];

    const confirmed = await requestConfirmation({
      title: "Delete project",
      message:
        "Delete this project from BuildWarden and remove all of its runs, run history, and tracked workspace data? The original repository folder will not be deleted.",
      confirmLabel: "Delete project",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await buildwarden.deleteProject(projectId);
      setRunBrowserSessions((current) => {
        const next = { ...current };
        for (const runId of deletedRunIds) {
          delete next[runId];
        }
        return next;
      });
      setRunTerminalOpenLinksInApp((current) => {
        const next = { ...current };
        for (const runId of deletedRunIds) {
          delete next[runId];
        }
        return next;
      });
      removeRunWorkspaceLayoutsForRuns(deletedRunIds);
      clearRunSelectionState();
      await loadSnapshot();
    });
  };

  const deleteRuns = useCallback(async (runs: RunRecord[]): Promise<boolean> => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return false;
    }

    const requestedRuns = [...new Map(runs.map((run) => [run.id, run])).values()];
    if (requestedRuns.length === 0) {
      return true;
    }
    if (requestedRuns.some((run) => pendingDeleteRunIds[run.id])) {
      return false;
    }

    let requestedImpacts: RunDeletionImpact[];
    try {
      requestedImpacts = await Promise.all(requestedRuns.map((run) => buildwarden.getRunDeletionImpact(run.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not inspect the run deletion impact.");
      return false;
    }

    // Selecting both an orchestration coordinator and one of its children must
    // result in exactly one cascade deletion, initiated through the coordinator.
    const deletionPlan = buildRunDeletionPlan(requestedImpacts);
    const {
      impacts: deletionImpacts,
      affectedRunIds,
      runningRunIds,
      ownedDirectories,
      branches,
      artifactPaths,
      lockedOrMissingPaths,
    } = deletionPlan;
    if ([...affectedRunIds].some((runId) => pendingDeleteRunIds[runId])) {
      return false;
    }

    const singleRun = requestedRuns.length === 1 ? requestedRuns[0] : null;
    const singleImpact = deletionImpacts.length === 1 ? deletionImpacts[0] : null;
    const isSingleCascade = singleRun != null && singleImpact?.orchestrationId != null;
    const impactSummary = singleRun && singleImpact
      ? isSingleCascade
        ? [
            `This permanently deletes the coordinator and ${Math.max(0, singleImpact.runIds.length - 1)} child run(s).`,
            `${singleImpact.runningRunIds.length} process(es) will be cancelled.`,
            `${singleImpact.ownedDirectories.length} owned workspace(s), ${singleImpact.branches.length} branch(es), and ${singleImpact.artifactPaths.length} orchestration artifact path(s) will be removed.`,
            singleImpact.lockedOrMissingPaths.length
              ? `${singleImpact.lockedOrMissingPaths.length} path(s) are currently unavailable and may require a cleanup retry.`
              : "Every owned path and database row must be verified removed before deletion succeeds.",
            singleRun.workspaceType === "local"
              ? "The original repository and previously adopted project changes are never deleted."
              : "",
            "Child cleanup is mandatory and cannot be deselected.",
          ].filter(Boolean).join("\n\n")
        : singleRun.workspaceType === "local"
          ? "Delete this local run and remove its logs, diff history, and persisted run data? Repository files will not be deleted."
          : "Delete this run, its worktree, logs, diff history, and persisted run data?"
      : [
          `Permanently delete ${requestedRuns.length} selected runs${affectedRunIds.size !== requestedRuns.length ? ` and all ${affectedRunIds.size} affected runs` : ""}?`,
          `${runningRunIds.size} active process(es) will be cancelled.`,
          `${ownedDirectories.size} app-owned workspace(s), ${branches.size} branch(es), and ${artifactPaths.size} orchestration artifact path(s) will be removed.`,
          lockedOrMissingPaths.size
            ? `${lockedOrMissingPaths.size} path(s) are currently unavailable and may require a cleanup retry.`
            : "All related logs, history, bookmarks, checkpoints, chats, and persisted run data will be removed.",
          "Original project repositories are never deleted.",
        ].join("\n\n");
    const confirmed = await requestConfirmation({
      title: singleRun
        ? isSingleCascade ? "Delete orchestration and all children" : "Delete run"
        : `Delete ${requestedRuns.length} selected runs`,
      message: impactSummary,
      impactItems: singleRun ? undefined : [
        { label: "Agent runs", count: affectedRunIds.size },
        { label: "Active processes", count: runningRunIds.size },
        { label: "Owned workspaces", count: ownedDirectories.size },
        { label: "Branches", count: branches.size },
        { label: "Orchestration artifacts", count: artifactPaths.size },
      ],
      confirmLabel: singleRun ? isSingleCascade ? "Delete orchestration" : "Delete run" : "Delete selected runs",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return false;
    }

    setPendingDeleteRunIds((current) => {
      const next = { ...current };
      for (const runId of affectedRunIds) next[runId] = true;
      return next;
    });

    const successfullyDeletedRunIds = new Set<string>();
    let deletionFailure: unknown = null;
    try {
      for (const [index, impact] of deletionImpacts.entries()) {
        try {
          await buildwarden.deleteRun(deletionPlan.targetRunIds[index]);
          for (const runId of impact.runIds) successfullyDeletedRunIds.add(runId);
        } catch (caught) {
          deletionFailure = caught;
          break;
        }
      }

      if (successfullyDeletedRunIds.size > 0) {
        const wasViewingDeletedRun = typeof selectedRunId === "string" && successfullyDeletedRunIds.has(selectedRunId);
        const nextPanes = removeRunIdsFromOpenPanes(openRunPanesRef.current, successfullyDeletedRunIds);
        const remainingRunId = firstOpenRunId(nextPanes);
        const remainingPaneId = remainingRunId ? paneForOpenRunId(nextPanes, remainingRunId) ?? "left" : "left";
        purgeDeletedRunState([...successfullyDeletedRunIds]);
        if (wasViewingDeletedRun && remainingRunId) {
          try {
            await setFocusedRunSelection(remainingPaneId, remainingRunId);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "The remaining open run could not be restored.");
          }
        } else if (wasViewingDeletedRun) {
          setFocusedRunPane("left");
        }
      }

      if (deletionFailure) {
        setError(deletionFailure instanceof Error ? deletionFailure.message : "Could not delete all selected runs.");
      }
      try {
        await loadSnapshot();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not refresh runs after deletion.");
      }
    } finally {
      setPendingDeleteRunIds((current) => {
        const next = { ...current };
        for (const runId of affectedRunIds) delete next[runId];
        return next;
      });
    }

    return deletionFailure == null;
  }, [
    buildwarden,
    loadSnapshot,
    pendingDeleteRunIds,
    purgeDeletedRunState,
    requestConfirmation,
    selectedRunId,
    setFocusedRunSelection,
  ]);

  const deleteRun = useCallback(async (run: RunRecord) => {
    await deleteRuns([run]);
  }, [deleteRuns]);

  const deleteProviderAccount = async (providerAccountId: string) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Delete provider",
      message: "Delete this provider and its models from BuildWarden? Providers referenced by existing runs cannot be deleted.",
      confirmLabel: "Delete provider",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await buildwarden.deleteProviderAccount(providerAccountId);
      await loadSnapshot();
    });
  };

  const deleteModel = async (modelId: string) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    let deletionImpact: ModelDeletionImpact;
    try {
      deletionImpact = await buildwarden.getModelDeletionImpact(modelId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not inspect the model deletion impact.");
      return;
    }
    const relatedObjectCount =
      deletionImpact.runCount +
      deletionImpact.chatCount +
      deletionImpact.projectInsightCount +
      deletionImpact.projectLabThreadCount +
      deletionImpact.projectLoopCount +
      deletionImpact.orchestrationCount +
      (deletionImpact.automationCount ?? 0);
    const confirmed = await requestConfirmation({
      title: "Delete model",
      message: relatedObjectCount > 0
        ? `Permanently delete ${deletionImpact.modelDisplayName} and all related data? App-owned run workspaces and files will also be removed.`
        : `Permanently delete ${deletionImpact.modelDisplayName}? This model has no related data.`,
      impactItems: [
        { label: "Agent runs", count: deletionImpact.runCount },
        { label: "Chats", count: deletionImpact.chatCount },
        { label: "Project insights", count: deletionImpact.projectInsightCount },
        { label: "Project Lab threads", count: deletionImpact.projectLabThreadCount },
        { label: "Project loops", count: deletionImpact.projectLoopCount },
        { label: "Orchestrations", count: deletionImpact.orchestrationCount },
        { label: "Automations", count: deletionImpact.automationCount ?? 0 },
      ],
      confirmLabel: "Delete model",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await buildwarden.deleteModel(modelId);
      const deletedChatIds = new Set(deletionImpact.chatIds);
      purgeDeletedRunState(deletionImpact.runIds);
      setSelectedChat((current) => current && deletedChatIds.has(current.id) ? null : current);
      setChatDetail((current) => current && deletedChatIds.has(current.chat.id) ? null : current);
      setSettingsPreviousPage((current) => current
        ? reconcileSettingsPreviousPageAfterModelDeletion(current, deletionImpact.runIds, deletionImpact.chatIds)
        : current);
      await loadSnapshot();
    });
  };

  useEffect(() => {
    const handleKeyDown = createAppKeyboardShortcutHandler({
      shortcuts: parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]),
      snapshotProjects: snapshot.projects,
      welcomeOpen,
      commandPaletteOpen,
      settingsOpen,
      bookmarksSelected,
      chatsSelected,
      selectedRunId,
      runDetailRun: runDetail?.run ?? null,
      runProjectId,
      openCommandPalette: () => setCommandPaletteOpen(true),
      closeSettings: handleSettingsBack,
      openSettings: openSettingsPage,
      goHome: () => void handleLandingSelect(),
      toggleSidebar: () => setSidebarCollapsed((current) => !current),
      selectRun: (projectId, runId) => void handleRunSelect(projectId, runId),
      openProject: (projectId) => void handleProjectSelect(projectId),
      deleteRun: (run) => void deleteRun(run),
      cancelRun: (run) => void cancelRun(run),
    });

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    snapshot.settings,
    snapshot.projects,
    welcomeOpen,
    commandPaletteOpen,
    settingsOpen,
    bookmarksSelected,
    chatsSelected,
    selectedRunId,
    runDetail?.run,
    runProjectId,
    deleteRun,
    cancelRun,
    handleSettingsBack,
    handleProjectSelect,
    handleLandingSelect,
    handleRunSelect,
    openSettingsPage,
  ]);

  useEffect(() => {
    if (!snapshotLoadedSuccessfully) return;
    applyDesignSchemeToDocument(designScheme);
  }, [designScheme, snapshotLoadedSuccessfully]);

  useEffect(() => {
    const clearRunPaneDropPreview = () => setRunPaneDropPreview(null);
    window.addEventListener("dragend", clearRunPaneDropPreview);
    window.addEventListener("drop", clearRunPaneDropPreview);
    return () => {
      window.removeEventListener("dragend", clearRunPaneDropPreview);
      window.removeEventListener("drop", clearRunPaneDropPreview);
    };
  }, []);

  const renderRunPaneDropPreviewTile = (paneId: RunPaneId) => (
    <div
      key={`drop-preview-${paneId}`}
      className="relative flex min-h-[400px] min-w-0 flex-1 overflow-hidden rounded-lg border border-dashed border-[var(--ec-accent-ring)] bg-[var(--ec-panel-soft)] p-1.5"
      onDragOver={(event) => handleRunPaneDragOver(event, paneId)}
      onDrop={(event) => handleRunDropOnPane(event, paneId)}
    >
      <RunPaneDropPreviewOverlay paneId={paneId} mode="tile" />
    </div>
  );

  const renderRunPane = (entry: (typeof openRunPaneDetails)[number]) => {
    const paneDetail = entry.detail;
    const paneRun = paneDetail?.run ?? findProjectRun(snapshot.projects, entry.runId)?.run ?? null;
    const isFocused = selectedRunId === entry.runId && focusedRunPane === entry.paneId;
    const paneDropPreviewActive = runPaneDropPreview === entry.paneId;
    const paneLayout = runWorkspaceLayoutsByRunId[entry.runId] ?? cloneDefaultRunWorkspaceLayoutPreference();
    const paneHasOrchestrationSurface = Boolean(
      paneRun &&
      paneRun.kind !== "orchestration-task" &&
      (paneRun.delegationEnabled || paneDetail?.orchestration),
    );
    const resolvedPaneVisiblePanels = resolveRunWorkspacePanelVisibility(
      isFocused
        ? {
            activity: runWorkspaceShowActivity,
            agents: runWorkspaceShowAgents,
            diff: runWorkspaceShowDiff,
            terminal: runWorkspaceShowTerminal,
            browser: runWorkspaceShowBrowser,
            notes: runWorkspaceShowNotes,
            chat: runWorkspaceShowChat,
            "pull-request": runWorkspaceShowPullRequest && Boolean(paneRun?.forgeRequest),
          }
        : paneLayout.visiblePanels,
      buildwarden.capabilities,
    );
    const paneVisiblePanels = {
      ...resolvedPaneVisiblePanels,
      agents: resolvedPaneVisiblePanels.agents && paneHasOrchestrationSurface,
    };
    const paneSecondaryPosition = isFocused ? runWorkspaceSecondaryPosition : paneLayout.secondaryPanelPosition;
    const paneTokenUsage = paneDetail ? latestRunTokenUsage(paneDetail, runLiveUsageById[paneDetail.run.id]) : null;

    return (
      <div
        key={entry.paneId}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col gap-1.5",
          "relative overflow-hidden",
          isSplitRunView &&
            "rounded-lg border bg-[var(--ec-bg)] p-1.5 shadow-[var(--ec-panel-shadow)]",
          (isSplitRunView || paneDropPreviewActive) && "rounded-lg border",
          isSplitRunView && (isFocused ? "border-[var(--ec-accent-ring)]" : "border-[var(--ec-border)]"),
          paneDropPreviewActive && "border-[var(--ec-accent)]",
        )}
        onPointerDownCapture={(event) => {
          if (event.target instanceof Element && event.target.closest("[data-run-pane-ignore-focus='true']")) {
            return;
          }
          if (!isFocused) {
            focusRunPane(entry.paneId);
          }
        }}
        onDragOver={(event) => handleRunPaneDragOver(event, entry.paneId)}
        onDrop={(event) => handleRunDropOnPane(event, entry.paneId)}
      >
        {paneRun ? (
          <RunDetailHeader
            run={paneRun}
            runDetail={paneDetail}
            tokenUsage={paneTokenUsage}
            busy={busy}
            pendingDelete={Boolean(pendingDeleteRunIds[paneRun.id])}
            configuredIdeKinds={configuredIdeKinds}
            canContinueRun={isRunContinuable(paneRun)}
            focused={isFocused}
            splitView={isSplitRunView}
            paneLabel={entry.paneId}
            runTimelineDensity={runTimelineDensity}
            onRunTimelineDensityChange={updateRunTimelineDensity}
            runDensityMenuOpen={runDensityMenuOpen}
            setRunDensityMenuOpen={setRunDensityMenuOpen}
            runDensityMenuAnchorRef={runDensityMenuAnchorRef}
            runPanelToggleItems={runPanelToggleItems}
            runWorkspaceVisiblePanelCount={runWorkspaceVisiblePanelCount}
            runPanelsMenuOpen={runPanelsMenuOpen}
            setRunPanelsMenuOpen={setRunPanelsMenuOpen}
            runPanelsMenuAnchorRef={runPanelsMenuAnchorRef}
            publishMenuOpen={publishMenuOpen}
            setPublishMenuOpen={setPublishMenuOpen}
            publishMenuAnchorRef={publishMenuAnchorRef}
            onCommitRun={commitRun}
            onRequestDiffSummary={loadDiffSummaryForOpenRun}
            onOpenPublishDialog={openPublishDialog}
            onOpenBranchPublishDialog={openBranchPublishDialog}
            onOpenInIde={openRunDetailInIde}
            onOpenFileManager={openRunDetailInFileManager}
            onOpenContinueRunDialog={openContinueRunDialog}
            onDeleteRun={deleteRun}
            onFocusSubagent={(subagentId) => setSubagentFocusRequest({ runId: paneRun.id, subagentId, nonce: Date.now() })}
            onClosePane={() => closeRunPane(entry.paneId)}
          />
        ) : null}

        {paneDetail?.run ? (
          <RunDetailPage
            className="min-h-0 min-w-0 flex-1"
            runDetail={paneDetail}
            busy={busy}
            modelOptions={configuredRunModelOptions}
            keyboardShortcuts={keyboardShortcuts}
            pendingShellApproval={null}
            timelineDensity={runTimelineDensity}
            tokenUsage={paneTokenUsage}
            subagentFocus={subagentFocusRequest?.runId === paneDetail.run.id ? subagentFocusRequest : null}
            showActivity={paneVisiblePanels.activity}
            showAgents={paneVisiblePanels.agents}
            showDiff={paneVisiblePanels.diff}
            showTerminal={paneVisiblePanels.terminal}
            showBrowser={paneVisiblePanels.browser}
            showNotes={paneVisiblePanels.notes}
            showChat={paneVisiblePanels.chat}
            showPullRequest={paneVisiblePanels["pull-request"]}
            onRequestDiff={loadDiffForOpenRun}
            onLoadEarlierHistory={loadEarlierRunHistory}
            onTogglePanel={(panelId) => toggleRunWorkspacePanelForRun(
              paneDetail.run.id,
              panelId,
              paneDetail.worktreeUnavailable === true,
              paneHasOrchestrationSurface,
            )}
            secondaryPanelPosition={paneSecondaryPosition}
            onSecondaryPanelPositionChange={(position) => {
              if (isFocused) {
                setRunWorkspaceSecondaryPosition(position);
              }
              updateRunWorkspaceLayout(paneDetail.run.id, (current) => ({
                ...current,
                secondaryPanelPosition: position,
              }));
            }}
            tileOrder={paneLayout.tileOrder}
            tileLayout={paneLayout.tileLayout}
            onTileOrderChange={(next) => {
              updateRunWorkspaceLayout(paneDetail.run.id, (current) => ({
                ...current,
                tileOrder: next,
              }));
            }}
            onTileLayoutChange={(next) => {
              updateRunWorkspaceLayout(paneDetail.run.id, (current) => ({
                ...current,
                tileLayout: next,
              }));
            }}
            browserSession={runBrowserSessions[paneDetail.run.id] ?? DEFAULT_RUN_BROWSER_SESSION}
            terminalOpenLinksInApp={runTerminalOpenLinksInApp[paneDetail.run.id] !== false}
            onTerminalOpenLinksInAppChange={(enabled) =>
              setRunTerminalOpenLinksInApp((current) => ({
                ...current,
                [paneDetail.run.id]: enabled,
              }))
            }
            onBrowserSessionChange={(session) =>
              setRunBrowserSessions((current) => ({
                ...current,
                [paneDetail.run.id]: session,
              }))
            }
            onOpenBrowserUrl={(url) => openRunBrowserUrl(paneDetail.run.id, url)}
            onRespondToShellApproval={(decision) => respondToPendingShellApproval(decision)}
            onCancelRunShell={(run, toolCallId) => void cancelRunShell(run, toolCallId)}
            onCancelRun={(run) => void cancelRun(run)}
            onUndoRunToLastPrompt={(run) => void undoRunToLastPrompt(run)}
            onRecoverInterruptedRun={(run) => void recoverInterruptedRun(run)}
            onCreateProjectTask={(projectId, input) => createProjectTask(projectId, input)}
            onOpenChildRun={(childRunId) => void handleRunSelect(paneDetail.run.projectId, childRunId)}
            onReviewChildRun={(childRunId) => reviewChildRun(paneDetail.run.projectId, childRunId)}
            onFollowUpRun={(run, prompt, options) => followUpRun(run, prompt, options)}
          />
        ) : (
          <Card className="flex min-h-[400px] flex-1 flex-col items-center justify-center gap-4 p-8">
            <Loader2 className="h-10 w-10 animate-spin text-[var(--ec-accent)]" />
            <p className="text-sm text-[var(--ec-muted)]">Loading run...</p>
          </Card>
        )}
        {paneDropPreviewActive ? <RunPaneDropPreviewOverlay paneId={entry.paneId} mode="replace" /> : null}
      </div>
    );
  };

  // Stable-identity props for the memoized Sidebar: without these, inline
  // closures would change identity every render and defeat the memo.
  const sidebarBookmarkedRunIds = useMemo(() => new Set(snapshot.bookmarks.map((b) => b.originalRunId)), [snapshot.bookmarks]);
  const sidebarOnSelectLanding = useStableCallback(() => void handleLandingSelect());
  const sidebarOnSelectAllRuns = useStableCallback(() => void handleAllRunsSelect());
  const sidebarOnSelectBookmarks = useStableCallback(() => handleBookmarksSelect());
  const sidebarOnSelectChats = useStableCallback(() => handleChatsSelect());
  const sidebarOnSelectProject = useStableCallback((projectId: string) => handleProjectSelect(projectId));
  const sidebarOnSelectProjectFeature = useStableCallback(
    (projectId: string, tab: ProjectPageTab) => void handleProjectFeatureSelect(projectId, tab),
  );
  const sidebarOnSelectRun = useStableCallback((projectId: string, runId: string) => handleRunSelect(projectId, runId));
  const sidebarOnRunDragStart = useStableCallback(
    (event: ReactDragEvent<HTMLButtonElement>, projectId: string, runId: string) => handleRunDragStart(event, projectId, runId),
  );
  const sidebarOnReorderProjects = useStableCallback((projectIds: string[]) => void reorderProjects(projectIds));
  const sidebarOnAddRunToBookmarks = useStableCallback((_: string, runId: string) => void addRunToBookmarks(runId));
  const sidebarOnRemoveRunFromBookmarks = useStableCallback((runId: string) => void removeRunFromBookmarks(runId));
  const sidebarOnContinueRun = useStableCallback((projectId: string, runId: string) => {
    const project = snapshot.projects.find((p) => p.project.id === projectId);
    const run = [...(project?.runs ?? []), ...(project?.forLaterRuns ?? [])].find((candidate) => candidate.id === runId);
    if (run) {
      openContinueRunDialog(run);
    }
  });
  const sidebarOnDeleteRun = useStableCallback((projectId: string, runId: string) => {
    const project = snapshot.projects.find((p) => p.project.id === projectId);
    const run = project?.runs.find((r) => r.id === runId);
    if (run) {
      void deleteRun(run);
    }
  });
  const sidebarOnSetRunForLater = useStableCallback((_: string, runId: string) => void setRunForLater(runId));
  const sidebarOnOpenSettings = useStableCallback(() => openSettingsPage());
  const sidebarOnWidthCommit = useStableCallback((width: number) => persistSidebarWidth(width));
  const sidebarOnToggleCollapsed = useStableCallback(() => setSidebarCollapsed((current) => !current));
  const projectPageOnOpenProjectSettings = useStableCallback(() => {
    if (!selectedProject) {
      return;
    }
    void handleProjectFeatureSelect(selectedProject.project.id, "settings");
  });
  const renderSettingsContent = (): ReactNode => (
            <SettingsPage
              busy={busy}
              projects={snapshot.projects}
              projectName={projectName}
              projectPath={projectPath}
              projectFolderGitWarning={projectFolderGitWarning}
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
              cursorBinaryPath={cursorBinaryPath}
              cursorApiEndpoint={cursorApiEndpoint}
              detectedCursorBinaryPath={detectedCursorBinaryPath}
              detectedCursorMessage={detectedCursorMessage}
              providerBaseUrl={providerBaseUrl}
              providerConfigJson={providerConfigJson}
              providerAzureApiVersion={providerAzureApiVersion}
              selectedProviderId={selectedProviderId}
              modelId={modelId}
              modelDisplayName={modelDisplayName}
              modelBaseUrl={modelBaseUrl}
              autoCheckoutRunBranchOnOpen={autoCheckoutRunBranchOnOpen}
              autoReleaseRunBranchOnLeave={autoReleaseRunBranchOnLeave}
              dataRetentionCleanupEnabled={dataRetentionCleanupEnabled}
              dataRetentionCleanupDays={dataRetentionCleanupDays}
              pastedTextAttachmentThreshold={pastedTextAttachmentThreshold}
              consecutiveToolCallCollapseThreshold={consecutiveToolCallCollapseThreshold}
              recentRunDays={recentRunDays}
              designScheme={designScheme}
              sidebarContrastStrength={sidebarContrastStrength}
              sidebarRunEntrySize={sidebarRunEntrySize}
              sidebarGroupRunsByProject={sidebarGroupRunsByProject}
              enableDevMode={snapshot.settings[APP_SETTING_KEYS.enableDevMode] === "true"}
              appLogDirPath={appLogDirPath}
              appLogDirectorySize={appLogDirectorySize}
              networkProxySettings={networkProxySettings}
              remoteAccessEnabled={parseRemoteAccessEnabledSetting(snapshot.settings[APP_SETTING_KEYS.remoteAccessEnabled])}
              providerAccounts={snapshot.providerAccounts}
              models={snapshot.models}
              orchestrationTeamSetting={snapshot.settings[APP_SETTING_KEYS.orchestrationTeam] ?? ""}
              availableModelsByProviderId={availableModelsByProviderId}
              onBack={handleSettingsBack}
              onChooseDirectory={() => void chooseDirectory()}
              onPickDirectory={pickDirectory}
              onSubmitProject={() => void submitProject()}
              onSubmitProvider={() => void submitProvider()}
              onSubmitModel={() => void submitModel()}
              onEnsureAvailableModels={ensureAvailableModels}
              onDeleteProject={(projectId) => void deleteProject(projectId)}
              onDeleteProviderAccount={(providerAccountId) => void deleteProviderAccount(providerAccountId)}
              onDeleteModel={(modelId) => void deleteModel(modelId)}
              onAutoCheckoutRunBranchOnOpenChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, value)}
              onAutoReleaseRunBranchOnLeaveChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, value)}
              onDataRetentionCleanupEnabledChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.dataRetentionCleanupEnabled, value)}
              onDataRetentionCleanupDaysChange={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) throw new Error("The Electron desktop bridge is unavailable.");
                  await buildwarden.setAppSetting(
                    APP_SETTING_KEYS.dataRetentionCleanupDays,
                    String(parseDataRetentionCleanupDaysSetting(value)),
                  );
                  await loadSnapshot();
                })
              }
              onPastedTextAttachmentThresholdChange={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) throw new Error("The Electron desktop bridge is unavailable.");
                  await buildwarden.setAppSetting(
                    APP_SETTING_KEYS.pastedTextAttachmentThreshold,
                    String(parsePastedTextAttachmentThresholdSetting(value)),
                  );
                  await loadSnapshot();
                })
              }
              onConsecutiveToolCallCollapseThresholdChange={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) throw new Error("The Electron desktop bridge is unavailable.");
                  await buildwarden.setAppSetting(
                    APP_SETTING_KEYS.consecutiveToolCallCollapseThreshold,
                    String(parseConsecutiveToolCallCollapseThresholdSetting(value)),
                  );
                  await loadSnapshot();
                })
              }
              onRecentRunDaysChange={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.recentRunDays, String(parseRecentRunDaysSetting(value)));
                  await loadSnapshot();
                })
              }
              onDesignSchemeChange={(next: DesignScheme) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.designScheme, serializeDesignScheme(next));
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.uiTheme, next.mode);
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next.mode));
                  await loadSnapshot();
                })
              }
              onSidebarContrastStrengthChange={setSidebarContrastStrength}
              onSidebarContrastStrengthCommit={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) throw new Error("The Electron desktop bridge is unavailable.");
                  const next = parseSidebarContrastStrengthSetting(value);
                  setSidebarContrastStrength(next);
                  try {
                    await buildwarden.setAppSetting(APP_SETTING_KEYS.sidebarContrast, String(next));
                  } catch (caught) {
                    setSidebarContrastStrength(persistedSidebarContrastStrength);
                    throw caught;
                  }
                  await loadSnapshot();
                })
              }
              onSidebarRunEntrySizeChange={(value: SidebarRunEntrySize) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.sidebarRunEntrySize, value);
                  await loadSnapshot();
                })
              }
              onSidebarGroupRunsByProjectChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.sidebarGroupRunsByProject, value)}
              worktreeRootOverrideSettingValue={snapshot.settings[APP_SETTING_KEYS.worktreeRootOverride] ?? ""}
              onSaveWorktreeRootOverride={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.worktreeRootOverride, value);
                  await loadSnapshot();
                })
              }
              onEnableDevModeChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.enableDevMode, value)}
              onProjectNameChange={setProjectName}
              onProjectPathChange={setProjectPath}
              onProviderLabelChange={setProviderLabel}
              onProviderTypeChange={setProviderType}
              onProviderFamilyChange={setProviderFamily}
              onApiKeyChange={setApiKey}
              onCodexBinaryPathChange={setCodexBinaryPath}
              onCodexHomePathChange={setCodexHomePath}
              onClaudeBinaryPathChange={setClaudeBinaryPath}
              onClaudeLaunchArgsChange={setClaudeLaunchArgs}
              onCursorBinaryPathChange={setCursorBinaryPath}
              onCursorApiEndpointChange={setCursorApiEndpoint}
              onProviderBaseUrlChange={setProviderBaseUrl}
              onProviderConfigJsonChange={setProviderConfigJson}
              onProviderAzureApiVersionChange={setProviderAzureApiVersion}
              onSelectedProviderIdChange={setSelectedProviderId}
              onModelIdChange={setModelId}
              onModelDisplayNameChange={setModelDisplayName}
              onModelBaseUrlChange={setModelBaseUrl}
              keyboardShortcuts={keyboardShortcuts}
              onKeyboardShortcutChange={(id, value) => void updateKeyboardShortcut(id, value)}
              builtInShellAllowlistPatterns={DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES}
              shellAllowlistExtraText={shellAllowlistExtraText}
              onShellAllowlistExtraSave={(text: string) => void updateShellAllowlistExtra(text)}
              onResetDatabase={() => {
                void buildwarden?.resetDatabase();
              }}
              onSaveNetworkProxySettings={async (input) => {
                if (!buildwarden) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                const saved = await buildwarden.saveNetworkProxySettings(input);
                setNetworkProxySettings(saved);
                await loadSnapshot();
                return saved;
              }}
              onRemoteAccessEnabledChange={async (enabled) => {
                if (!buildwarden) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                await buildwarden.setAppSetting(APP_SETTING_KEYS.remoteAccessEnabled, String(enabled));
                await loadSnapshot();
              }}
              onCreateRemoteAccessPairing={(input) => {
                if (!buildwarden) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                return buildwarden.createRemoteAccessPairing(input);
              }}
              onListRemoteAccessSessions={() => {
                if (!buildwarden) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                return buildwarden.listRemoteAccessSessions();
              }}
              onRevokeRemoteAccessSession={async (sessionId) => {
                if (!buildwarden) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                await buildwarden.revokeRemoteAccessSession(sessionId);
              }}
              onOpenAppLogDirectory={() =>
                void handleAction(async () => {
                  if (!buildwarden || !appLogDirPath) {
                    throw new Error("The app log directory is unavailable.");
                  }
                  const result = await buildwarden.openPathInFileManager(appLogDirPath);
                  if (!result.ok) {
                    throw new Error(result.error || "Could not open log directory.");
                  }
                })
              }
              idePathsSettingValue={snapshot.settings[APP_SETTING_KEYS.idePaths] ?? ""}
              onSaveIdePaths={(serialized) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.idePaths, serialized);
                  await loadSnapshot();
                })
              }
              onPickIdeExecutable={async () => (buildwarden ? buildwarden.pickIdeExecutable() : null)}
              integratedSkills={integratedSkillsCatalog}
              globallyDisabledIntegratedSkillIds={globallyDisabledIntegratedSkillIds}
              onGloballyDisabledIntegratedSkillIdsChange={(skillIds) => void updateGloballyDisabledIntegratedSkills(skillIds)}
              onSaveOrchestrationTeam={(serialized) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The BuildWarden bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.orchestrationTeam, serialized);
                  await loadSnapshot();
                })
              }
            />
  );

  const renderAllRunsContent = (): ReactNode => (
    <AllRunsPage
      projects={snapshot.projects}
      providerAccounts={snapshot.providerAccounts}
      onSelectRun={(projectId, runId) => void handleRunSelect(projectId, runId)}
      onDeleteRuns={buildwarden.capabilities.runMutations ? deleteRuns : undefined}
    />
  );

  const renderLandingContent = (): ReactNode => (
    <LandingPage
      snapshot={snapshot}
      sessionJoke={landingPageJoke}
      onSelectProject={(projectId) => void handleProjectSelect(projectId)}
      onSelectRun={(projectId, runId) => void handleRunSelect(projectId, runId)}
      onOpenChats={handleChatsSelect}
      onOpenSettings={openSettingsPage}
    />
  );

  const renderMainContent = (): ReactNode => {
    if (settingsOpen) {
      return renderSettingsContent();
    }
    if (bookmarksSelected) {
      return renderBookmarksContent();
    }
    if (chatsSelected) {
      return renderChatsContent();
    }
    if (allRunsSelected) {
      return renderAllRunsContent();
    }
    if (onLandingOrEmptySelection) {
      return renderLandingContent();
    }
    return renderRunWorkspaceContent();
  };

  const renderBookmarksContent = (): ReactNode => {
    if (selectedBookmark) {
              return "originalChatId" in selectedBookmark ? (
              <ChatBookmarkDetailPage
                bookmark={selectedBookmark}
                models={snapshot.models}
                onBack={() => setSelectedBookmark(null)}
              />
            ) : (
              <BookmarkDetailPage
                bookmark={selectedBookmark}
                models={snapshot.models}
                onBack={() => setSelectedBookmark(null)}
              />
            );
            }
              return (
            <BookmarksPage
              onSelectBookmark={(bookmark) => setSelectedBookmark(bookmark)}
              onRemoveRunBookmarkById={(bookmarkId) => void removeBookmarkById(bookmarkId)}
              onRemoveChatBookmarkById={(bookmarkId) => void removeChatBookmarkById(bookmarkId)}
            />
              );
  };

  const renderChatsContent = (): ReactNode => {
    if (selectedChat && chatDetail) {
              return (
            <ChatDetailPage
              chatDetail={chatDetail}
              modelOptions={configuredChatModelOptions}
              keyboardShortcuts={keyboardShortcuts}
              busy={busy}
              isBookmarked={snapshot.chatBookmarks.some((b) => b.originalChatId === selectedChat.id)}
              onBack={() => {
                setSelectedChat(null);
                setChatDetail(null);
              }}
              onFollowUp={(input) =>
                void followUpChat(selectedChat.id, input.prompt, {
                  modelId: input.modelId,
                  attachments: input.attachments,
                  reasoningEffort: input.reasoningEffort,
                  anthropicEffort: input.anthropicEffort,
                  executionOptions: input.executionOptions,
                })
              }
              onCancel={() => void cancelChat(selectedChat.id)}
              onAddBookmark={async () => {
                await buildwarden?.addChatBookmark(selectedChat.id);
                await loadSnapshot();
              }}
              onRemoveBookmark={async () => {
                await buildwarden?.removeChatBookmark(selectedChat.id);
                await loadSnapshot();
              }}
            />
              );
            }
              return (
            <ChatPage
              modelOptions={configuredChatModelOptions}
              defaultModelId={configuredChatModelOptions.some((option) => option.id === runModelId) ? runModelId : (configuredChatModelOptions[0]?.id ?? "")}
              submitShortcut={keyboardShortcuts.submitComposer}
              onSelectChat={(chat) => void handleChatSelect(chat)}
              onCreateChat={(input) => void createChat(input)}
              reasoningEffort={chatReasoningEffort}
              anthropicEffort={chatAnthropicEffort}
              onReasoningEffortChange={setChatReasoningEffort}
              onAnthropicEffortChange={setChatAnthropicEffort}
              executionMode={chatExecutionMode}
              onExecutionModeChange={setChatExecutionMode}
              onDeleteChat={(chatId) => void deleteChat(chatId)}
            />
              );
  };

  const renderSelectedRunDetailPage = (detail: RunDetail): ReactNode => (
            <RunDetailPage
              className="min-h-0 min-w-0 flex-1"
              runDetail={detail}
              busy={busy}
              modelOptions={configuredRunModelOptions}
              keyboardShortcuts={keyboardShortcuts}
              pendingShellApproval={null}
              timelineDensity={runTimelineDensity}
              tokenUsage={selectedRunTokenUsage}
              subagentFocus={subagentFocusRequest?.runId === detail.run.id ? subagentFocusRequest : null}
              showActivity={runWorkspacePanelVisibility.activity}
              showAgents={runWorkspacePanelVisibility.agents}
              showDiff={runWorkspacePanelVisibility.diff}
              showTerminal={runWorkspacePanelVisibility.terminal}
              showBrowser={runWorkspacePanelVisibility.browser}
              showNotes={runWorkspacePanelVisibility.notes}
              showChat={runWorkspacePanelVisibility.chat}
              showPullRequest={runWorkspacePanelVisibility["pull-request"]}
              onRequestDiff={loadDiffForOpenRun}
              onLoadEarlierHistory={loadEarlierRunHistory}
              onTogglePanel={toggleSelectedRunWorkspacePanel}
              secondaryPanelPosition={runWorkspaceSecondaryPosition}
              onSecondaryPanelPositionChange={(position) => {
                if (!detail.run.id) return;
                setRunWorkspaceSecondaryPosition(position);
                updateRunWorkspaceLayout(detail.run.id, (current) => ({
                  ...current,
                  secondaryPanelPosition: position,
                }));
              }}
              tileOrder={selectedRunWorkspaceLayout.tileOrder}
              tileLayout={selectedRunWorkspaceLayout.tileLayout}
              onTileOrderChange={(next) => {
                if (!detail.run.id) {
                  return;
                }
                updateRunWorkspaceLayout(detail.run.id, (current) => ({
                  ...current,
                  tileOrder: next,
                }));
              }}
              onTileLayoutChange={(next) => {
                if (!detail.run.id) {
                  return;
                }
                updateRunWorkspaceLayout(detail.run.id, (current) => ({
                  ...current,
                  tileLayout: next,
                }));
              }}
              browserSession={runBrowserSessions[detail.run.id] ?? DEFAULT_RUN_BROWSER_SESSION}
              terminalOpenLinksInApp={runTerminalOpenLinksInApp[detail.run.id] !== false}
              onTerminalOpenLinksInAppChange={(enabled) =>
                setRunTerminalOpenLinksInApp((current) => ({
                  ...current,
                  [detail.run.id]: enabled,
                }))
              }
              onBrowserSessionChange={(session) =>
                setRunBrowserSessions((current) => ({
                  ...current,
                  [detail.run.id]: session,
                }))
              }
              onOpenBrowserUrl={openSelectedRunBrowserUrl}
              onRespondToShellApproval={(decision) => respondToPendingShellApproval(decision)}
              onCancelRunShell={(run, toolCallId) => void cancelRunShell(run, toolCallId)}
              onCancelRun={(run) => void cancelRun(run)}
              onUndoRunToLastPrompt={(run) => void undoRunToLastPrompt(run)}
              onRecoverInterruptedRun={(run) => void recoverInterruptedRun(run)}
              onCreateProjectTask={(projectId, input) => createProjectTask(projectId, input)}
              onOpenChildRun={(childRunId) => void handleRunSelect(detail.run.projectId, childRunId)}
              onReviewChildRun={(childRunId) => reviewChildRun(detail.run.projectId, childRunId)}
              onFollowUpRun={(run, prompt, options) => followUpRun(run, prompt, options)}
            />
  );

  const renderSelectedProjectPage = (project: ProjectSnapshot): ReactNode => (
            <ProjectPage
              project={project}
              activeTab={projectPageTab}
              modelOptions={configuredRunModelOptions}
              configuredIdeKinds={configuredIdeKinds}
              availableBranches={availableRunBranches}
              currentProjectBranch={currentProjectBranch}
              runPrompt={runPrompt}
              runMode={runMode}
              runWorkspaceType={runWorkspaceType}
              runBaseBranch={runBaseBranch}
              runModelId={runModelId}
              runWorktreeModelIds={runWorktreeModelIds}
              runModelConfigurations={runModelConfigurations}
              submitShortcut={keyboardShortcuts.submitComposer}
              projectRunStats={projectRunStats}
              busy={busy}
              onSubmitRun={(payload) => void submitRun(payload)}
              onCreateTask={(input) => createProjectTask(project.project.id, input)}
              onUpdateTask={(taskId, input) => updateProjectTask(taskId, input)}
              onDeleteTask={(taskId) => deleteProjectTask(taskId)}
              onAutomationsChanged={loadSnapshot}
              onStartTask={(taskId, prompt, modelId) => submitRunFromPrompt(prompt, modelId, taskId)}
              onGenerateInsight={(kind, modelId) => generateProjectInsight(project.project.id, kind, modelId)}
              onSetRunForLater={(runId) => void setRunForLater(runId)}
              onDeleteRuns={deleteRuns}
              onRestoreRunFromForLater={(runId) => void restoreRunFromForLater(runId)}
              reasoningEffort={runReasoningEffort}
              anthropicEffort={runAnthropicEffort}
              executionMode={runExecutionMode}
              yoloMode={runYoloMode}
              verificationCommands={runVerificationCommands}
              maxRunMinutes={runMaxMinutes}
              maxRunTokens={runMaxTokens}
              mcpServers={runMcpServers}
              delegationEnabled={runDelegationEnabled}
              delegationAvailable={delegationAvailable}
              onReasoningEffortChange={changeRunReasoningEffort}
              onAnthropicEffortChange={changeRunAnthropicEffort}
              onExecutionModeChange={changeRunExecutionMode}
              onYoloModeChange={changeRunYoloMode}
              onVerificationCommandsChange={changeRunVerificationCommands}
              onMaxRunMinutesChange={changeRunMaxMinutes}
              onMaxRunTokensChange={changeRunMaxTokens}
              onMcpServersChange={changeRunMcpServers}
              onDelegationEnabledChange={setRunDelegationEnabled}
              onSelectRun={(runId) => void handleRunSelect(project.project.id, runId)}
              onRunPromptChange={setRunPrompt}
              onRunModeChange={changeRunMode}
              onRunWorkspaceTypeChange={changeRunWorkspaceType}
              onRunBaseBranchChange={setRunBaseBranch}
              onProjectBaseBranchChange={(branchName) => updateProjectBaseBranch(project.project.id, branchName)}
              onRunModelChange={changeRunModel}
              onRunWorktreeModelIdsChange={changeRunWorktreeModelIds}
              onRunModelConfigurationsChange={changeRunModelConfigurations}
              availableIntegratedSkills={enabledIntegratedSkills}
              activeIntegratedSkillIds={projectActiveSkillsByProjectId[project.project.id] ?? []}
              onActiveIntegratedSkillIdsChange={(skillIds) => void updateProjectActiveSkills(project.project.id, skillIds)}
              labSettings={projectLabSettingsByProjectId[project.project.id] ?? buildDefaultProjectLabSettings()}
              onLabSettingsChange={(settings) => void updateProjectLabSettings(project.project.id, settings)}
              onRunProjectLab={(input) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.runProjectLab({
                    projectId: project.project.id,
                    mode: input.mode,
                    baseBranch: input.baseBranch,
                    implementationModelId: input.implementationModelId,
                    reviewModelId: input.reviewModelId,
                    origin: "manual",
                  });
                  await loadSnapshot();
                })
              }
              onDeleteProjectLabThread={(threadId) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.deleteProjectLabThread(threadId);
                  await loadSnapshot();
                })
              }
              onOpenProjectLabImplementation={(runId) => void handleRunSelect(project.project.id, runId)}
              loopAvailability={loopAvailabilityByProjectId[project.project.id] ?? null}
              onOpenLoopRun={(runId) => void handleRunSelect(project.project.id, runId)}
              onLoopsChanged={loadSnapshot}
              onBranchesChanged={loadProjectBranches}
              onDeleteProject={() => void deleteProject(project.project.id)}
              onOpenProjectSettings={projectPageOnOpenProjectSettings}
              reviewRequestTarget={reviewRequestTarget?.projectId === project.project.id ? reviewRequestTarget : null}
            />
  );

  const renderRunWorkspaceContent = (): ReactNode => {
            const workspaceWrapperClassName =
              isAgentRunDetailView || isProjectWorkspaceView ? "flex min-h-0 min-w-0 flex-1 flex-col gap-1.5" : "contents";

            if (selectedRunId && openRunPaneCount > 0) {
              return (
            <div className={workspaceWrapperClassName}>
                <div
                  className={cn(
                    "min-h-0 min-w-0 flex-1 gap-2",
                    isSplitRunView || runPaneDropPreview ? "grid grid-cols-1 xl:grid-cols-2" : "flex flex-col",
                  )}
                  onDragOver={handleRunPaneDragOver}
                  onDragLeave={handleRunPaneDragLeave}
                  onDrop={(event) => handleRunDropOnPane(event)}
                >
                  {(runPaneDropPreview ? RUN_PANE_IDS : openRunPaneDetails.map((entry) => entry.paneId)).map((paneId) => {
                    const entry = openRunPaneDetails.find((candidate) => candidate.paneId === paneId);
                    if (entry) {
                      return renderRunPane(entry);
                    }
                    if (runPaneDropPreview === paneId) {
                      return renderRunPaneDropPreviewTile(paneId);
                    }
                    return null;
                  })}
                </div>
            </div>
              );
            }

            const workspaceHeader = selectedRun ? (
                <RunDetailHeader
                  run={selectedRun}
                  runDetail={runDetail}
                  tokenUsage={selectedRunTokenUsage}
                  busy={busy}
                  pendingDelete={Boolean(pendingDeleteRunIds[selectedRun.id])}
                  configuredIdeKinds={configuredIdeKinds}
                  canContinueRun={isRunContinuable(selectedRun)}
                  runTimelineDensity={runTimelineDensity}
                  onRunTimelineDensityChange={updateRunTimelineDensity}
                  runDensityMenuOpen={runDensityMenuOpen}
                  setRunDensityMenuOpen={setRunDensityMenuOpen}
                  runDensityMenuAnchorRef={runDensityMenuAnchorRef}
                  runPanelToggleItems={runPanelToggleItems}
                  runWorkspaceVisiblePanelCount={runWorkspaceVisiblePanelCount}
                  runPanelsMenuOpen={runPanelsMenuOpen}
                  setRunPanelsMenuOpen={setRunPanelsMenuOpen}
                  runPanelsMenuAnchorRef={runPanelsMenuAnchorRef}
                  publishMenuOpen={publishMenuOpen}
                  setPublishMenuOpen={setPublishMenuOpen}
                  publishMenuAnchorRef={publishMenuAnchorRef}
                  onCommitRun={commitRun}
                  onRequestDiffSummary={loadDiffSummaryForOpenRun}
                  onOpenPublishDialog={openPublishDialog}
                  onOpenBranchPublishDialog={openBranchPublishDialog}
                  onOpenInIde={openRunDetailInIde}
                  onOpenFileManager={openRunDetailInFileManager}
                  onOpenContinueRunDialog={openContinueRunDialog}
                  onDeleteRun={deleteRun}
                  onFocusSubagent={(subagentId) => setSubagentFocusRequest({ runId: selectedRun.id, subagentId, nonce: Date.now() })}
                />
            ) : null;
            const renderWorkspaceView = (content: ReactNode) => (
              <div className={workspaceWrapperClassName}>
                {workspaceHeader}
                {content}
              </div>
            );

            if (selectedRunId && runDetail?.run) {
              return renderWorkspaceView(
                renderSelectedRunDetailPage(runDetail),
              );
            }
            if (selectedRunId) {
              return renderWorkspaceView(
            <Card className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
              <Loader2 className="h-10 w-10 animate-spin text-[var(--ec-accent)]" />
              <p className="text-sm text-[var(--ec-muted)]">Loading run...</p>
            </Card>,
              );
            }
            if (selectedProject) {
              return renderWorkspaceView(
                renderSelectedProjectPage(selectedProject),
              );
            }
            return renderWorkspaceView(
                <Card className="p-8 text-center">
                  <p className="text-lg font-medium">No project selected</p>
                  <p className="mt-2 text-sm text-[var(--ec-muted)]">{readOnly ? "No projects are configured on the BuildWarden host." : "Open Settings to add your first project, provider, and model."}</p>
                  {!readOnly ? <Button
                    className="mt-4"
                    variant="secondary"
                    onClick={() => {
                      setAllRunsSelected(false);
                      setSettingsOpen(true);
                    }}
                  >
                    Open settings
                  </Button> : null}
                </Card>,
            );
  };

  if (startupDataRetentionState.status !== "ready") {
    const sidebarContrastStyle = { "--ec-sidebar-contrast-strength": `${sidebarContrastStrength}%` } as CSSProperties;
    return (
      <div
        className={cn(
          "app-shell flex h-screen min-h-0 flex-col overflow-hidden",
          uiTheme === "light" ? "theme-light" : "theme-dark",
          sidebarContrastStrength > 0 && "sidebar-contrast",
        )}
        style={sidebarContrastStyle}
      >
        {showCustomWindowsTitleBar ? (
          <AppTitleBar
            uiTheme={uiTheme}
            syncWindowsCaptionStrip
            onOpenMenu={(section, anchor) => void openAppMenuSection(section, anchor)}
          />
        ) : null}
        <main className="flex min-h-0 flex-1 items-center justify-center bg-[var(--ec-bg)] p-6 text-[var(--ec-text)]">
          <StartupDataRetentionDialog
            state={startupDataRetentionState}
            onConfirm={() => void confirmStartupDataRetentionCleanup()}
            onSkip={() => setStartupDataRetentionState({ status: "ready" })}
            onRetry={() => void checkStartupDataRetention()}
          />
        </main>
      </div>
    );
  }

  if (startupAutomationState.status !== "ready") {
    return (
      <div
        className={cn("app-shell flex h-screen min-h-0 flex-col overflow-hidden", uiTheme === "light" ? "theme-light" : "theme-dark", sidebarContrastStrength > 0 && "sidebar-contrast")}
        style={{ "--ec-sidebar-contrast-strength": `${sidebarContrastStrength}%` } as CSSProperties}
      >
        {showCustomWindowsTitleBar ? <AppTitleBar uiTheme={uiTheme} syncWindowsCaptionStrip onOpenMenu={(section, anchor) => void openAppMenuSection(section, anchor)} /> : null}
        <main className="flex min-h-0 flex-1 items-center justify-center bg-[var(--ec-bg)] p-6 text-[var(--ec-text)]">
          <StartupAutomationDialog
            state={startupAutomationState}
            onConfirm={() => void resolveStartupAutomations(true)}
            onSkip={() => void resolveStartupAutomations(false)}
            onRetry={() => void checkStartupAutomations()}
          />
        </main>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "app-shell flex h-screen min-h-0 flex-col overflow-hidden",
        uiTheme === "light" ? "theme-light" : "theme-dark",
        sidebarContrastStrength > 0 && "sidebar-contrast",
      )}
      style={{ "--ec-sidebar-contrast-strength": `${sidebarContrastStrength}%` } as CSSProperties}
    >
      {showCustomWindowsTitleBar ? (
        <AppTitleBar
          uiTheme={uiTheme}
          syncWindowsCaptionStrip
          onOpenMenu={(section, anchor) => void openAppMenuSection(section, anchor)}
        />
      ) : null}

      <div className="flex min-h-0 flex-1 text-[var(--ec-text)]">
        <CommandPalette
          open={commandPaletteOpen}
          items={commandPaletteItems}
          onClose={() => setCommandPaletteOpen(false)}
        />
        <Sidebar
        projects={snapshot.projects}
        providerAccounts={snapshot.providerAccounts}
        landingSelected={landingSelected}
        allRunsSelected={allRunsSelected}
        bookmarksSelected={bookmarksSelected}
        chatsSelected={chatsSelected}
        settingsSelected={settingsOpen}
        selectedProjectId={selectedProject?.project.id ?? null}
        currentProjectBranch={currentProjectBranch}
        currentProjectBranchStatus={currentProjectBranchStatus}
        projectView={projectPageTab}
        highlightedRunId={
          !landingSelected && !allRunsSelected && !bookmarksSelected && !chatsSelected && !settingsOpen && typeof selectedRunId === "string" ? selectedRunId : null
        }
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        recentRunDays={recentRunDays}
        runEntrySize={sidebarRunEntrySize}
        groupRunsByProject={sidebarGroupRunsByProject}
        bookmarksCount={snapshot.bookmarks.length + snapshot.chatBookmarks.length}
        chatsCount={snapshot.chats.length}
        bookmarkedRunIds={sidebarBookmarkedRunIds}
        onSelectLanding={sidebarOnSelectLanding}
        onSelectAllRuns={sidebarOnSelectAllRuns}
        onSelectBookmarks={sidebarOnSelectBookmarks}
        onSelectChats={sidebarOnSelectChats}
        onSelectProject={sidebarOnSelectProject}
        onSelectProjectFeature={sidebarOnSelectProjectFeature}
        onSelectRun={sidebarOnSelectRun}
        onRunDragStart={sidebarOnRunDragStart}
        onReorderProjects={sidebarOnReorderProjects}
        onAddRunToBookmarks={sidebarOnAddRunToBookmarks}
        onRemoveRunFromBookmarks={sidebarOnRemoveRunFromBookmarks}
        onContinueRun={sidebarOnContinueRun}
        onDeleteRun={sidebarOnDeleteRun}
        onSetRunForLater={sidebarOnSetRunForLater}
        pendingDeleteRunIds={pendingDeleteRunIds}
        onOpenSettings={sidebarOnOpenSettings}
        onWidthCommit={sidebarOnWidthCommit}
        onToggleCollapsed={sidebarOnToggleCollapsed}
        loopEnabledProjectIds={loopEnabledProjectIds}
      />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ec-bg)]">
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 p-2 sm:p-3",
            isAgentRunDetailView || isChatDetailView || isBookmarkDetailView || isProjectWorkspaceView
              ? "flex min-h-0 flex-col overflow-hidden"
              : "overflow-y-auto",
          )}
        >
        <section className={cn("w-full", sectionLayoutClassName)}>
          <Suspense
            fallback={
              <div className="flex min-h-[200px] flex-1 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ec-accent)]" />
              </div>
            }
          >
          <RunToolCallCollapseThresholdProvider threshold={consecutiveToolCallCollapseThreshold}>
            <PastedTextAttachmentThresholdProvider threshold={pastedTextAttachmentThreshold}>
              {renderMainContent()}
            </PastedTextAttachmentThresholdProvider>
          </RunToolCallCollapseThresholdProvider>

          </Suspense>
        </section>
        </main>
        </div>
      </div>

      {welcomeOpen ? (
        <WelcomeDialog
          stepKey={welcomeStepKey}
          stepIndex={Math.min(welcomeStepIndex, welcomeStepKeys.length - 1)}
          steps={welcomeStepKeys}
          completedCheckIds={welcomeKnownCompletedCheckIds}
          skippedCheckIds={welcomeSkippedCheckIds}
          providerModelsOpenPanel={welcomeProviderModelsOpenPanel}
          onProviderModelsOpenPanelChange={setWelcomeProviderModelsOpenPanel}
          onBack={handleWelcomeBack}
          onNext={handleWelcomeNext}
          onSkipCheck={handleWelcomeSkipCheck}
          onFinish={handleWelcomeFinish}
          providerModelsProps={{
            busy,
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
            cursorBinaryPath,
            cursorApiEndpoint,
            detectedCursorBinaryPath,
            detectedCursorMessage,
            providerBaseUrl,
            providerConfigJson,
            providerAzureApiVersion,
            selectedProviderId,
            modelId,
            modelDisplayName,
            modelBaseUrl,
            providerAccounts: snapshot.providerAccounts,
            models: snapshot.models,
            openAiPresetUserChoseCustom: welcomeOpenAiPresetUserChoseCustom,
            openAiPresetsGrouped: openAiPresetsGroupedForSelectedProvider,
            availableModelsState: selectedProviderId ? availableModelsByProviderId[selectedProviderId] : undefined,
            onSubmitProvider: () => void submitProvider(),
            onSubmitModel: () => void submitModel(),
            onEnsureAvailableModels: ensureAvailableModels,
            onDeleteProviderAccount: (providerAccountId) => void deleteProviderAccount(providerAccountId),
            onDeleteModel: (modelId) => void deleteModel(modelId),
            onProviderLabelChange: setProviderLabel,
            onProviderTypeChange: setProviderType,
            onProviderFamilyChange: setProviderFamily,
            onApiKeyChange: setApiKey,
            onCodexBinaryPathChange: setCodexBinaryPath,
            onCodexHomePathChange: setCodexHomePath,
            onClaudeBinaryPathChange: setClaudeBinaryPath,
            onClaudeLaunchArgsChange: setClaudeLaunchArgs,
            onCursorBinaryPathChange: setCursorBinaryPath,
            onCursorApiEndpointChange: setCursorApiEndpoint,
            onProviderBaseUrlChange: setProviderBaseUrl,
            onProviderConfigJsonChange: setProviderConfigJson,
            onProviderAzureApiVersionChange: setProviderAzureApiVersion,
            onSelectedProviderIdChange: setSelectedProviderId,
            onModelIdChange: setModelId,
            onModelDisplayNameChange: setModelDisplayName,
            onModelBaseUrlChange: setModelBaseUrl,
            onSetOpenAiPresetUserChoseCustom: setWelcomeOpenAiPresetUserChoseCustom,
          }}
          projectSetupProps={{
            busy,
            projectName,
            projectPath,
            projectFolderGitWarning,
            onChooseDirectory: () => void chooseDirectory(),
            onSubmitProject: () => void submitProject(),
            onProjectNameChange: setProjectName,
            onProjectPathChange: setProjectPath,
          }}
        />
      ) : null}

      <AppNotifications
        busy={busy}
        pendingDeleteRunCount={Object.keys(pendingDeleteRunIds).length}
        visibleShellApprovals={visibleShellApprovals}
        shellApprovalQueueLength={shellApprovalQueue.length}
        queuedShellApprovalCount={queuedShellApprovalCount}
        visibleShellApprovalStartedAtById={visibleShellApprovalStartedAtById}
        getShellApprovalTarget={getShellApprovalTarget}
        onOpenShellApprovalRun={(request) => void openShellApprovalRun(request)}
        onRespondToShellApproval={(request, decision) => void respondToShellApproval(request, decision)}
        error={error}
        selectedProjectName={selectedProject?.project.name ?? null}
        detachedCheckoutBranch={detachedCheckoutBranch}
        availableRunBranches={availableRunBranches}
        projectCheckoutBusy={projectCheckoutBusy}
        onDetachedCheckoutBranchChange={setDetachedCheckoutBranch}
        onSubmitCheckoutDetachedProjectBranch={() => void submitCheckoutDetachedProjectBranch()}
        onDismissError={() => {
          setError(null);
          setDetachedCheckoutBranch("");
        }}
        appWarning={appWarning}
        onDismissAppWarning={() => setAppWarning(null)}
        automationStartedToasts={automationStartedToasts}
        onDismissAutomationStartedToast={(runId) => setAutomationStartedToasts((current) => current.filter((toast) => toast.runId !== runId))}
        projectForgeRequestToasts={projectForgeRequestToasts}
        onOpenProjectForgeRequest={openProjectForgeRequest}
        onDismissProjectForgeRequestToast={dismissProjectForgeRequestToast}
      />

      <RunActionDialogs
        busy={busy}
        commitDialogRun={commitDialogRun}
        commitMessage={commitMessage}
        commitSuggestBusy={commitSuggestBusy}
        onCommitMessageChange={setCommitMessage}
        onCommitDialogKeyDown={handleCommitDialogKeyDown}
        onSuggestCommitMessage={() => void suggestCommitMessageWithAi()}
        onSubmitCommitRun={() => void submitCommitRun()}
        onCloseCommitDialog={closeCommitDialog}
        publishDialogRun={publishDialogRun}
        publishOptions={publishOptions}
        pullRequestSourceBranchMode={pullRequestSourceBranchMode}
        pullRequestSourceBranchName={pullRequestSourceBranchName}
        pullRequestTargetBranch={pullRequestTargetBranch}
        pullRequestTitle={pullRequestTitle}
        pullRequestCommitMessage={pullRequestCommitMessage}
        pullRequestDescription={pullRequestDescription}
        pullRequestDraftBusy={pullRequestDraftBusy}
        onPullRequestSourceBranchModeChange={setPullRequestSourceBranchMode}
        onPullRequestSourceBranchNameChange={setPullRequestSourceBranchName}
        onPullRequestTargetBranchChange={setPullRequestTargetBranch}
        onPullRequestTitleChange={setPullRequestTitle}
        onPullRequestCommitMessageChange={setPullRequestCommitMessage}
        onPullRequestDescriptionChange={setPullRequestDescription}
        onPublishDialogKeyDown={handlePublishDialogKeyDown}
        onGeneratePullRequestDraft={() => void generatePullRequestDraft()}
        onSubmitPullRequest={() => void submitPullRequest()}
        onClosePublishDialog={closePublishDialog}
        branchPublishDialogRun={branchPublishDialogRun}
        branchPublishName={branchPublishName}
        branchPublishMode={branchPublishMode}
        branchSuggestBusy={branchSuggestBusy}
        onBranchPublishNameChange={setBranchPublishName}
        onBranchPublishDialogKeyDown={handleBranchPublishDialogKeyDown}
        onSuggestBranchName={() => void suggestBranchNameWithAi()}
        onPublishBranch={() => void publishBranch()}
        onCloseBranchPublishDialog={closeBranchPublishDialog}
        continueDialogRun={continueDialogRun}
        continuePrompt={continuePrompt}
        continueModelId={continueModelId}
        continueIncludeWorkspaceChanges={continueIncludeWorkspaceChanges}
        continueModelOptions={configuredRunModelOptions}
        onContinuePromptChange={setContinuePrompt}
        onContinueModelIdChange={setContinueModelId}
        onContinueIncludeWorkspaceChangesChange={setContinueIncludeWorkspaceChanges}
        onSubmitContinueRun={() => void submitContinueRun()}
        onCloseContinueRunDialog={closeContinueRunDialog}
        confirmDialog={confirmDialog}
        onResolveConfirmation={resolveConfirmation}
      />

    </div>
  );
};
