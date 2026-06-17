import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import {
  APP_SETTING_KEYS,
  cycleUiTheme,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  buildDefaultProjectLabSettings,
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  isDetachedHeadProjectErrorMessage,
  getAiSdkProviderFamilyFromConfigJson,
  DEFAULT_ADD_MODEL_DRAFT,
  DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES,
  parseIntegratedSkillsDisabledSetting,
  parseProjectLabSettingsSetting,
  parseProjectActiveSkillsSetting,
  parseRecentRunDaysSetting,
  parseRunTimelineDensitySetting,
  parseRunWorkspaceLayoutsSetting,
  parseWelcomeCompletedCheckIdsSetting,
  parseUiTheme,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CODEX_HOME_PATH_KEY,
  serializeWelcomeCompletedCheckIdsSetting,
  SUPPORTED_IDE_KINDS,
  parseIdePathConfig,
  parseShellAllowlistExtraSetting,
  type AppMenuSection,
  type AppSnapshot,
  type AppWarning,
  type ChatAttachmentPayload,
  type ChatDetail,
  type ChatRecord,
  type ContinueRunInput,
  type ProjectLabSettings,
  type KeyboardShortcutId,
  type NetworkProxySettingsSnapshot,
  type ProjectFolderGitStatus,
  type ProjectForgeRequestOpenPayload,
  type ProjectSnapshot,
  type ProjectInsightKind,
  type ProviderType,
  type RunDetail,
  type RunMode,
  type RunPublishOptions,
  type RunRecord,
  type RunTokenUsage,
  type RunTimelineDensity,
  type RunWorkspaceLayoutPreference,
  type RunWorkspaceLayoutPreferencesByRunId,
  type RunWorkspacePanelId,
  type RunWorkspaceType,
  type ShellApprovalDecision,
  type SupportedIdeKind,
  type IntegratedSkillMetadata,
  type UiTheme,
  type UnifiedProviderFamily,
  uiThemeToLegacyDarkMode,
} from "@buildwarden/shared";
import {
  Bot,
  Bookmark,
  Command as CommandIcon,
  FolderOpen,
  Globe,
  GitBranch,
  GitPullRequest,
  Home,
  Loader2,
  MessageSquareText,
  Settings,
  Sparkles,
  SquareTerminal,
  StickyNote,
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
  buildRunReasoningInput,
  cloneDefaultRunWorkspaceLayoutPreference,
  eventToKeyString,
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
  resolveProviderComposerPrompt,
  runIdIsOpenInPanes,
  type ConfirmDialogState,
  type OpenRunPanes,
  type RunBrowserSessionState,
  type RunDragPayload,
  type RunPaneId,
} from "./components/app/app-model";
import {
  AppNotifications,
  type ProjectForgeRequestToast,
  type ShellApprovalRequestState,
} from "./components/app/AppNotifications";
import { RunActionDialogs } from "./components/app/RunActionDialogs";
import { RunDetailHeader, RunPaneDropPreviewOverlay } from "./components/app/RunDetailHeader";
const RunDetailPage = lazy(() => import("./components/app/RunDetailPage").then((m) => ({ default: m.RunDetailPage })));
const SettingsPage = lazy(() => import("./components/app/SettingsPage").then((m) => ({ default: m.SettingsPage })));
import { Sidebar } from "./components/app/Sidebar";
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth, parseSidebarWidthSetting } from "./components/app/sidebar-width";
import { WelcomeDialog, type WelcomeStepKey } from "./components/app/WelcomeDialog";
import {
  WELCOME_CHECK_DEFINITIONS,
  getSatisfiedWelcomeCheckIds,
  orderWelcomeCheckIds,
  type WelcomeCheckId,
} from "./components/app/welcome-checks";
import type { ProviderModelsOpenPanel } from "./components/app/settings-provider-models-tab";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { cn } from "./lib/cn";
import {
  emptyModelPresetsByGroup,
  getModelPresetsByGroupForProvider,
  getModelPresetsForProvider,
} from "./lib/openai-model-presets";
import type { AvailableProviderModelsState } from "./lib/available-provider-models";
import { useStableCallback } from "./lib/use-stable-callback";
import { reportRendererError, reportRendererLog } from "./lib/report-renderer-error";

interface SettingsPreviousPageState {
  landingSelected: boolean;
  allRunsSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  projectPageTab: ProjectPageTab;
  selectedBookmark: BookmarkItem | null;
  selectedChat: ChatRecord | null;
  chatDetail: ChatDetail | null;
  selectedRunId: string | null | undefined;
  runDetail: RunDetail | null;
  openRunPanes: OpenRunPanes;
  focusedRunPane: RunPaneId;
  runDetailsById: Record<string, RunDetail>;
}

const formatRunWorkspaceLabel = (run: RunRecord): string => {
  if (run.workspaceVcs === "folder") {
    return run.workspaceType === "copy" ? "Folder copy" : "Project folder";
  }
  return run.branchName;
};

export const App = () => {
  const buildwarden = window.buildwarden;
  const showCustomWindowsTitleBar = typeof navigator !== "undefined" && navigator.platform.toLowerCase().startsWith("win");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomeFinishedForSession, setWelcomeFinishedForSession] = useState(false);
  const [welcomeStepIndex, setWelcomeStepIndex] = useState(0);
  const [welcomeSkippedCheckIds, setWelcomeSkippedCheckIds] = useState<WelcomeCheckId[]>([]);
  const [welcomeProviderModelsOpenPanel, setWelcomeProviderModelsOpenPanel] =
    useState<ProviderModelsOpenPanel>("connection");
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
  const [providerBaseUrl, setProviderBaseUrl] = useState("");
  const [providerConfigJson, setProviderConfigJson] = useState("{}");
  const [providerAzureApiVersion, setProviderAzureApiVersion] = useState("2024-06-01");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modelId, setModelId] = useState(() => DEFAULT_ADD_MODEL_DRAFT.modelId);
  const [modelDisplayName, setModelDisplayName] = useState(() => DEFAULT_ADD_MODEL_DRAFT.displayName);
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [welcomeOpenAiPresetUserChoseCustom, setWelcomeOpenAiPresetUserChoseCustom] = useState(false);
  const [availableModelsByProviderId, setAvailableModelsByProviderId] = useState<Record<string, AvailableProviderModelsState>>({});
  const availableModelsByProviderIdRef = useRef<Record<string, AvailableProviderModelsState>>({});
  const availableModelRequestsInFlightRef = useRef<Set<string>>(new Set());
  availableModelsByProviderIdRef.current = availableModelsByProviderId;
  const [runProjectId, setRunProjectId] = useState("");
  const [runModelId, setRunModelId] = useState("");
  const [runWorktreeModelIds, setRunWorktreeModelIds] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<RunMode>("code");
  const [runWorkspaceType, setRunWorkspaceType] = useState<RunWorkspaceType>("worktree");
  const [runBaseBranch, setRunBaseBranch] = useState("");
  const [currentProjectBranch, setCurrentProjectBranch] = useState("");
  const [availableRunBranches, setAvailableRunBranches] = useState<string[]>([]);
  const [detachedCheckoutBranch, setDetachedCheckoutBranch] = useState("");

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportRendererError("renderer.window.error", event.error ?? event.message, {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportRendererError("renderer.window.unhandledrejection", event.reason);
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);
  const [projectCheckoutBusy, setProjectCheckoutBusy] = useState(false);
  const [runPrompt, setRunPrompt] = useState("");
  const [runReasoningEffort, setRunReasoningEffort] = useState("medium");
  const [runAnthropicEffort, setRunAnthropicEffort] = useState("medium");
  const [runYoloMode, setRunYoloMode] = useState(false);
  const [chatReasoningEffort, setChatReasoningEffort] = useState("medium");
  const [chatAnthropicEffort, setChatAnthropicEffort] = useState("medium");
  const [selectedRunId, setSelectedRunId] = useState<string | null | undefined>(undefined);
  const selectedRunIdRef = useRef<string | null | undefined>(undefined);
  selectedRunIdRef.current = selectedRunId;
  const openRunPanesRef = useRef<OpenRunPanes>({});
  openRunPanesRef.current = openRunPanes;
  const runDetailsByIdRef = useRef<Record<string, RunDetail>>({});
  runDetailsByIdRef.current = runDetailsById;
  const diffRefreshTimersRef = useRef<Partial<Record<string, ReturnType<typeof setTimeout>>>>({});
  const runDetailLoadTokenRef = useRef<Record<string, number>>({});
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
  const dismissedGitConversionProjectIdsRef = useRef<Set<string>>(new Set());
  const gitConversionCheckInFlightRef = useRef<Set<string>>(new Set());
  const [reviewRequestTarget, setReviewRequestTarget] = useState<{
    projectId: string;
    url: string;
    requestId: number;
  } | null>(null);
  const [settingsPreviousPage, setSettingsPreviousPage] = useState<SettingsPreviousPageState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [landingPageJoke] = useState(() => pickRandomLandingJoke());
  const [commitDialogRun, setCommitDialogRun] = useState<RunRecord | null>(null);
  const [continueDialogRun, setContinueDialogRun] = useState<RunRecord | null>(null);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [continueModelId, setContinueModelId] = useState("");
  const [continueIncludeWorkspaceChanges, setContinueIncludeWorkspaceChanges] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitSuggestBusy, setCommitSuggestBusy] = useState(false);
  const [publishDialogRun, setPublishDialogRun] = useState<RunRecord | null>(null);
  const [publishOptions, setPublishOptions] = useState<RunPublishOptions | null>(null);
  const [branchPublishDialogRun, setBranchPublishDialogRun] = useState<RunRecord | null>(null);
  const [branchPublishName, setBranchPublishName] = useState("");
  const [branchPublishMode, setBranchPublishMode] = useState<"publish" | "local">("publish");
  const [pullRequestTitle, setPullRequestTitle] = useState("");
  const [pullRequestTargetBranch, setPullRequestTargetBranch] = useState("");
  const [pullRequestSourceBranchMode, setPullRequestSourceBranchMode] = useState<"worktree" | "custom">("worktree");
  const [pullRequestSourceBranchName, setPullRequestSourceBranchName] = useState("");
  const [pullRequestDescription, setPullRequestDescription] = useState("");
  const [pullRequestDescriptionBusy, setPullRequestDescriptionBusy] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [runPanelsMenuOpen, setRunPanelsMenuOpen] = useState(false);
  const [runDensityMenuOpen, setRunDensityMenuOpen] = useState(false);
  const publishMenuAnchorRef = useRef<HTMLDivElement>(null);
  const runPanelsMenuAnchorRef = useRef<HTMLDivElement>(null);
  const runDensityMenuAnchorRef = useRef<HTMLDivElement>(null);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [shellApprovalQueue, setShellApprovalQueue] = useState<ShellApprovalRequestState[]>([]);
  const [runWorkspaceShowActivity, setRunWorkspaceShowActivity] = useState(true);
  const [runWorkspaceShowDiff, setRunWorkspaceShowDiff] = useState(false);
  const [runWorkspaceShowTerminal, setRunWorkspaceShowTerminal] = useState(false);
  const [runWorkspaceShowBrowser, setRunWorkspaceShowBrowser] = useState(false);
  const [runWorkspaceShowNotes, setRunWorkspaceShowNotes] = useState(false);
  const [runWorkspaceSecondaryPosition, setRunWorkspaceSecondaryPosition] = useState<"right" | "bottom">("right");
  const [runWorkspaceLayoutsByRunId, setRunWorkspaceLayoutsByRunId] = useState<RunWorkspaceLayoutPreferencesByRunId>({});
  const [runBrowserSessions, setRunBrowserSessions] = useState<Record<string, RunBrowserSessionState>>({});
  const [runTerminalOpenLinksInApp, setRunTerminalOpenLinksInApp] = useState<Record<string, boolean>>({});
  const [appLogDirPath, setAppLogDirPath] = useState("");
  const [appLogDirectorySize, setAppLogDirectorySize] = useState(EMPTY_APP_LOG_DIRECTORY_SIZE);
  const [networkProxySettings, setNetworkProxySettings] = useState<NetworkProxySettingsSnapshot>({
    ...DEFAULT_NETWORK_PROXY_SETTINGS,
    hasPassword: false,
  });
  const projectFolderGitWarning =
    projectFolderGitStatus?.exists === true && projectFolderGitStatus.isDirectory && !projectFolderGitStatus.isGitRepo
      ? "The selected folder is not a Git repository. It will be added as a plain folder project; Git-only features like branches, commits, worktrees, and PR/MR tools will be unavailable."
      : null;
  const preferredRunModelId = snapshot.settings[APP_SETTING_KEYS.lastUsedRunModelId] ?? "";
  const persistedSidebarWidthSetting = snapshot.settings[APP_SETTING_KEYS.sidebarWidth];
  const welcomeCompletedCheckIds = useMemo(
    () => orderWelcomeCheckIds(parseWelcomeCompletedCheckIdsSetting(snapshot.settings[APP_SETTING_KEYS.welcomeCompletedCheckIds])),
    [snapshot.settings],
  );
  const welcomeSatisfiedCheckIds = useMemo(() => getSatisfiedWelcomeCheckIds(snapshot), [snapshot]);
  const welcomeKnownCompletedCheckIds = useMemo(
    () => orderWelcomeCheckIds([...welcomeCompletedCheckIds, ...welcomeSatisfiedCheckIds]),
    [welcomeCompletedCheckIds, welcomeSatisfiedCheckIds],
  );
  const welcomeKnownCompletedSet = useMemo(() => new Set(welcomeKnownCompletedCheckIds), [welcomeKnownCompletedCheckIds]);
  const welcomePendingChecks = useMemo(
    () => WELCOME_CHECK_DEFINITIONS.filter((check) => !welcomeKnownCompletedSet.has(check.id)),
    [welcomeKnownCompletedSet],
  );
  const welcomeStepKeys = useMemo<WelcomeStepKey[]>(
    () => ["intro", ...welcomePendingChecks.map((check) => check.id), "done"],
    [welcomePendingChecks],
  );
  const welcomeStepKey = welcomeStepKeys[Math.min(welcomeStepIndex, welcomeStepKeys.length - 1)] ?? "intro";
  const shouldCheckProjectFolderGitStatus = settingsOpen || (welcomeOpen && welcomeStepKey === "project");
  const selectedProviderAccount = snapshot.providerAccounts.find((provider) => provider.id === selectedProviderId) ?? null;
  const openAiPresetsGroupedForSelectedProvider = selectedProviderAccount
    ? getModelPresetsByGroupForProvider(
        selectedProviderAccount.providerType,
        selectedProviderAccount.providerType === "ai-sdk"
          ? getAiSdkProviderFamilyFromConfigJson(selectedProviderAccount.configJson)
          : undefined,
      )
    : emptyModelPresetsByGroup();
  const ensureAvailableModels = useCallback(
    (providerAccountId: string) => {
      if (!providerAccountId) {
        return;
      }
      const current = availableModelsByProviderIdRef.current[providerAccountId];
      if (
        current?.status === "loading" ||
        current?.status === "loaded" ||
        availableModelRequestsInFlightRef.current.has(providerAccountId)
      ) {
        return;
      }
      if (!buildwarden) {
        setAvailableModelsByProviderId((previous) => ({
          ...previous,
          [providerAccountId]: {
            status: "error",
            models: [],
            errorMessage: "The Electron desktop bridge is unavailable.",
          },
        }));
        return;
      }

      availableModelRequestsInFlightRef.current.add(providerAccountId);
      setAvailableModelsByProviderId((previous) => ({
        ...previous,
        [providerAccountId]: {
          status: "loading",
          models: previous[providerAccountId]?.models ?? [],
          errorMessage: null,
        },
      }));

      void buildwarden
        .listAvailableProviderModels({ providerAccountId })
        .then((result) => {
          setAvailableModelsByProviderId((previous) => ({
            ...previous,
            [providerAccountId]: {
              status: result.errorMessage ? "error" : "loaded",
              models: result.models,
              errorMessage: result.errorMessage ?? null,
            },
          }));
        })
        .catch((caught) => {
          reportRendererError("renderer.provider-models.available-models", caught, { providerAccountId });
          const message = caught instanceof Error ? caught.message : "Available models could not be loaded.";
          setAvailableModelsByProviderId((previous) => ({
            ...previous,
            [providerAccountId]: {
              status: "error",
              models: [],
              errorMessage: message,
            },
          }));
        })
        .finally(() => {
          availableModelRequestsInFlightRef.current.delete(providerAccountId);
        });
    },
    [buildwarden],
  );

  const loadSnapshot = useCallback(async () => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable. Restart the app with `pnpm dev`.");
      return;
    }

    const next = await buildwarden.refreshSnapshot();
    setSnapshot(next);
    setSnapshotLoaded(true);
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
    setRunModelId((current) =>
      current && next.models.some((entry) => entry.id === current)
        ? current
        : next.settings[APP_SETTING_KEYS.lastUsedRunModelId] && next.models.some((entry) => entry.id === next.settings[APP_SETTING_KEYS.lastUsedRunModelId])
          ? (next.settings[APP_SETTING_KEYS.lastUsedRunModelId] as string)
          : next.models[0]?.id || "",
    );
    setSelectedRunId((current) => {
      if (current === null) {
        return null;
      }

      const hasCurrentRun =
        current &&
        next.projects.some(
          (entry) =>
            entry.runs.some((run) => run.id === current) ||
            entry.forLaterRuns.some((run) => run.id === current) ||
            entry.labThreads.some((detail) => detail.implementationRun?.id === current || detail.thread.implementationRunId === current),
        );
      if (hasCurrentRun) {
        return current;
      }

      return next.selectedRunId || next.projects[0]?.recentRuns[0]?.id || null;
    });
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

  useEffect(() => {
    const nextWidth = parseSidebarWidthSetting(persistedSidebarWidthSetting);
    if (nextWidth == null) {
      return;
    }
    setSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [persistedSidebarWidthSetting]);

  useEffect(() => {
    if (!buildwarden || !snapshotLoaded) {
      return;
    }
    const serializedCurrent = serializeWelcomeCompletedCheckIdsSetting(welcomeCompletedCheckIds);
    const serializedNext = serializeWelcomeCompletedCheckIdsSetting(welcomeKnownCompletedCheckIds);
    if (serializedCurrent === serializedNext) {
      return;
    }
    void buildwarden.setAppSetting(APP_SETTING_KEYS.welcomeCompletedCheckIds, serializedNext).catch((caught) => {
      reportRendererError("renderer.welcome.persist-completed-checks", caught);
    });
  }, [buildwarden, snapshotLoaded, welcomeCompletedCheckIds, welcomeKnownCompletedCheckIds]);

  useEffect(() => {
    if (!snapshotLoaded || welcomeFinishedForSession || welcomeOpen || welcomePendingChecks.length === 0) {
      return;
    }
    setWelcomeSkippedCheckIds([]);
    setWelcomeStepIndex(0);
    setWelcomeOpen(true);
  }, [snapshotLoaded, welcomeFinishedForSession, welcomeOpen, welcomePendingChecks.length]);

  useEffect(() => {
    if (welcomeStepIndex < welcomeStepKeys.length) {
      return;
    }
    setWelcomeStepIndex(Math.max(0, welcomeStepKeys.length - 1));
  }, [welcomeStepIndex, welcomeStepKeys.length]);

  useEffect(() => {
    if (snapshot.providerAccounts.length === 0) {
      setWelcomeProviderModelsOpenPanel("connection");
      return;
    }
    if (snapshot.models.length === 0) {
      setWelcomeProviderModelsOpenPanel("model");
    }
  }, [snapshot.models.length, snapshot.providerAccounts.length]);

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
      const fallback =
        runModelId && validSet.has(runModelId)
          ? runModelId
          : preferredRunModelId && validSet.has(preferredRunModelId)
            ? preferredRunModelId
            : snapshot.models[0]?.id;
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

      const fast = await buildwarden.getRunDetail(runId);
      if (runDetailLoadTokenRef.current[runId] !== loadToken) {
        return;
      }
      replaceRunDetailForRun(runId, { ...fast, diffPending: true, diff: "", worktreeUnavailable: false });

      const diffRes = await buildwarden.getRunWorktreeDiff(runId);
      if (runDetailLoadTokenRef.current[runId] !== loadToken) {
        return;
      }
      mergeRunDetailForRun(runId, (previous) => ({
        ...previous,
        diff: diffRes.diff,
        worktreeUnavailable: diffRes.worktreeUnavailable,
        diffPending: false,
      }));
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

  const refreshOpenRunDetailForEvent = useCallback(
    async (eventRunId: string) => {
      const shouldRefresh =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!buildwarden || !shouldRefresh) {
        return;
      }

      const fast = await buildwarden.getRunDetail(eventRunId);
      const stillOpen =
        selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
      if (!stillOpen) {
        return;
      }

      const previous = runDetailsByIdRef.current[eventRunId];
      replaceRunDetailForRun(eventRunId, {
        ...fast,
        diff: previous?.diff ?? "",
        worktreeUnavailable: previous?.worktreeUnavailable ?? false,
        diffPending: previous?.diffPending ?? true,
      });

      clearDiffRefreshTimer(eventRunId);
      diffRefreshTimersRef.current[eventRunId] = setTimeout(() => {
        delete diffRefreshTimersRef.current[eventRunId];
        void (async () => {
          const shouldLoadDiff =
            selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
          if (!buildwarden || !shouldLoadDiff) {
            return;
          }
          const d = await buildwarden.getRunWorktreeDiff(eventRunId);
          const stillShouldApply =
            selectedRunIdRef.current === eventRunId || runIdIsOpenInPanes(openRunPanesRef.current, eventRunId);
          if (!stillShouldApply) {
            return;
          }
          mergeRunDetailForRun(eventRunId, (prev) => ({
            ...prev,
            diff: d.diff,
            worktreeUnavailable: d.worktreeUnavailable,
            diffPending: false,
          }));
        })();
      }, 500);
    },
    [buildwarden, clearDiffRefreshTimer, mergeRunDetailForRun, replaceRunDetailForRun],
  );

  /**
   * Refetching the full run detail (entire step history) for every streaming
   * event is O(n²) over a run's lifetime. Trail-throttle per run and flush
   * immediately on terminal events so the final state is never delayed.
   */
  const runDetailRefreshTimersRef = useRef<Record<string, number>>({});
  const refreshRunDetailForActiveRunEvent = useCallback(
    async (eventRunId: string, options?: { immediate?: boolean }) => {
      if (options?.immediate) {
        const pending = runDetailRefreshTimersRef.current[eventRunId];
        if (pending !== undefined) {
          window.clearTimeout(pending);
          delete runDetailRefreshTimersRef.current[eventRunId];
        }
        await refreshOpenRunDetailForEvent(eventRunId);
        return;
      }
      if (runDetailRefreshTimersRef.current[eventRunId] !== undefined) {
        return;
      }
      runDetailRefreshTimersRef.current[eventRunId] = window.setTimeout(() => {
        delete runDetailRefreshTimersRef.current[eventRunId];
        void refreshOpenRunDetailForEvent(eventRunId);
      }, 400);
    },
    [refreshOpenRunDetailForEvent],
  );

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

    void loadSnapshot();
    void loadDetectedCodexInstallation();
    void loadDetectedClaudeInstallation();
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
        setShellApprovalQueue((current) => {
          if (current.some((item) => item.requestId === approvalRequestId && item.runId === event.runId)) {
            return current;
          }

          return [
            ...current,
            {
              runId: event.runId,
              requestId: approvalRequestId,
              command: approvalCommand,
              requestedAt: Date.now(),
            },
          ];
        });
      }

      if (approvalRequestId && event.metadata?.shellApprovalDecision) {
        setShellApprovalQueue((current) => current.filter((item) => item.requestId !== approvalRequestId));
      }

      if (event.title === "Run cancelled") {
        setShellApprovalQueue((current) => current.filter((item) => item.runId !== event.runId));
      }

      scheduleSnapshotRefresh();
      const isTerminalRunEvent =
        event.title === "Run completed" || event.title === "Run failed" || event.title === "Run cancelled";
      void refreshRunDetailForActiveRunEvent(event.runId, { immediate: isTerminalRunEvent });
    });

    const unsubscribeWarning = buildwarden.onAppWarning((warning) => {
      setAppWarning(warning);
    });

    return () => {
      unsubscribe();
      unsubscribeWarning();
    };
  }, [
    buildwarden,
    loadAppPaths,
    loadDetectedClaudeInstallation,
    loadDetectedCodexInstallation,
    loadNetworkProxySettings,
    loadSnapshot,
    refreshRunDetailForActiveRunEvent,
    scheduleSnapshotRefresh,
  ]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    void loadAppPaths();
  }, [loadAppPaths, settingsOpen]);

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
  const selectedProjectDefaultBranch = selectedProject?.project.defaultBranch ?? "";

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

  useEffect(() => {
    setRunWorkspaceLayoutsByRunId(parseRunWorkspaceLayoutsSetting(snapshot.settings[APP_SETTING_KEYS.runWorkspaceLayouts]));
  }, [snapshot.settings]);

  const selectedRunWorkspaceLayout = useMemo<RunWorkspaceLayoutPreference>(() => {
    if (!selectedRunId || typeof selectedRunId !== "string") {
      return cloneDefaultRunWorkspaceLayoutPreference();
    }
    return runWorkspaceLayoutsByRunId[selectedRunId] ?? cloneDefaultRunWorkspaceLayoutPreference();
  }, [runWorkspaceLayoutsByRunId, selectedRunId]);

  useEffect(() => {
    setRunWorkspaceShowActivity(selectedRunWorkspaceLayout.visiblePanels.activity);
    setRunWorkspaceShowDiff(selectedRunWorkspaceLayout.visiblePanels.diff);
    setRunWorkspaceShowTerminal(selectedRunWorkspaceLayout.visiblePanels.terminal);
    setRunWorkspaceShowBrowser(selectedRunWorkspaceLayout.visiblePanels.browser);
    setRunWorkspaceShowNotes(selectedRunWorkspaceLayout.visiblePanels.notes);
    setRunWorkspaceSecondaryPosition(selectedRunWorkspaceLayout.secondaryPanelPosition);
  }, [selectedRunWorkspaceLayout]);

  const persistRunWorkspaceLayouts = useCallback(
    async (next: RunWorkspaceLayoutPreferencesByRunId) => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.setAppSetting(APP_SETTING_KEYS.runWorkspaceLayouts, JSON.stringify(next));
    },
    [buildwarden],
  );

  const updateRunWorkspaceLayout = useCallback(
    (runId: string, updater: (current: RunWorkspaceLayoutPreference) => RunWorkspaceLayoutPreference) => {
      setRunWorkspaceLayoutsByRunId((current) => {
        const nextPreference = updater(current[runId] ?? cloneDefaultRunWorkspaceLayoutPreference());
        const next = { ...current, [runId]: nextPreference };
        void persistRunWorkspaceLayouts(next).catch((caught) => {
          reportRendererError("renderer.run-layout.persist", caught, { runId });
          setError(caught instanceof Error ? caught.message : "Could not save run layout.");
        });
        return next;
      });
    },
    [persistRunWorkspaceLayouts],
  );

  const removeRunWorkspaceLayout = useCallback(
    (runId: string) => {
      setRunWorkspaceLayoutsByRunId((current) => {
        if (!(runId in current)) {
          return current;
        }
        const next = { ...current };
        delete next[runId];
        void persistRunWorkspaceLayouts(next).catch((caught) => {
          reportRendererError("renderer.run-layout.remove", caught, { runId });
          setError(caught instanceof Error ? caught.message : "Could not remove run layout.");
        });
        return next;
      });
    },
    [persistRunWorkspaceLayouts],
  );

  const loadProjectBranches = useCallback(async () => {
    if (!buildwarden || !selectedProjectId) {
      setAvailableRunBranches([]);
      setRunBaseBranch("");
      setCurrentProjectBranch("");
      setDetachedCheckoutBranch("");
      return;
    }
    if (selectedProject?.project.kind === "folder") {
      setAvailableRunBranches([]);
      setRunBaseBranch("");
      setCurrentProjectBranch("");
      setDetachedCheckoutBranch("");
      setError((prev) => (prev && isDetachedHeadProjectErrorMessage(prev) ? null : prev));
      return;
    }

    const projectId = selectedProjectId;
    const defaultBranch = selectedProjectDefaultBranch;

    try {
      const branches = await buildwarden.getProjectBranches(projectId);
      const nextBranches = branches.length > 0 ? branches : [defaultBranch];

      try {
        const currentBranch = await buildwarden.getProjectCurrentBranch(projectId);
        if (!currentBranch) {
          setAvailableRunBranches(nextBranches);
          setRunBaseBranch((current) =>
            current && nextBranches.includes(current)
              ? current
              : nextBranches.includes(defaultBranch)
                ? defaultBranch
                : nextBranches[0] ?? "",
          );
          setCurrentProjectBranch("");
          setError(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE);
          setDetachedCheckoutBranch(
            nextBranches.includes(defaultBranch) ? defaultBranch : nextBranches[0] ?? "",
          );
          return;
        }
        setDetachedCheckoutBranch("");
        setCurrentProjectBranch(currentBranch);
        setAvailableRunBranches(nextBranches);
        setRunBaseBranch((current) =>
          current && nextBranches.includes(current)
            ? current
            : nextBranches.includes(defaultBranch)
              ? defaultBranch
              : nextBranches[0] ?? "",
        );
        setError((prev) => (prev && isDetachedHeadProjectErrorMessage(prev) ? null : prev));
      } catch (inner) {
        const msg = inner instanceof Error ? inner.message : String(inner);
        if (isDetachedHeadProjectErrorMessage(msg)) {
          setAvailableRunBranches(nextBranches);
          setRunBaseBranch((current) =>
            current && nextBranches.includes(current)
              ? current
              : nextBranches.includes(defaultBranch)
                ? defaultBranch
                : nextBranches[0] ?? "",
          );
          setCurrentProjectBranch("");
          setError(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE);
          setDetachedCheckoutBranch(
            nextBranches.includes(defaultBranch) ? defaultBranch : nextBranches[0] ?? "",
          );
          return;
        }
        throw inner;
      }
    } catch (caught) {
      reportRendererError("renderer.project-branches.load", caught, {
        projectId,
      });
      setDetachedCheckoutBranch("");
      setAvailableRunBranches([defaultBranch]);
      setRunBaseBranch(defaultBranch);
      setCurrentProjectBranch(defaultBranch);
      const msg = caught instanceof Error ? caught.message : String(caught);
      setError(msg || "Unexpected error");
    }
  }, [buildwarden, selectedProject, selectedProjectDefaultBranch, selectedProjectId]);

  useEffect(() => {
    void loadProjectBranches();
  }, [loadProjectBranches]);

  const submitCheckoutDetachedProjectBranch = useCallback(async () => {
    if (!buildwarden || !selectedProject?.project.id || !detachedCheckoutBranch.trim()) {
      return;
    }

    setProjectCheckoutBusy(true);
    try {
      await buildwarden.checkoutProjectBranch(selectedProject.project.id, detachedCheckoutBranch.trim());
      await loadProjectBranches();
    } catch (caught) {
      reportRendererError("renderer.project-branch.checkout", caught, {
        projectId: selectedProject.project.id,
        branchName: detachedCheckoutBranch.trim(),
      });
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    } finally {
      setProjectCheckoutBusy(false);
    }
  }, [buildwarden, selectedProject, detachedCheckoutBranch, loadProjectBranches]);

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
  const recentRunDays = parseRecentRunDaysSetting(snapshot.settings[APP_SETTING_KEYS.recentRunDays]);
  const uiTheme = parseUiTheme(snapshot.settings);
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

          return {
            id: model.id,
            label: `${model.displayName} - ${providerLabel}`,
            modelId: model.modelId,
            providerType: provider?.providerType ?? "ai-sdk",
            providerFamily: provider?.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : null,
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

  const pendingShellApproval = shellApprovalQueue[0] ?? null;
  const visibleShellApprovals = useMemo(() => shellApprovalQueue.slice(0, 3), [shellApprovalQueue]);
  const queuedShellApprovalCount = Math.max(0, shellApprovalQueue.length - visibleShellApprovals.length);
  const [visibleShellApprovalStartedAtById, setVisibleShellApprovalStartedAtById] = useState<Record<string, number>>({});
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
  const runWorkspaceVisiblePanelCount =
    (runWorkspaceShowActivity ? 1 : 0) +
    (runWorkspaceShowDiff ? 1 : 0) +
    (runWorkspaceShowTerminal ? 1 : 0) +
    (runWorkspaceShowBrowser ? 1 : 0) +
    (runWorkspaceShowNotes ? 1 : 0);
  const canHideRunWorkspaceActivity = !(runWorkspaceShowActivity && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceDiff = !(runWorkspaceShowDiff && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceTerminal = !(runWorkspaceShowTerminal && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceBrowser = !(runWorkspaceShowBrowser && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceNotes = !(runWorkspaceShowNotes && runWorkspaceVisiblePanelCount === 1);

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

  const toggleRunWorkspacePanelForRun = (runId: string, panelId: RunWorkspacePanelId, worktreeUnavailableForRun = false) => {
    const layout = runWorkspaceLayoutsByRunId[runId] ?? cloneDefaultRunWorkspaceLayoutPreference();
    if (worktreeUnavailableForRun && (panelId === "diff" || panelId === "terminal")) {
      return;
    }

    const visibleCount = Object.values(layout.visiblePanels).filter(Boolean).length;
    const currentlyVisible = layout.visiblePanels[panelId];
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

  const toggleRunWorkspaceActivity = () => {
    if (runWorkspaceShowActivity && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !runWorkspaceShowActivity;
    setRunWorkspaceShowActivity(next);
    setSelectedRunWorkspacePanelVisibility("activity", next);
  };
  const toggleRunWorkspaceDiff = () => {
    if (runWorkspaceShowDiff && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !runWorkspaceShowDiff;
    setRunWorkspaceShowDiff(next);
    setSelectedRunWorkspacePanelVisibility("diff", next);
  };
  const toggleRunWorkspaceTerminal = () => {
    if (runWorkspaceShowTerminal && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !runWorkspaceShowTerminal;
    setRunWorkspaceShowTerminal(next);
    setSelectedRunWorkspacePanelVisibility("terminal", next);
  };
  const toggleRunWorkspaceBrowser = () => {
    if (runWorkspaceShowBrowser && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !runWorkspaceShowBrowser;
    setRunWorkspaceShowBrowser(next);
    setSelectedRunWorkspacePanelVisibility("browser", next);
  };
  const toggleRunWorkspaceNotes = () => {
    if (runWorkspaceShowNotes && runWorkspaceVisiblePanelCount === 1) {
      return;
    }
    const next = !runWorkspaceShowNotes;
    setRunWorkspaceShowNotes(next);
    setSelectedRunWorkspacePanelVisibility("notes", next);
  };
  const runPanelToggleItems = [
    {
      key: "activity",
      label: "Activity Log",
      icon: MessageSquareText,
      active: runWorkspaceShowActivity,
      disabled: runWorkspaceShowActivity && !canHideRunWorkspaceActivity,
      subtitle: runWorkspaceShowActivity ? "Visible" : "Show agent activity",
      onClick: toggleRunWorkspaceActivity,
    },
    {
      key: "diff",
      label: "Diff View",
      icon: GitBranch,
      active: runWorkspaceShowDiff,
      disabled: runWorktreeUnavailable || (runWorkspaceShowDiff && !canHideRunWorkspaceDiff),
      subtitle: runWorktreeUnavailable ? "Worktree unavailable" : runWorkspaceShowDiff ? "Visible" : "Show changes",
      onClick: toggleRunWorkspaceDiff,
    },
    {
      key: "terminal",
      label: "Terminal",
      icon: SquareTerminal,
      active: runWorkspaceShowTerminal,
      disabled: runWorktreeUnavailable || (runWorkspaceShowTerminal && !canHideRunWorkspaceTerminal),
      subtitle: runWorktreeUnavailable ? "Worktree unavailable" : runWorkspaceShowTerminal ? "Visible" : "Show terminal",
      onClick: toggleRunWorkspaceTerminal,
    },
    {
      key: "browser",
      label: "Browser",
      icon: Globe,
      active: runWorkspaceShowBrowser,
      disabled: runWorkspaceShowBrowser && !canHideRunWorkspaceBrowser,
      subtitle: runWorkspaceShowBrowser ? "Visible" : "Show in-app browser",
      onClick: toggleRunWorkspaceBrowser,
    },
    {
      key: "notes",
      label: "Notes",
      icon: StickyNote,
      active: runWorkspaceShowNotes,
      disabled: runWorkspaceShowNotes && !canHideRunWorkspaceNotes,
      subtitle: runWorkspaceShowNotes ? "Visible" : "Show run notes",
      onClick: toggleRunWorkspaceNotes,
    },
  ] as const;

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

  /** Agent run detail uses a flex column so the composer stays at the bottom without overlapping scroll content. */
  const onLandingOrEmptySelection = landingSelected || allRunsSelected || (!selectedRunId && !selectedProject);
  const isAgentRunDetailView =
    !settingsOpen &&
    !allRunsSelected &&
    !bookmarksSelected &&
    !chatsSelected &&
    !onLandingOrEmptySelection &&
    Boolean(selectedRunId && (runDetail?.run || openRunPaneCount > 0));
  const isChatDetailView = !settingsOpen && !allRunsSelected && !bookmarksSelected && chatsSelected && Boolean(selectedChat && chatDetail);
  /** Project page (no run open) uses a flex column so the PR/MR tab diff can grow to the bottom of the viewport. */
  const isProjectWorkspaceView =
    !settingsOpen && !allRunsSelected && !bookmarksSelected && !chatsSelected && !landingSelected && !selectedRunId && Boolean(selectedProject);

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

  const submitShellApprovalDecision = useCallback(
    async (request: ShellApprovalRequestState, decision: ShellApprovalDecision) => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await buildwarden.respondToShellApproval(
        request.runId,
        request.requestId,
        decision,
        decision === "allow-always" ? { command: request.command } : undefined,
      );
      setShellApprovalQueue((current) => current.filter((item) => item.requestId !== request.requestId));
      await loadSnapshot();
      await loadRunDetailForRun(request.runId);
      if (selectedRunId && selectedRunId !== request.runId) {
        await loadRunDetailForRun(selectedRunId);
      }
    },
    [buildwarden, loadRunDetailForRun, loadSnapshot, selectedRunId],
  );

  useEffect(() => {
    if (visibleShellApprovals.length === 0) {
      return;
    }

    const timeoutIds = visibleShellApprovals.map((request) =>
      window.setTimeout(
        () => {
          void submitShellApprovalDecision(request, "deny").catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Unexpected error");
          });
        },
        Math.max(0, (visibleShellApprovalStartedAtById[request.requestId] ?? Date.now()) + 30_000 - Date.now()),
      ),
    );

    return () => {
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
    };
  }, [submitShellApprovalDecision, visibleShellApprovalStartedAtById, visibleShellApprovals]);

  useEffect(() => {
    const visibleRequestIds = new Set(visibleShellApprovals.map((request) => request.requestId));
    const queuedRequestIds = new Set(shellApprovalQueue.map((request) => request.requestId));
    const now = Date.now();
    setVisibleShellApprovalStartedAtById((current) => {
      let changed = false;
      const next: Record<string, number> = {};

      for (const requestId of queuedRequestIds) {
        const existing = current[requestId];
        if (visibleRequestIds.has(requestId)) {
          next[requestId] = existing ?? now;
          changed = changed || existing === undefined;
        } else if (existing !== undefined) {
          changed = true;
        }
      }

      if (Object.keys(current).length !== Object.keys(next).length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [shellApprovalQueue, visibleShellApprovals]);

  const handleAction = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
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
    if (!buildwarden || !selectedProject || selectedProject.project.kind !== "folder") {
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
    if (selectedProject?.project.kind === "folder" && (projectPageTab === "branches" || projectPageTab === "reviews")) {
      setProjectPageTab("overview");
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

  const submitProvider = async () => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      let parsedConfig: Record<string, unknown> = {};
      if (providerType === "ai-sdk") {
        try {
          parsedConfig = JSON.parse(providerConfigJson.trim() || "{}") as Record<string, unknown>;
        } catch {
          throw new Error("Provider configuration (JSON) is invalid.");
        }
      }

      const config: Record<string, unknown> = { ...parsedConfig };
      if (providerType === "ai-sdk") {
        config[PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY] = providerFamily;
      }
      if (providerType === "azure-legacy") {
        config[PROVIDER_CONFIG_AZURE_API_VERSION_KEY] = providerAzureApiVersion.trim() || "2024-06-01";
      } else {
        delete config[PROVIDER_CONFIG_AZURE_API_VERSION_KEY];
      }
      if (providerType === "codex-cli") {
        const effectiveCodexBinaryPath = codexBinaryPath.trim() || detectedCodexBinaryPath?.trim() || "";
        if (effectiveCodexBinaryPath) {
          config[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY] = effectiveCodexBinaryPath;
        } else {
          delete config[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY];
        }
        if (codexHomePath.trim()) {
          config[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY] = codexHomePath.trim();
        } else {
          delete config[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY];
        }
      } else {
        delete config[PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY];
        delete config[PROVIDER_CONFIG_CODEX_HOME_PATH_KEY];
      }
      if (providerType === "claude-code") {
        const effectiveClaudeBinaryPath = claudeBinaryPath.trim() || detectedClaudeBinaryPath?.trim() || "";
        if (effectiveClaudeBinaryPath) {
          config[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY] = effectiveClaudeBinaryPath;
        } else {
          delete config[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY];
        }
        if (claudeLaunchArgs.trim()) {
          config[PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY] = claudeLaunchArgs.trim();
        } else {
          delete config[PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY];
        }
      } else {
        delete config[PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY];
        delete config[PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY];
      }

      const provider = await buildwarden.addProviderAccount({
        providerType,
        label: providerLabel,
        apiKey: providerType === "codex-cli" || providerType === "claude-code" ? "" : apiKey,
        apiBaseUrl: providerType === "codex-cli" || providerType === "claude-code" ? undefined : providerBaseUrl || undefined,
        config,
      });
      setApiKey("");
      setCodexBinaryPath("");
      setCodexHomePath("");
      setClaudeBinaryPath("");
      setClaudeLaunchArgs("");
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

      const model = await buildwarden.addModel({
        providerAccountId: selectedProviderId,
        modelId,
        displayName: modelDisplayName,
        baseUrlOverride: modelBaseUrl || undefined,
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

  const submitRun = async (payload?: { attachments?: ChatAttachmentPayload[] }) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const modelIds =
        runWorkspaceType === "worktree" || runWorkspaceType === "copy"
          ? runWorktreeModelIds.filter((id) => snapshot.models.some((m) => m.id === id))
          : [runModelId].filter((id) => snapshot.models.some((m) => m.id === id));
      if (modelIds.length === 0) {
        throw new Error("Select at least one configured model before starting a run.");
      }

      const trimmedPrompt = runPrompt.trim();
      if (!trimmedPrompt && !(payload?.attachments?.length ?? 0)) {
        throw new Error("Enter a task description or attach at least one file.");
      }

      let lastRunId: string | null = null;
      for (const mid of modelIds) {
        const selectedModel = snapshot.models.find((model) => model.id === mid);
        if (!selectedModel) {
          continue;
        }
        const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
        if (!selectedProvider) {
          continue;
        }
        const providerFamily =
          selectedProvider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(selectedProvider.configJson) : null;
        const reasoningInput = buildRunReasoningInput(
          selectedProvider.providerType,
          providerFamily,
          runReasoningEffort,
          runAnthropicEffort,
        );
        const commandInput = resolveProviderComposerPrompt(runPrompt, selectedProvider.providerType, "run");
        if (commandInput.goalText !== undefined && !commandInput.prompt.trim() && !(payload?.attachments?.length ?? 0)) {
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
          attachments: payload?.attachments,
          ...reasoningInput,
          yoloMode: runYoloMode,
        });
        lastRunId = run.id;
      }
      await loadSnapshot();
      setLandingSelected(false);
      if (lastRunId) {
        setSelectedRunId(lastRunId);
      }
    });
  };

  const submitRunFromPrompt = async (prompt: string, modelId: string) => {
    const previousPrompt = runPrompt;
    setRunPrompt(prompt);
    try {
      await handleAction(async () => {
        if (!buildwarden) {
          throw new Error("The Electron desktop bridge is unavailable.");
        }

        const modelIds = [modelId].filter((id) => snapshot.models.some((m) => m.id === id));
        if (modelIds.length === 0) {
          throw new Error("Select a configured model before starting a run.");
        }

        const trimmedPrompt = prompt.trim();
        if (!trimmedPrompt) {
          throw new Error("Enter a task description before starting a run.");
        }

        let lastRunId: string | null = null;
        for (const mid of modelIds) {
          const selectedModel = snapshot.models.find((model) => model.id === mid);
          if (!selectedModel) {
            continue;
          }
          const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
          if (!selectedProvider) {
            continue;
          }
          const providerFamily =
            selectedProvider.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(selectedProvider.configJson) : null;
          const reasoningInput = buildRunReasoningInput(
            selectedProvider.providerType,
            providerFamily,
            runReasoningEffort,
            runAnthropicEffort,
          );
          const commandInput = resolveProviderComposerPrompt(prompt, selectedProvider.providerType, "run");
          if (commandInput.goalText !== undefined && !commandInput.prompt.trim()) {
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
            ...reasoningInput,
            yoloMode: runYoloMode,
          });
          lastRunId = run.id;
        }
        await loadSnapshot();
        setLandingSelected(false);
        if (lastRunId) {
          setSelectedRunId(lastRunId);
        }
      });
    } finally {
      setRunPrompt(previousPrompt);
    }
  };

  const openContinueRunDialog = (run: RunRecord) => {
    if (!isRunContinuable(run)) {
      return;
    }
    setContinueDialogRun(run);
    setContinuePrompt("");
    setContinueModelId(run.modelId);
    setContinueIncludeWorkspaceChanges(true);
  };

  const closeContinueRunDialog = () => {
    setContinueDialogRun(null);
    setContinuePrompt("");
    setContinueModelId("");
    setContinueIncludeWorkspaceChanges(true);
  };

  const submitContinueRun = async () => {
    const sourceRun = continueDialogRun;
    if (!sourceRun) {
      return;
    }

    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      if (!isRunContinuable(sourceRun)) {
        throw new Error("Wait for this run to finish before starting a continuation.");
      }

      const selectedModel = snapshot.models.find((model) => model.id === continueModelId);
      if (!selectedModel) {
        throw new Error("Select a configured model before starting a continuation.");
      }

      const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
      if (!selectedProvider) {
        throw new Error("The selected model is missing its provider configuration.");
      }

      const payload: ContinueRunInput = {
        sourceRunId: sourceRun.id,
        providerAccountId: selectedModel.providerAccountId,
        modelId: selectedModel.id,
        harnessType: harnessTypeForProvider(selectedProvider.providerType),
        mode: sourceRun.mode,
        prompt: continuePrompt.trim(),
        goalText: sourceRun.goalText,
        includeWorkspaceChanges: continueIncludeWorkspaceChanges,
        yoloMode: runYoloMode,
      };
      const newRun = await buildwarden.continueRun(payload);
      closeContinueRunDialog();
      await loadSnapshot();
      setLandingSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      focusRunInPaneState(newRun.id, sourceRun.projectId, focusedRunPane);
      await loadRunDetail(newRun.id);
    });
  };

  const createProjectTask = async (projectId: string, input: { title: string; prompt: string }) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.createProjectTask(projectId, input);
      await loadSnapshot();
    });
  };

  const updateProjectTask = async (taskId: string, input: { title: string; prompt: string }) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await buildwarden.updateProjectTask(taskId, input);
      await loadSnapshot();
    });
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
      const goalText =
        commandInput.goalText !== undefined
          ? commandInput.goalText
          : hasExplicitGoalText
            ? options.goalText
            : undefined;
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

  const commitRun = async (run: RunRecord) => {
    const normalizedPrompt = run.prompt.replace(/\s+/g, " ").trim();
    const suggestedMessage = `buildwarden: ${normalizedPrompt.slice(0, 60) || "apply run changes"}${normalizedPrompt.length > 60 ? "..." : ""}`;
    setCommitDialogRun(run);
    setCommitMessage(suggestedMessage);
  };

  const closeCommitDialog = () => {
    setCommitDialogRun(null);
    setCommitMessage("");
  };

  const closePublishDialog = () => {
    setPublishDialogRun(null);
    setPublishOptions(null);
    setPullRequestTitle("");
    setPullRequestTargetBranch("");
    setPullRequestSourceBranchMode("worktree");
    setPullRequestSourceBranchName("");
    setPullRequestDescription("");
    setPullRequestDescriptionBusy(false);
  };

  const closeBranchPublishDialog = () => {
    setBranchPublishDialogRun(null);
    setBranchPublishName("");
    setBranchPublishMode("publish");
  };

  const handleCommitDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommitDialog();
      return;
    }

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submitCommitRun();
    }
  };

  const suggestCommitMessageWithAi = async () => {
    if (!commitDialogRun || !buildwarden) {
      return;
    }

    setCommitSuggestBusy(true);
    setError(null);
    try {
      const text = await buildwarden.suggestCommitMessage(commitDialogRun.id);
      setCommitMessage(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate commit message.");
    } finally {
      setCommitSuggestBusy(false);
    }
  };

  const submitCommitRun = async () => {
    if (!commitDialogRun) {
      return;
    }

    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const trimmedMessage = commitMessage.trim();
      if (!trimmedMessage) {
        throw new Error("Enter a commit message.");
      }

      await buildwarden.commitRun(commitDialogRun.id, trimmedMessage);
      await loadSnapshot();
      await loadRunDetail(commitDialogRun.id);
      focusRunInPaneState(commitDialogRun.id, commitDialogRun.projectId);
      closeCommitDialog();
    });
  };

  const openPublishDialog = async (run: RunRecord) => {
    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const options = await buildwarden.getRunPublishOptions(run.id);
      setPublishDialogRun(run);
      setPublishOptions(options);
      setPullRequestTitle(options.suggestedTitle);
      setPullRequestTargetBranch(options.defaultTargetBranch);
      setPullRequestSourceBranchMode("worktree");
      setPullRequestSourceBranchName(options.defaultSourceBranch);
      setPullRequestDescription(options.defaultDescription);
    });
  };

  const generatePullRequestDescription = async () => {
    if (!publishDialogRun || !buildwarden) {
      return;
    }

    setPullRequestDescriptionBusy(true);
    setError(null);
    try {
      const description = await buildwarden.suggestRunPullRequestDescription(
        publishDialogRun.id,
        pullRequestTargetBranch.trim(),
        pullRequestTitle.trim(),
      );
      setPullRequestDescription(description);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate a merge request or pull request description.");
    } finally {
      setPullRequestDescriptionBusy(false);
    }
  };

  const handlePublishDialogKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLButtonElement | HTMLDivElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePublishDialog();
      return;
    }

    if (event.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void submitPullRequest();
    }
  };

  const submitPullRequest = async () => {
    if (!publishDialogRun) {
      return;
    }

    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const trimmedTitle = pullRequestTitle.trim();
      const trimmedTargetBranch = pullRequestTargetBranch.trim();
      const trimmedSourceBranch = pullRequestSourceBranchName.trim();

      if (!trimmedTitle) {
        throw new Error("Enter a merge request or pull request title.");
      }

      if (!trimmedTargetBranch) {
        throw new Error("Select a target branch.");
      }

      if (pullRequestSourceBranchMode === "custom") {
        if (!trimmedSourceBranch) {
          throw new Error("Enter a custom source branch name.");
        }
        if (trimmedSourceBranch === publishOptions?.defaultSourceBranch) {
          throw new Error("The custom source branch must differ from the current worktree branch.");
        }
      }

      await buildwarden.createRunPullRequest(
        publishDialogRun.id,
        trimmedTargetBranch,
        trimmedTitle,
        pullRequestSourceBranchMode === "custom" ? trimmedSourceBranch : undefined,
        pullRequestDescription.trim(),
      );
      await loadSnapshot();
      await loadRunDetail(publishDialogRun.id);
      focusRunInPaneState(publishDialogRun.id, publishDialogRun.projectId);
      closePublishDialog();
    });
  };

  const openBranchPublishDialog = (run: RunRecord, mode: "publish" | "local") => {
    setBranchPublishDialogRun(run);
    setBranchPublishName(run.branchName);
    setBranchPublishMode(mode);
  };

  const handleBranchPublishDialogKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeBranchPublishDialog();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void publishBranch();
    }
  };

  const publishBranch = async () => {
    if (!branchPublishDialogRun) {
      return;
    }

    await handleAction(async () => {
      if (!buildwarden) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const trimmedBranchName = branchPublishName.trim();
      if (!trimmedBranchName) {
        throw new Error("Enter a branch name.");
      }

      if (branchPublishMode === "local") {
        if (branchPublishDialogRun.workspaceType !== "worktree" && trimmedBranchName === branchPublishDialogRun.branchName) {
          throw new Error("The new local branch must differ from the current worktree branch.");
        }
        await buildwarden.createRunLocalBranch(branchPublishDialogRun.id, trimmedBranchName);
      } else {
        await buildwarden.publishRunBranch(branchPublishDialogRun.id, trimmedBranchName);
      }
      await loadSnapshot();
      await loadRunDetail(branchPublishDialogRun.id);
      focusRunInPaneState(branchPublishDialogRun.id, branchPublishDialogRun.projectId);
      closeBranchPublishDialog();
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
      const nextTab =
        targetProject?.project.kind === "folder" && (tab === "branches" || tab === "reviews")
          ? "overview"
          : tab;
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
        void handleAction(async () => {
          if (!buildwarden) {
            throw new Error("The Electron desktop bridge is unavailable.");
          }
          const next = cycleUiTheme(parseUiTheme(snapshot.settings));
          await buildwarden.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
          await buildwarden.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
          await loadSnapshot();
        });
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
  }, [buildwarden, handleAction, handleChatsSelect, handleLandingSelect, handleProjectSelect, loadSnapshot, openSettingsPage, runProjectId, selectedProject, snapshot.projects, snapshot.settings]);

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
      setProjectForgeRequestToasts((current) => [
        { ...payload, id },
        ...current.filter((toast) => toast.id !== id),
      ].slice(0, 4));
    });
  }, [buildwarden]);

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
    options?: { modelId?: string; attachments?: ChatAttachmentPayload[]; reasoningEffort?: string; anthropicEffort?: string },
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

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const targetProjectId = runProjectId || selectedProject?.project.id || snapshot.projects[0]?.project.id || "";
    const newestRuns = snapshot.projects
      .flatMap((entry) =>
        [...entry.runs, ...entry.forLaterRuns].map((run) => ({
          projectId: entry.project.id,
          projectName: entry.project.name,
          run,
        })),
      )
      .sort((left, right) => new Date(right.run.updatedAt).getTime() - new Date(left.run.updatedAt).getTime())
      .slice(0, 10);
    const newestChats = [...snapshot.chats]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, 8);

    const items: CommandPaletteItem[] = [
      {
        id: "workspace-home",
        title: "Go home",
        subtitle: "Open the workspace overview",
        section: "Navigate",
        icon: Home,
        keywords: ["dashboard", "landing"],
        onSelect: () => handleLandingSelect(),
      },
      {
        id: "workspace-all-runs",
        title: "Open all runs",
        subtitle: "Search and browse runs across projects",
        section: "Navigate",
        icon: Bot,
        keywords: ["history", "agent"],
        onSelect: () => handleAllRunsSelect(),
      },
      {
        id: "workspace-chats",
        title: "Open chats",
        subtitle: "Start or continue a chat",
        section: "Navigate",
        icon: MessageSquareText,
        keywords: ["conversation"],
        onSelect: handleChatsSelect,
      },
      {
        id: "workspace-bookmarks",
        title: "Open bookmarks",
        subtitle: "Saved chats and agent runs",
        section: "Navigate",
        icon: Bookmark,
        keywords: ["saved"],
        onSelect: handleBookmarksSelect,
      },
      {
        id: "workspace-settings",
        title: "Open settings",
        subtitle: "Providers, workspace behavior, shortcuts, and app settings",
        section: "Navigate",
        icon: Settings,
        keywords: ["preferences", "config"],
        onSelect: openSettingsPage,
      },
      {
        id: "workspace-new-run",
        title: "New agent run",
        subtitle: targetProjectId ? "Open the selected project run composer" : "Add a project first",
        section: "Action",
        icon: Sparkles,
        disabled: !targetProjectId,
        keywords: ["agent", "composer", "start"],
        onSelect: () => (targetProjectId ? handleProjectSelect(targetProjectId) : undefined),
      },
      {
        id: "workspace-toggle-theme",
        title: "Toggle theme",
        subtitle: "Toggle dark and light mode",
        section: "Action",
        icon: CommandIcon,
        keywords: ["appearance", "light", "dark"],
        onSelect: () =>
          handleAction(async () => {
            if (!buildwarden) {
              throw new Error("The Electron desktop bridge is unavailable.");
            }
            const next = cycleUiTheme(parseUiTheme(snapshot.settings));
            await buildwarden.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
            await buildwarden.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
            await loadSnapshot();
          }),
      },
    ];

    for (const entry of snapshot.projects) {
      items.push({
          id: `project-${entry.project.id}`,
          title: `Open ${entry.project.name}`,
          subtitle: entry.project.repoPath,
          section: "Project",
          icon: FolderOpen,
          keywords: ["overview", entry.project.kind === "git" ? entry.project.defaultBranch : "folder"],
          onSelect: () => handleProjectSelect(entry.project.id),
        });
      if (entry.project.kind === "git") {
        items.push(
          {
          id: `project-${entry.project.id}-branches`,
          title: `${entry.project.name}: Branches`,
          subtitle: "Manage local and remote branches",
          section: "Project",
          icon: GitBranch,
          keywords: ["git", "checkout", "fetch", "pull"],
          onSelect: () => handleProjectFeatureSelect(entry.project.id, "branches"),
        },
        {
          id: `project-${entry.project.id}-reviews`,
          title: `${entry.project.name}: Pull / merge requests`,
          subtitle: "Review PRs and MRs",
          section: "Project",
          icon: GitPullRequest,
          keywords: ["review", "mr", "pr"],
          onSelect: () => handleProjectFeatureSelect(entry.project.id, "reviews"),
          },
        );
      }
    }

    for (const item of newestRuns) {
      const workspaceLabel = formatRunWorkspaceLabel(item.run);
      items.push({
        id: `run-${item.run.id}`,
        title: item.run.prompt,
        subtitle: `${item.projectName} - ${item.run.status} - ${workspaceLabel}`,
        section: "Run",
        icon: Bot,
        keywords: [item.run.id, item.run.status, item.projectName, workspaceLabel],
        onSelect: () => handleRunSelect(item.projectId, item.run.id),
      });
    }

    for (const chat of newestChats) {
      items.push({
        id: `chat-${chat.id}`,
        title: chat.prompt,
        subtitle: `Chat - ${chat.status} - ${new Date(chat.createdAt).toLocaleString()}`,
        section: "Chat",
        icon: MessageSquareText,
        keywords: [chat.id, chat.status],
        onSelect: () => handleChatSelect(chat),
      });
    }

    return items;
  }, [
    buildwarden,
    handleAction,
    handleAllRunsSelect,
    handleBookmarksSelect,
    handleChatSelect,
    handleChatsSelect,
    handleProjectFeatureSelect,
    handleProjectSelect,
    handleRunSelect,
    handleLandingSelect,
    loadSnapshot,
    openSettingsPage,
    runProjectId,
    selectedProject?.project.id,
    snapshot.chats,
    snapshot.projects,
    snapshot.settings,
  ]);

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
  const [integratedSkillsCatalog, setIntegratedSkillsCatalog] = useState<IntegratedSkillMetadata[]>([]);

  useEffect(() => {
    if (!buildwarden) {
      return;
    }
    let cancelled = false;
    void buildwarden
      .listIntegratedSkills()
      .then((skills) => {
        if (!cancelled) {
          setIntegratedSkillsCatalog(skills);
        }
      })
      .catch(() => {
        // Skills are non-critical at boot; settings/composer surfaces handle an empty list.
      });
    return () => {
      cancelled = true;
    };
  }, [buildwarden]);

  const globallyDisabledIntegratedSkillIds = useMemo(
    () => parseIntegratedSkillsDisabledSetting(snapshot.settings[APP_SETTING_KEYS.integratedSkillsDisabled]),
    [snapshot.settings],
  );

  const projectActiveSkillsByProjectId = useMemo(
    () => parseProjectActiveSkillsSetting(snapshot.settings[APP_SETTING_KEYS.projectActiveSkills]),
    [snapshot.settings],
  );
  const projectLabSettingsByProjectId = useMemo(
    () => parseProjectLabSettingsSetting(snapshot.settings[APP_SETTING_KEYS.projectLabSettings]),
    [snapshot.settings],
  );

  const enabledIntegratedSkills = useMemo(() => {
    const disabledIds = new Set(globallyDisabledIntegratedSkillIds);
    return integratedSkillsCatalog.filter((skill) => !disabledIds.has(skill.id));
  }, [globallyDisabledIntegratedSkillIds, integratedSkillsCatalog]);

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

  const updateGloballyDisabledIntegratedSkills = useCallback(
    async (skillIds: string[]) => {
      if (!buildwarden) {
        return;
      }
      const validIds = new Set(integratedSkillsCatalog.map((skill) => skill.id));
      await buildwarden.setAppSetting(
        APP_SETTING_KEYS.integratedSkillsDisabled,
        JSON.stringify([...new Set(skillIds.filter((skillId) => validIds.has(skillId)))].sort()),
      );
      await loadSnapshot();
    },
    [buildwarden, integratedSkillsCatalog, loadSnapshot],
  );

  const updateProjectActiveSkills = useCallback(
    async (projectId: string, skillIds: string[]) => {
      if (!buildwarden) {
        return;
      }
      const current = parseProjectActiveSkillsSetting(snapshot.settings[APP_SETTING_KEYS.projectActiveSkills]);
      const next = { ...current };
      const normalized = [...new Set(skillIds)].sort();
      if (normalized.length > 0) {
        next[projectId] = normalized;
      } else {
        delete next[projectId];
      }
      await buildwarden.setAppSetting(APP_SETTING_KEYS.projectActiveSkills, JSON.stringify(next));
      await loadSnapshot();
    },
    [buildwarden, loadSnapshot, snapshot.settings],
  );

  const updateProjectLabSettings = useCallback(
    async (projectId: string, settings: ProjectLabSettings) => {
      if (!buildwarden) {
        return;
      }
      const current = parseProjectLabSettingsSetting(snapshot.settings[APP_SETTING_KEYS.projectLabSettings]);
      const next = { ...current, [projectId]: settings };
      await buildwarden.setAppSetting(APP_SETTING_KEYS.projectLabSettings, JSON.stringify(next));
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
      setRunWorkspaceLayoutsByRunId((current) => {
        const next = { ...current };
        let changed = false;
        for (const runId of deletedRunIds) {
          if (runId in next) {
            delete next[runId];
            changed = true;
          }
        }
        if (changed) {
          void persistRunWorkspaceLayouts(next).catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Could not remove deleted project layouts.");
          });
        }
        return changed ? next : current;
      });
      clearRunSelectionState(undefined);
      await loadSnapshot();
    });
  };

  const deleteRun = useCallback(async (run: RunRecord) => {
    if (!buildwarden) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    if (pendingDeleteRunIds[run.id]) {
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Delete run",
      message:
        run.workspaceType === "local"
          ? "Delete this local run and remove its logs, diff history, and persisted run data? Repository files will not be deleted."
          : "Delete this run, its worktree, logs, diff history, and persisted run data?",
      confirmLabel: "Delete run",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    const runId = run.id;
    const wasViewingThisRun = selectedRunId === runId;
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
      if (wasViewingThisRun && remainingRunId) {
        void setFocusedRunSelection(remainingPaneId, remainingRunId).catch((caught) => {
          setError(caught instanceof Error ? caught.message : "Unexpected error");
        });
      } else if (wasViewingThisRun) {
        clearRunSelectionState(null);
      }
    } else if (wasViewingThisRun) {
      clearRunSelectionState(null);
    }

    setPendingDeleteRunIds((current) => ({ ...current, [runId]: true }));

    void (async () => {
      try {
        await buildwarden.deleteRun(runId);
        setRunBrowserSessions((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
        setRunTerminalOpenLinksInApp((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
        removeRunWorkspaceLayout(runId);
        await loadSnapshot();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not delete run.");
        await loadSnapshot();
      } finally {
        setPendingDeleteRunIds((current) => {
          const next = { ...current };
          delete next[runId];
          return next;
        });
      }
    })();
  }, [
    buildwarden,
    clearRunSelectionState,
    loadSnapshot,
    pendingDeleteRunIds,
    removeRunWorkspaceLayout,
    requestConfirmation,
    selectedRunId,
    setFocusedRunSelection,
  ]);

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

    const confirmed = await requestConfirmation({
      title: "Delete model",
      message: "Delete this model from BuildWarden? Models referenced by existing runs cannot be deleted.",
      confirmLabel: "Delete model",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await buildwarden.deleteModel(modelId);
      await loadSnapshot();
    });
  };

  useEffect(() => {
    const shortcuts = parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (welcomeOpen) {
        return;
      }

      const keyStr = eventToKeyString(e);

      if (keyStr === shortcuts.openCommandPalette) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (commandPaletteOpen) {
        return;
      }

      if (settingsOpen) {
        if (keyStr === shortcuts.closeSettings) {
          e.preventDefault();
          handleSettingsBack();
        }
        return;
      }

      if (keyStr === shortcuts.openSettings) {
        e.preventDefault();
        openSettingsPage();
        return;
      }

      if (keyStr === shortcuts.goHome) {
        e.preventDefault();
        void handleLandingSelect();
        return;
      }

      if (keyStr === shortcuts.toggleSidebar) {
        e.preventDefault();
        setSidebarCollapsed((current) => !current);
        return;
      }

      const recentRunShortcuts = [
        shortcuts.switchToRecentRun1,
        shortcuts.switchToRecentRun2,
        shortcuts.switchToRecentRun3,
        shortcuts.switchToRecentRun4,
        shortcuts.switchToRecentRun5,
      ];
      const recentRunIndex = recentRunShortcuts.findIndex((s) => s === keyStr);
      if (recentRunIndex !== -1) {
        if (bookmarksSelected || chatsSelected) {
          return;
        }
        const allRunsNewestFirst = snapshot.projects
          .flatMap((entry) => entry.runs.map((run) => ({ projectId: entry.project.id, run })))
          .sort((a, b) => new Date(b.run.updatedAt).getTime() - new Date(a.run.updatedAt).getTime());
        const picked = allRunsNewestFirst[recentRunIndex];
        if (picked) {
          e.preventDefault();
          void handleRunSelect(picked.projectId, picked.run.id);
        }
        return;
      }

      if (selectedRunId && runDetail?.run) {
        const run = runDetail.run;
        const isRunActive = ["queued", "preparing", "running"].includes(run.status);

        if (keyStr === shortcuts.newAgentRun) {
          e.preventDefault();
          void handleProjectSelect(runProjectId);
          return;
        }

        if (keyStr === shortcuts.deleteRun) {
          e.preventDefault();
          void deleteRun(run);
          return;
        }

        if (keyStr === shortcuts.cancelRun && isRunActive) {
          e.preventDefault();
          void cancelRun(run);
          return;
        }

        if (keyStr === shortcuts.backToProject) {
          e.preventDefault();
          void handleProjectSelect(runProjectId);
          return;
        }
      }
    };

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
    document.body.dataset.theme = uiTheme;
    document.documentElement.dataset.theme = uiTheme;
  }, [uiTheme]);

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
    const paneVisiblePanels = isFocused
      ? {
          activity: runWorkspaceShowActivity,
          diff: runWorkspaceShowDiff,
          terminal: runWorkspaceShowTerminal,
          browser: runWorkspaceShowBrowser,
          notes: runWorkspaceShowNotes,
        }
      : paneLayout.visiblePanels;
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
            onOpenPublishDialog={openPublishDialog}
            onOpenBranchPublishDialog={openBranchPublishDialog}
            onOpenInIde={openRunDetailInIde}
            onOpenFileManager={openRunDetailInFileManager}
            onOpenContinueRunDialog={openContinueRunDialog}
            onDeleteRun={deleteRun}
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
            showActivity={paneVisiblePanels.activity}
            showDiff={paneVisiblePanels.diff}
            showTerminal={paneVisiblePanels.terminal}
            showBrowser={paneVisiblePanels.browser}
            showNotes={paneVisiblePanels.notes}
            onTogglePanel={(panelId) => toggleRunWorkspacePanelForRun(paneDetail.run.id, panelId, paneDetail.worktreeUnavailable === true)}
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
            onFollowUpRun={(run, prompt, options) => followUpRun(run, prompt, options)}
          />
        ) : (
          <Card className="flex min-h-[400px] flex-1 flex-col items-center justify-center gap-4 p-8">
            <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
            <p className="text-sm text-zinc-500">Loading run...</p>
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
  const handleWelcomeIntroNext = useStableCallback(() => {
    setWelcomeStepIndex((current) => Math.min(current + 1, welcomeStepKeys.length - 1));
  });
  const handleWelcomeBack = useStableCallback(() => {
    setWelcomeStepIndex((current) => Math.max(0, current - 1));
  });
  const handleWelcomeSkipCheck = useStableCallback((checkId: WelcomeCheckId) => {
    setWelcomeSkippedCheckIds((current) => (current.includes(checkId) ? current : [...current, checkId]));
    setWelcomeStepIndex((current) => Math.min(current + 1, welcomeStepKeys.length - 1));
  });
  const handleWelcomeFinish = useStableCallback(() => {
    setWelcomeOpen(false);
    setWelcomeFinishedForSession(true);
  });

  return (
    <div
      className={cn(
        "app-shell flex h-screen min-h-0 flex-col overflow-hidden",
        uiTheme === "light" ? "theme-light" : "theme-dark",
      )}
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
        landingSelected={landingSelected}
        allRunsSelected={allRunsSelected}
        bookmarksSelected={bookmarksSelected}
        chatsSelected={chatsSelected}
        settingsSelected={settingsOpen}
        selectedProjectId={selectedProject?.project.id ?? null}
        projectView={projectPageTab}
        highlightedRunId={
          !landingSelected && !allRunsSelected && !bookmarksSelected && !chatsSelected && !settingsOpen && typeof selectedRunId === "string" ? selectedRunId : null
        }
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        recentRunDays={recentRunDays}
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
      />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ec-bg)]">
        <main
          className={cn(
            "min-h-0 min-w-0 flex-1 p-3",
            isAgentRunDetailView || isChatDetailView || isProjectWorkspaceView
              ? "flex min-h-0 flex-col overflow-hidden"
              : "overflow-y-auto",
          )}
        >
        <section
          className={cn(
            "w-full",
            isAgentRunDetailView || isChatDetailView
              ? "flex min-h-0 min-w-0 flex-1 flex-col gap-2"
              : isProjectWorkspaceView
                ? "flex min-h-0 min-w-0 flex-1 flex-col gap-4"
                : "space-y-4",
          )}
        >
          <Suspense
            fallback={
              <div className="flex min-h-[200px] flex-1 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ec-accent)]" />
              </div>
            }
          >
          {settingsOpen ? (
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
              providerBaseUrl={providerBaseUrl}
              providerConfigJson={providerConfigJson}
              providerAzureApiVersion={providerAzureApiVersion}
              selectedProviderId={selectedProviderId}
              modelId={modelId}
              modelDisplayName={modelDisplayName}
              modelBaseUrl={modelBaseUrl}
              autoCheckoutRunBranchOnOpen={autoCheckoutRunBranchOnOpen}
              autoReleaseRunBranchOnLeave={autoReleaseRunBranchOnLeave}
              recentRunDays={recentRunDays}
              uiTheme={uiTheme}
              enableDevMode={snapshot.settings[APP_SETTING_KEYS.enableDevMode] === "true"}
              appLogDirPath={appLogDirPath}
              appLogDirectorySize={appLogDirectorySize}
              networkProxySettings={networkProxySettings}
              providerAccounts={snapshot.providerAccounts}
              models={snapshot.models}
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
              onRecentRunDaysChange={(value) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.recentRunDays, String(parseRecentRunDaysSetting(value)));
                  await loadSnapshot();
                })
              }
              onUiThemeChange={(next: UiTheme) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
                  await buildwarden.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
                  await loadSnapshot();
                })
              }
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
            />
          ) : bookmarksSelected ? selectedBookmark ? (
            "originalChatId" in selectedBookmark ? (
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
            )
          ) : (
            <BookmarksPage
              onSelectBookmark={(bookmark) => setSelectedBookmark(bookmark)}
              onRemoveRunBookmarkById={(bookmarkId) => void removeBookmarkById(bookmarkId)}
              onRemoveChatBookmarkById={(bookmarkId) => void removeChatBookmarkById(bookmarkId)}
            />
          ) : chatsSelected ? selectedChat && chatDetail ? (
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
          ) : (
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
              onDeleteChat={(chatId) => void deleteChat(chatId)}
            />
          ) : allRunsSelected ? (
            <AllRunsPage
              projects={snapshot.projects}
              onSelectRun={(projectId, runId) => void handleRunSelect(projectId, runId)}
            />
          ) : landingSelected || (!selectedRunId && !selectedProject) ? (
            <LandingPage
              snapshot={snapshot}
              sessionJoke={landingPageJoke}
              onSelectProject={(projectId) => void handleProjectSelect(projectId)}
              onSelectRun={(projectId, runId) => void handleRunSelect(projectId, runId)}
              onOpenChats={handleChatsSelect}
              onOpenSettings={openSettingsPage}
            />
          ) : (
            <div
              className={
                isAgentRunDetailView || isProjectWorkspaceView
                  ? "flex min-h-0 min-w-0 flex-1 flex-col gap-1.5"
                  : "contents"
              }
            >
              {selectedRunId && openRunPaneCount > 0 ? (
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
              ) : selectedRun ? (
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
                  onOpenPublishDialog={openPublishDialog}
                  onOpenBranchPublishDialog={openBranchPublishDialog}
                  onOpenInIde={openRunDetailInIde}
                  onOpenFileManager={openRunDetailInFileManager}
                  onOpenContinueRunDialog={openContinueRunDialog}
                  onDeleteRun={deleteRun}
                />
              ) : null}

              {selectedRunId && openRunPaneCount > 0 ? null : selectedRunId && runDetail?.run ? (
            <RunDetailPage
              className="min-h-0 min-w-0 flex-1"
              runDetail={runDetail}
              busy={busy}
              modelOptions={configuredRunModelOptions}
              keyboardShortcuts={keyboardShortcuts}
              pendingShellApproval={null}
              timelineDensity={runTimelineDensity}
              showActivity={runWorkspaceShowActivity}
              showDiff={runWorkspaceShowDiff}
              showTerminal={runWorkspaceShowTerminal}
              showBrowser={runWorkspaceShowBrowser}
              showNotes={runWorkspaceShowNotes}
              onTogglePanel={(panelId) => {
                if (panelId === "activity") toggleRunWorkspaceActivity();
                else if (panelId === "diff") toggleRunWorkspaceDiff();
                else if (panelId === "terminal") toggleRunWorkspaceTerminal();
                else if (panelId === "browser") toggleRunWorkspaceBrowser();
                else if (panelId === "notes") toggleRunWorkspaceNotes();
              }}
              secondaryPanelPosition={runWorkspaceSecondaryPosition}
              onSecondaryPanelPositionChange={(position) => {
                if (!runDetail?.run.id) return;
                setRunWorkspaceSecondaryPosition(position);
                updateRunWorkspaceLayout(runDetail.run.id, (current) => ({
                  ...current,
                  secondaryPanelPosition: position,
                }));
              }}
              tileOrder={selectedRunWorkspaceLayout.tileOrder}
              tileLayout={selectedRunWorkspaceLayout.tileLayout}
              onTileOrderChange={(next) => {
                if (!runDetail?.run.id) {
                  return;
                }
                updateRunWorkspaceLayout(runDetail.run.id, (current) => ({
                  ...current,
                  tileOrder: next,
                }));
              }}
              onTileLayoutChange={(next) => {
                if (!runDetail?.run.id) {
                  return;
                }
                updateRunWorkspaceLayout(runDetail.run.id, (current) => ({
                  ...current,
                  tileLayout: next,
                }));
              }}
              browserSession={runBrowserSessions[runDetail.run.id] ?? DEFAULT_RUN_BROWSER_SESSION}
              terminalOpenLinksInApp={runTerminalOpenLinksInApp[runDetail.run.id] !== false}
              onTerminalOpenLinksInAppChange={(enabled) =>
                setRunTerminalOpenLinksInApp((current) => ({
                  ...current,
                  [runDetail.run.id]: enabled,
                }))
              }
              onBrowserSessionChange={(session) =>
                setRunBrowserSessions((current) => ({
                  ...current,
                  [runDetail.run.id]: session,
                }))
              }
              onOpenBrowserUrl={openSelectedRunBrowserUrl}
              onRespondToShellApproval={(decision) => respondToPendingShellApproval(decision)}
              onCancelRunShell={(run, toolCallId) => void cancelRunShell(run, toolCallId)}
              onCancelRun={(run) => void cancelRun(run)}
              onUndoRunToLastPrompt={(run) => void undoRunToLastPrompt(run)}
              onRecoverInterruptedRun={(run) => void recoverInterruptedRun(run)}
              onCreateProjectTask={(projectId, input) => createProjectTask(projectId, input)}
              onFollowUpRun={(run, prompt, options) => followUpRun(run, prompt, options)}
            />
          ) : selectedRunId ? (
            <Card className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
              <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
              <p className="text-sm text-zinc-500">Loading run...</p>
            </Card>
          ) : selectedProject ? (
            <ProjectPage
              project={selectedProject}
              activeTab={projectPageTab}
              modelOptions={configuredRunModelOptions}
              availableBranches={availableRunBranches}
              currentProjectBranch={currentProjectBranch}
              runPrompt={runPrompt}
              runMode={runMode}
              runWorkspaceType={runWorkspaceType}
              runBaseBranch={runBaseBranch}
              runModelId={runModelId}
              runWorktreeModelIds={runWorktreeModelIds}
              submitShortcut={keyboardShortcuts.submitComposer}
              projectRunStats={projectRunStats}
              busy={busy}
              onSubmitRun={(payload) => void submitRun(payload)}
              onCreateTask={(input) => createProjectTask(selectedProject.project.id, input)}
              onUpdateTask={(taskId, input) => updateProjectTask(taskId, input)}
              onDeleteTask={(taskId) => deleteProjectTask(taskId)}
              onStartTask={(prompt, modelId) => submitRunFromPrompt(prompt, modelId)}
              onGenerateInsight={(kind, modelId) => generateProjectInsight(selectedProject.project.id, kind, modelId)}
              onSetRunForLater={(runId) => void setRunForLater(runId)}
              onRestoreRunFromForLater={(runId) => void restoreRunFromForLater(runId)}
              reasoningEffort={runReasoningEffort}
              anthropicEffort={runAnthropicEffort}
              yoloMode={runYoloMode}
              onReasoningEffortChange={setRunReasoningEffort}
              onAnthropicEffortChange={setRunAnthropicEffort}
              onYoloModeChange={setRunYoloMode}
              onSelectRun={(runId) => void handleRunSelect(selectedProject.project.id, runId)}
              onRunPromptChange={setRunPrompt}
              onRunModeChange={setRunMode}
              onRunWorkspaceTypeChange={setRunWorkspaceType}
              onRunBaseBranchChange={setRunBaseBranch}
              onRunModelChange={handleRunModelChange}
              onRunWorktreeModelIdsChange={handleRunWorktreeModelIdsChangeAndPersist}
              availableIntegratedSkills={enabledIntegratedSkills}
              activeIntegratedSkillIds={projectActiveSkillsByProjectId[selectedProject.project.id] ?? []}
              onActiveIntegratedSkillIdsChange={(skillIds) => void updateProjectActiveSkills(selectedProject.project.id, skillIds)}
              labSettings={projectLabSettingsByProjectId[selectedProject.project.id] ?? buildDefaultProjectLabSettings()}
              onLabSettingsChange={(settings) => void updateProjectLabSettings(selectedProject.project.id, settings)}
              onRunProjectLab={(input) =>
                void handleAction(async () => {
                  if (!buildwarden) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await buildwarden.runProjectLab({
                    projectId: selectedProject.project.id,
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
              onOpenProjectLabImplementation={(runId) => void handleRunSelect(selectedProject.project.id, runId)}
              onBranchesChanged={loadProjectBranches}
              onDeleteProject={() => void deleteProject(selectedProject.project.id)}
              onOpenProjectSettings={projectPageOnOpenProjectSettings}
              reviewRequestTarget={reviewRequestTarget?.projectId === selectedProject.project.id ? reviewRequestTarget : null}
            />
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-lg font-medium">No project selected</p>
                  <p className="mt-2 text-sm text-zinc-500">Open Settings to add your first project, provider, and model.</p>
                  <Button
                    className="mt-4"
                    variant="secondary"
                    onClick={() => {
                      setAllRunsSelected(false);
                      setSettingsOpen(true);
                    }}
                  >
                    Open settings
                  </Button>
                </Card>
              )}
            </div>
          )}

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
          onIntroNext={handleWelcomeIntroNext}
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
        pullRequestDescription={pullRequestDescription}
        pullRequestDescriptionBusy={pullRequestDescriptionBusy}
        onPullRequestSourceBranchModeChange={setPullRequestSourceBranchMode}
        onPullRequestSourceBranchNameChange={setPullRequestSourceBranchName}
        onPullRequestTargetBranchChange={setPullRequestTargetBranch}
        onPullRequestTitleChange={setPullRequestTitle}
        onPullRequestDescriptionChange={setPullRequestDescription}
        onPublishDialogKeyDown={handlePublishDialogKeyDown}
        onGeneratePullRequestDescription={() => void generatePullRequestDescription()}
        onSubmitPullRequest={() => void submitPullRequest()}
        onClosePublishDialog={closePublishDialog}
        branchPublishDialogRun={branchPublishDialogRun}
        branchPublishName={branchPublishName}
        branchPublishMode={branchPublishMode}
        onBranchPublishNameChange={setBranchPublishName}
        onBranchPublishDialogKeyDown={handleBranchPublishDialogKeyDown}
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
