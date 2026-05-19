import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APP_SETTING_KEYS,
  cycleUiTheme,
  DEFAULT_NETWORK_PROXY_SETTINGS,
  buildDefaultProjectLabSettings,
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  INTEGRATED_SKILLS_CATALOG,
  isDetachedHeadProjectErrorMessage,
  getAiSdkProviderFamilyFromConfigJson,
  DEFAULT_ADD_MODEL_DRAFT,
  DEFAULT_KEYBOARD_SHORTCUTS,
  DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES,
  parseIntegratedSkillsDisabledSetting,
  parseProjectLabSettingsSetting,
  parseProjectActiveSkillsSetting,
  parseRunWorkspaceLayoutsSetting,
  parseUiTheme,
  PROVIDER_CONFIG_AI_SDK_PROVIDER_FAMILY_KEY,
  PROVIDER_CONFIG_AZURE_API_VERSION_KEY,
  PROVIDER_CONFIG_CLAUDE_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CLAUDE_LAUNCH_ARGS_KEY,
  PROVIDER_CONFIG_CODEX_BINARY_PATH_KEY,
  PROVIDER_CONFIG_CODEX_HOME_PATH_KEY,
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
  type ProjectSnapshot,
  type ProjectInsightKind,
  type ProviderType,
  type RunDetail,
  type RunMode,
  type RunPublishOptions,
  type RunRecord,
  type RunWorkspaceLayoutPreference,
  type RunWorkspaceLayoutPreferencesByRunId,
  type RunWorkspacePanelId,
  type RunWorkspaceType,
  type ShellApprovalDecision,
  type UiTheme,
  type UnifiedProviderFamily,
  uiThemeToLegacyDarkMode,
} from "@easycode/shared";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Globe,
  GitBranch,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { BookmarkDetailPage } from "./components/app/BookmarkDetailPage";
import { AppTitleBar } from "./components/app/AppTitleBar";
import { BookmarksPage, type BookmarkItem } from "./components/app/BookmarksPage";
import { ChatBookmarkDetailPage } from "./components/app/ChatBookmarkDetailPage";
import { ChatDetailPage } from "./components/app/ChatDetailPage";
import { ChatPage } from "./components/app/ChatPage";
import { LandingPage } from "./components/app/LandingPage";
import { pickRandomLandingJoke } from "./components/app/landing-page-jokes";
import { ProjectPage } from "./components/app/ProjectPage";
import { AnchorDropdownPortal } from "./components/app/anchor-dropdown-portal";
import { OpenInIdeControl } from "./components/app/open-in-ide-control";
import { RunTokenBadge } from "./components/app/RunTokenBadge";
import { RunDetailPage } from "./components/app/RunDetailPage";
import { DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE } from "./components/app/run-workspace-layout";
import { SettingsPage } from "./components/app/SettingsPage";
import { Sidebar } from "./components/app/Sidebar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/cn";
import { reportRendererError, reportRendererLog } from "./lib/report-renderer-error";

const EMPTY_SNAPSHOT: AppSnapshot = {
  projects: [],
  providerAccounts: [],
  models: [],
  selectedProjectId: null,
  selectedRunId: null,
  selectedChatId: null,
  settings: {},
  bookmarks: [],
  chatBookmarks: [],
  chats: [],
};

const safeParseMetadata = (value: string) => {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const eventToKeyString = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const key = e.key.toLowerCase();
  if (key === " ") parts.push("space");
  else if (!["control", "meta", "alt", "shift"].includes(key)) parts.push(key);
  return parts.join("+");
};

const parseKeyboardShortcuts = (json: string | undefined): Record<KeyboardShortcutId, string> => {
  try {
    const parsed = json ? (JSON.parse(json) as Record<string, string>) : {};
    return { ...DEFAULT_KEYBOARD_SHORTCUTS, ...parsed };
  } catch {
    return { ...DEFAULT_KEYBOARD_SHORTCUTS };
  }
};

const harnessTypeForProvider = (providerType: ProviderType) =>
  providerType === "codex-cli"
    ? "codex-app-server"
    : providerType === "claude-code"
      ? "claude-code"
      : providerType === "azure-legacy"
        ? "azure-legacy"
        : "ai-sdk";

const normalizeOpenAiReasoningEffort = (value: string) => {
  const allowed = new Set(["none", "low", "medium", "high", "xhigh"]);
  return allowed.has(value) ? value : "medium";
};

const normalizeAnthropicEffort = (value: string) => {
  const allowed = new Set(["low", "medium", "high", "xhigh", "max"]);
  return allowed.has(value) ? value : "medium";
};

const buildRunReasoningInput = (
  providerType: ProviderType,
  providerFamily: UnifiedProviderFamily | null,
  reasoningEffort: string,
  anthropicEffort: string,
): { reasoningEffort?: string; anthropicEffort?: string } => {
  if (providerType === "codex-cli" || (providerType === "ai-sdk" && providerFamily === "openai")) {
    return { reasoningEffort: normalizeOpenAiReasoningEffort(reasoningEffort) };
  }
  if (providerType === "claude-code" || (providerType === "ai-sdk" && providerFamily === "anthropic")) {
    return { anthropicEffort: normalizeAnthropicEffort(anthropicEffort) };
  }
  return {};
};

const isRunContinuable = (run: RunRecord) =>
  !["queued", "preparing", "running"].includes(run.status);

interface ShellApprovalRequestState {
  runId: string;
  requestId: string;
  command: string;
  requestedAt: number;
}

const findProjectRun = (projects: ProjectSnapshot[], runId: string) => {
  for (const project of projects) {
    const labImplementationRuns = project.labThreads
      .map((thread) => thread.implementationRun)
      .filter((run): run is RunRecord => Boolean(run));
    const run = [
      ...project.runs,
      ...project.forLaterRuns,
      ...project.activeRuns,
      ...project.recentRuns,
      ...labImplementationRuns,
    ].find((candidate) => candidate.id === runId);

    if (run) {
      return { project, run };
    }
  }

  return null;
};

interface RunBrowserSessionState {
  draftUrl: string;
  currentUrl: string;
  history: string[];
  historyIndex: number;
  reloadKey: number;
}

interface ConfirmDialogState {
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: "default" | "danger";
}

interface SettingsPreviousPageState {
  landingSelected: boolean;
  bookmarksSelected: boolean;
  chatsSelected: boolean;
  selectedBookmark: BookmarkItem | null;
  selectedChat: ChatRecord | null;
  chatDetail: ChatDetail | null;
  selectedRunId: string | null | undefined;
  runDetail: RunDetail | null;
}

const DEFAULT_RUN_BROWSER_SESSION: RunBrowserSessionState = {
  draftUrl: "about:blank",
  currentUrl: "about:blank",
  history: ["about:blank"],
  historyIndex: 0,
  reloadKey: 0,
};

const cloneDefaultRunWorkspaceLayoutPreference = (): RunWorkspaceLayoutPreference => ({
  visiblePanels: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.visiblePanels },
  tileOrder: [...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileOrder],
  tileLayout: {
    activity: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.activity },
    diff: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.diff },
    terminal: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.terminal },
    browser: { ...DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.tileLayout.browser },
  },
  secondaryPanelPosition: DEFAULT_RUN_WORKSPACE_LAYOUT_PREFERENCE.secondaryPanelPosition,
});

const dedupeIntegratedSkillsCatalog = () => {
  const seen = new Set<string>();
  return INTEGRATED_SKILLS_CATALOG.filter((skill) => {
    const dedupeKey = `${skill.source}:${skill.name}`;
    if (seen.has(dedupeKey)) {
      return false;
    }
    seen.add(dedupeKey);
    return true;
  });
};

export const App = () => {
  const easycode = window.easycode;
  const showCustomWindowsTitleBar = typeof navigator !== "undefined" && navigator.platform.toLowerCase().startsWith("win");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(EMPTY_SNAPSHOT);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  /** Runs whose deletion IPC is in flight (does not block the rest of the UI). */
  const [pendingDeleteRunIds, setPendingDeleteRunIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [appWarning, setAppWarning] = useState<AppWarning | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
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
  const diffRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [landingSelected, setLandingSelected] = useState(true);
  const [bookmarksSelected, setBookmarksSelected] = useState(false);
  const [chatsSelected, setChatsSelected] = useState(false);
  const [selectedBookmark, setSelectedBookmark] = useState<BookmarkItem | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatRecord | null>(null);
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPreviousPage, setSettingsPreviousPage] = useState<SettingsPreviousPageState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(320);
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
  const publishMenuAnchorRef = useRef<HTMLDivElement>(null);
  const runPanelsMenuAnchorRef = useRef<HTMLDivElement>(null);
  const confirmDialogResolverRef = useRef<((value: boolean) => void) | null>(null);
  const [shellApprovalQueue, setShellApprovalQueue] = useState<ShellApprovalRequestState[]>([]);
  const [runWorkspaceShowActivity, setRunWorkspaceShowActivity] = useState(true);
  const [runWorkspaceShowDiff, setRunWorkspaceShowDiff] = useState(false);
  const [runWorkspaceShowTerminal, setRunWorkspaceShowTerminal] = useState(false);
  const [runWorkspaceShowBrowser, setRunWorkspaceShowBrowser] = useState(false);
  const [runWorkspaceSecondaryPosition, setRunWorkspaceSecondaryPosition] = useState<"right" | "bottom">("right");
  const [runWorkspaceLayoutsByRunId, setRunWorkspaceLayoutsByRunId] = useState<RunWorkspaceLayoutPreferencesByRunId>({});
  const [runBrowserSessions, setRunBrowserSessions] = useState<Record<string, RunBrowserSessionState>>({});
  const [runTerminalOpenLinksInApp, setRunTerminalOpenLinksInApp] = useState<Record<string, boolean>>({});
  const [appLogDirPath, setAppLogDirPath] = useState("");
  const [networkProxySettings, setNetworkProxySettings] = useState<NetworkProxySettingsSnapshot>({
    ...DEFAULT_NETWORK_PROXY_SETTINGS,
    hasPassword: false,
  });
  const preferredRunModelId = snapshot.settings[APP_SETTING_KEYS.lastUsedRunModelId] ?? "";

  const loadSnapshot = useCallback(async () => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable. Restart the app with `pnpm dev`.");
      return;
    }

    const next = await easycode.refreshSnapshot();
    setSnapshot(next);
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

      if (current && next.projects.some((entry) => entry.runs.some((run) => run.id === current))) {
        return current;
      }

      return next.selectedRunId || next.projects[0]?.recentRuns[0]?.id || null;
    });
  }, [easycode]);

  const loadDetectedCodexInstallation = useCallback(async () => {
    if (!easycode) {
      return;
    }
    const detected = await easycode.getDetectedCodexInstallation();
    setDetectedCodexBinaryPath(detected.binaryPath);
  }, [easycode]);

  const loadDetectedClaudeInstallation = useCallback(async () => {
    if (!easycode) {
      return;
    }
    const detected = await easycode.getDetectedClaudeInstallation();
    setDetectedClaudeBinaryPath(detected.binaryPath);
  }, [easycode]);

  const loadNetworkProxySettings = useCallback(async () => {
    if (!easycode) {
      return;
    }
    const next = await easycode.getNetworkProxySettings();
    setNetworkProxySettings(next);
  }, [easycode]);

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
      if (!easycode || !modelId.trim()) {
        return;
      }
      await easycode.setAppSetting(APP_SETTING_KEYS.lastUsedRunModelId, modelId);
    },
    [easycode],
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

  const clearDiffRefreshTimer = useCallback(() => {
    if (diffRefreshTimerRef.current != null) {
      clearTimeout(diffRefreshTimerRef.current);
      diffRefreshTimerRef.current = null;
    }
  }, []);

  const loadRunDetail = useCallback(
    async (runId: string | null | undefined) => {
      clearDiffRefreshTimer();
      if (!runId) {
        setRunDetail(null);
        return;
      }
      if (!easycode) {
        return;
      }

      const fast = await easycode.getRunDetail(runId);
      if (selectedRunIdRef.current !== runId) {
        return;
      }
      setRunDetail({ ...fast, diffPending: true, diff: "", worktreeUnavailable: false });

      const diffRes = await easycode.getRunWorktreeDiff(runId);
      if (selectedRunIdRef.current !== runId) {
        return;
      }
      setRunDetail((prev) =>
        prev?.run.id === runId
          ? {
              ...prev,
              diff: diffRes.diff,
              worktreeUnavailable: diffRes.worktreeUnavailable,
              diffPending: false,
            }
          : prev,
      );
    },
    [clearDiffRefreshTimer, easycode],
  );

  const refreshRunDetailForActiveRunEvent = useCallback(
    async (eventRunId: string) => {
      const currentId = selectedRunIdRef.current;
      if (!easycode || !currentId || typeof currentId !== "string") {
        return;
      }
      if (eventRunId !== currentId) {
        return;
      }

      const fast = await easycode.getRunDetail(currentId);
      if (selectedRunIdRef.current !== currentId) {
        return;
      }
      setRunDetail((prev) => {
        if (prev?.run.id !== currentId) {
          return { ...fast, diffPending: true, diff: "", worktreeUnavailable: false };
        }
        return {
          ...fast,
          diff: prev.diff,
          worktreeUnavailable: prev.worktreeUnavailable,
          diffPending: prev.diffPending,
        };
      });

      if (diffRefreshTimerRef.current != null) {
        clearTimeout(diffRefreshTimerRef.current);
      }
      diffRefreshTimerRef.current = setTimeout(() => {
        diffRefreshTimerRef.current = null;
        void (async () => {
          const rid = selectedRunIdRef.current;
          if (!easycode || !rid || typeof rid !== "string" || rid !== currentId) {
            return;
          }
          const d = await easycode.getRunWorktreeDiff(rid);
          if (selectedRunIdRef.current !== rid) {
            return;
          }
          setRunDetail((prev) =>
            prev?.run.id === rid ? { ...prev, diff: d.diff, worktreeUnavailable: d.worktreeUnavailable, diffPending: false } : prev,
          );
        })();
      }, 500);
    },
    [easycode],
  );

  useEffect(() => () => clearDiffRefreshTimer(), [clearDiffRefreshTimer]);

  useEffect(() => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable. Restart the app with `pnpm dev`.");
      return;
    }

    void loadSnapshot();
    void loadDetectedCodexInstallation();
    void loadDetectedClaudeInstallation();
    void loadNetworkProxySettings();
    void easycode.getAppPaths().then((paths) => setAppLogDirPath(paths.logDirPath)).catch(() => {});

    const unsubscribe = easycode.onRunEvent((event) => {
      const approvalRequestId = typeof event.metadata?.approvalRequestId === "string" ? event.metadata.approvalRequestId : null;
      const approvalCommand = typeof event.metadata?.command === "string" ? event.metadata.command : null;

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

      void loadSnapshot();
      void refreshRunDetailForActiveRunEvent(event.runId);
    });

    const unsubscribeWarning = easycode.onAppWarning((warning) => {
      setAppWarning(warning);
    });

    return () => {
      unsubscribe();
      unsubscribeWarning();
    };
  }, [easycode, loadDetectedClaudeInstallation, loadDetectedCodexInstallation, loadNetworkProxySettings, loadSnapshot, refreshRunDetailForActiveRunEvent]);

  useEffect(() => {
    void loadRunDetail(selectedRunId);
  }, [loadRunDetail, selectedRunId]);

  const selectedProject = useMemo<ProjectSnapshot | null>(() => {
    return snapshot.projects.find((entry) => entry.project.id === runProjectId) ?? snapshot.projects[0] ?? null;
  }, [runProjectId, snapshot.projects]);
  const selectedProjectId = selectedProject?.project.id ?? "";
  const selectedProjectDefaultBranch = selectedProject?.project.defaultBranch ?? "";

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    const hasActiveLabThread = selectedProject.labThreads.some(
      (detail) => detail.thread.status === "discussing" || detail.thread.status === "running-implementation",
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
    setRunWorkspaceSecondaryPosition(selectedRunWorkspaceLayout.secondaryPanelPosition);
  }, [selectedRunWorkspaceLayout]);

  const persistRunWorkspaceLayouts = useCallback(
    async (next: RunWorkspaceLayoutPreferencesByRunId) => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.setAppSetting(APP_SETTING_KEYS.runWorkspaceLayouts, JSON.stringify(next));
    },
    [easycode],
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
    if (!easycode || !selectedProjectId) {
      setAvailableRunBranches([]);
      setRunBaseBranch("");
      setCurrentProjectBranch("");
      setDetachedCheckoutBranch("");
      return;
    }

    const projectId = selectedProjectId;
    const defaultBranch = selectedProjectDefaultBranch;

    try {
      const branches = await easycode.getProjectBranches(projectId);
      const nextBranches = branches.length > 0 ? branches : [defaultBranch];

      try {
        const currentBranch = await easycode.getProjectCurrentBranch(projectId);
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
  }, [easycode, selectedProjectDefaultBranch, selectedProjectId]);

  useEffect(() => {
    void loadProjectBranches();
  }, [loadProjectBranches]);

  const submitCheckoutDetachedProjectBranch = useCallback(async () => {
    if (!easycode || !selectedProject?.project.id || !detachedCheckoutBranch.trim()) {
      return;
    }

    setProjectCheckoutBusy(true);
    try {
      await easycode.checkoutProjectBranch(selectedProject.project.id, detachedCheckoutBranch.trim());
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
  }, [easycode, selectedProject, detachedCheckoutBranch, loadProjectBranches]);

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

  const autoCheckoutRunBranchOnOpen = snapshot.settings[APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen] !== "false";
  const autoReleaseRunBranchOnLeave = snapshot.settings[APP_SETTING_KEYS.autoReleaseRunBranchOnLeave] !== "false";
  const uiTheme = parseUiTheme(snapshot.settings);
  const selectedRun =
    runDetail?.run ??
    snapshot.projects.flatMap((p) => [...p.runs, ...p.forLaterRuns]).find((r) => r.id === selectedRunId) ??
    null;
  const configuredRunModelOptions = useMemo(
    () =>
      snapshot.models.filter((model) => model.enabled !== 0).map((model) => {
        const providerLabel =
          snapshot.providerAccounts.find((provider) => provider.id === model.providerAccountId)?.label ?? "Provider";

        return {
          id: model.id,
          label: `${model.displayName} - ${providerLabel}`,
          modelId: model.modelId,
          providerType: snapshot.providerAccounts.find((provider) => provider.id === model.providerAccountId)?.providerType ?? "ai-sdk",
          providerFamily: (() => {
            const provider = snapshot.providerAccounts.find((entry) => entry.id === model.providerAccountId);
            return provider?.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : null;
          })(),
        };
      }),
    [snapshot.models, snapshot.providerAccounts],
  );
  const configuredChatModelOptions = useMemo(
    () =>
      snapshot.models
        .filter((model) => model.enabled !== 0)
        .map((model) => {
          const provider = snapshot.providerAccounts.find((entry) => entry.id === model.providerAccountId) ?? null;
          const providerLabel =
            provider?.label ?? "Provider";

          return {
            id: model.id,
            label: `${model.displayName} - ${providerLabel}`,
            modelId: model.modelId,
            providerType: provider?.providerType ?? "ai-sdk",
            providerFamily: provider?.providerType === "ai-sdk" ? getAiSdkProviderFamilyFromConfigJson(provider.configJson) : null,
          };
        }),
    [snapshot.models, snapshot.providerAccounts],
  );

  const configuredIdeKinds = useMemo(() => {
    const cfg = parseIdePathConfig(snapshot.settings[APP_SETTING_KEYS.idePaths]);
    return SUPPORTED_IDE_KINDS.filter((k) => (cfg[k]?.trim() ?? "").length > 0);
  }, [snapshot.settings]);

  const selectedRunHasCommit = useMemo(
    () => runDetail?.steps.some((step) => Boolean(safeParseMetadata(step.metadataJson).commitHash)) ?? false,
    [runDetail?.steps],
  );
  const pendingShellApproval = shellApprovalQueue[0] ?? null;
  const visibleShellApprovals = useMemo(() => shellApprovalQueue.slice(0, 3), [shellApprovalQueue]);
  const queuedShellApprovalCount = Math.max(0, shellApprovalQueue.length - visibleShellApprovals.length);
  const [shellApprovalNow, setShellApprovalNow] = useState(() => Date.now());
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
  const selectedRunHasOpenChanges = Boolean(runDetail?.diff.trim());
  const selectedRunCanCommit = selectedRun?.status === "completed" && selectedRunHasOpenChanges;
  const selectedRunCanManageChanges = selectedRun?.status === "completed" && runDetail?.worktreeUnavailable !== true;
  const selectedRunCanPublish = selectedRunCanManageChanges && !selectedRunHasOpenChanges && selectedRunHasCommit;
  const selectedRunCanCreateLocalBranch = selectedRunCanManageChanges && (selectedRunHasOpenChanges || selectedRunHasCommit);

  const runWorktreeUnavailable = runDetail?.worktreeUnavailable === true;
  const runWorkspaceVisiblePanelCount =
    (runWorkspaceShowActivity ? 1 : 0) +
    (runWorkspaceShowDiff ? 1 : 0) +
    (runWorkspaceShowTerminal ? 1 : 0) +
    (runWorkspaceShowBrowser ? 1 : 0);
  const canHideRunWorkspaceActivity = !(runWorkspaceShowActivity && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceDiff = !(runWorkspaceShowDiff && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceTerminal = !(runWorkspaceShowTerminal && runWorkspaceVisiblePanelCount === 1);
  const canHideRunWorkspaceBrowser = !(runWorkspaceShowBrowser && runWorkspaceVisiblePanelCount === 1);

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
  ] as const;

  const openSelectedRunBrowserUrl = (url: string) => {
    if (!runDetail?.run) {
      return;
    }

    const runId = runDetail.run.id;
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
    setRunWorkspaceShowDiff(false);
    setRunWorkspaceShowBrowser(true);
    setSelectedRunWorkspacePanelVisibility("diff", false);
    setSelectedRunWorkspacePanelVisibility("browser", true);
  };

  /** Agent run detail uses a flex column so the composer stays at the bottom without overlapping scroll content. */
  const onLandingOrEmptySelection = landingSelected || (!selectedRunId && !selectedProject);
  const isAgentRunDetailView =
    !settingsOpen &&
    !bookmarksSelected &&
    !chatsSelected &&
    !onLandingOrEmptySelection &&
    Boolean(selectedRunId && runDetail?.run);
  const isChatDetailView = !settingsOpen && !bookmarksSelected && chatsSelected && Boolean(selectedChat && chatDetail);
  /** Project page (no run open) uses a flex column so the PR/MR tab diff can grow to the bottom of the viewport. */
  const isProjectWorkspaceView =
    !settingsOpen && !bookmarksSelected && !chatsSelected && !landingSelected && !selectedRunId && Boolean(selectedProject);

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
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.respondToShellApproval(
        request.runId,
        request.requestId,
        decision,
        decision === "allow-always" ? { command: request.command } : undefined,
      );
      setShellApprovalQueue((current) => current.filter((item) => item.requestId !== request.requestId));
      await loadSnapshot();
      await loadRunDetail(selectedRunId === request.runId ? request.runId : selectedRunId);
    },
    [easycode, loadRunDetail, loadSnapshot, selectedRunId],
  );

  useEffect(() => {
    if (visibleShellApprovals.length === 0) {
      return;
    }

    setShellApprovalNow(Date.now());
    const intervalId = window.setInterval(() => setShellApprovalNow(Date.now()), 1000);
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
      window.clearInterval(intervalId);
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

  const chooseDirectory = async () => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const picked = await easycode.pickProjectDirectory();
    if (picked) {
      setProjectPath(picked);
    }
  };

  const pickDirectory = async (): Promise<string | null> => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return null;
    }

    return easycode.pickProjectDirectory();
  };

  const submitProject = async () => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const project = await easycode.addProject({
        name: projectName || undefined,
        repoPath: projectPath,
      });
      setProjectName("");
      setProjectPath("");
      await loadSnapshot();
      setRunProjectId(project.id);
    });
  };

  const submitProvider = async () => {
    await handleAction(async () => {
      if (!easycode) {
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

      const provider = await easycode.addProviderAccount({
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
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const model = await easycode.addModel({
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

  const submitRun = async (payload?: { attachments?: ChatAttachmentPayload[] }) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const modelIds =
        runWorkspaceType === "worktree"
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
        const run = await easycode.createRun({
          projectId: runProjectId,
          providerAccountId: selectedModel.providerAccountId,
          modelId: mid,
          harnessType: harnessTypeForProvider(selectedProvider.providerType),
          mode: runMode,
          workspaceType: runWorkspaceType,
          baseBranch: runBaseBranch,
          prompt: runPrompt,
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
        if (!easycode) {
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
          const run = await easycode.createRun({
            projectId: runProjectId,
            providerAccountId: selectedModel.providerAccountId,
            modelId: mid,
            harnessType: harnessTypeForProvider(selectedProvider.providerType),
            mode: runMode,
            workspaceType: runWorkspaceType,
            baseBranch: runBaseBranch,
            prompt: trimmedPrompt,
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
      if (!easycode) {
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
        includeWorkspaceChanges: continueIncludeWorkspaceChanges,
        yoloMode: runYoloMode,
      };
      const newRun = await easycode.continueRun(payload);
      closeContinueRunDialog();
      await loadSnapshot();
      setLandingSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setRunProjectId(sourceRun.projectId);
      setSelectedRunId(newRun.id);
      await loadRunDetail(newRun.id);
    });
  };

  const createProjectTask = async (projectId: string, input: { title: string; prompt: string }) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.createProjectTask(projectId, input);
      await loadSnapshot();
    });
  };

  const deleteProjectTask = async (taskId: string) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.deleteProjectTask(taskId);
      await loadSnapshot();
    });
  };

  const generateProjectInsight = async (projectId: string, kind: ProjectInsightKind, modelId?: string) => {
    await handleAction(async () => {
      if (!easycode) {
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
      await easycode.generateProjectInsight({ projectId, kind, modelId });
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
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.reorderProjects(projectIds);
      await loadSnapshot();
    });
  };

  const setRunForLater = async (runId: string) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.setRunListVisibility(runId, "for-later");
      await loadSnapshot();
      if (selectedRunId === runId) {
        setSelectedRunId(null);
        setRunDetail(null);
      }
    });
  };

  const restoreRunFromForLater = async (runId: string) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.setRunListVisibility(runId, "default");
      await loadSnapshot();
    });
  };

  const cancelRun = useCallback(async (run: RunRecord) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.cancelRun(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
    });
  }, [easycode, handleAction, loadRunDetail, loadSnapshot]);

  const cancelRunShell = async (run: RunRecord, toolCallId: string) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.cancelRunShell(run.id, toolCallId);
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
    },
  ) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt && !(options.attachments?.length ?? 0)) {
        throw new Error("Enter a follow-up command or attach at least one file.");
      }

      await easycode.followUpRun(run.id, trimmedPrompt, options);
      await loadSnapshot();
      await loadRunDetail(run.id);
      setSelectedRunId(run.id);
    });
  };

  const undoRunToLastPrompt = async (run: RunRecord) => {
    const confirmed = await requestConfirmation({
      title: "Revert run changes",
      message:
        "Revert repository changes made after the last prompt in this run? This updates the run workspace and cannot be undone from Easycode.",
      confirmLabel: "Revert changes",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.undoRunToLastPrompt(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
      setSelectedRunId(run.id);
    });
  };

  const recoverInterruptedRun = async (run: RunRecord) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.recoverInterruptedRun(run.id);
      await loadSnapshot();
      await loadRunDetail(run.id);
      setSelectedRunId(run.id);
    });
  };

  const commitRun = async (run: RunRecord) => {
    const normalizedPrompt = run.prompt.replace(/\s+/g, " ").trim();
    const suggestedMessage = `easycode: ${normalizedPrompt.slice(0, 60) || "apply run changes"}${normalizedPrompt.length > 60 ? "..." : ""}`;
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
    if (!commitDialogRun || !easycode) {
      return;
    }

    setCommitSuggestBusy(true);
    setError(null);
    try {
      const text = await easycode.suggestCommitMessage(commitDialogRun.id);
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
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const trimmedMessage = commitMessage.trim();
      if (!trimmedMessage) {
        throw new Error("Enter a commit message.");
      }

      await easycode.commitRun(commitDialogRun.id, trimmedMessage);
      await loadSnapshot();
      await loadRunDetail(commitDialogRun.id);
      setSelectedRunId(commitDialogRun.id);
      closeCommitDialog();
    });
  };

  const openPublishDialog = async (run: RunRecord) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      const options = await easycode.getRunPublishOptions(run.id);
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
    if (!publishDialogRun || !easycode) {
      return;
    }

    setPullRequestDescriptionBusy(true);
    setError(null);
    try {
      const description = await easycode.suggestRunPullRequestDescription(
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

  const handlePublishDialogKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLDivElement | HTMLSelectElement | HTMLTextAreaElement>) => {
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
      if (!easycode) {
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

      await easycode.createRunPullRequest(
        publishDialogRun.id,
        trimmedTargetBranch,
        trimmedTitle,
        pullRequestSourceBranchMode === "custom" ? trimmedSourceBranch : undefined,
        pullRequestDescription.trim(),
      );
      await loadSnapshot();
      await loadRunDetail(publishDialogRun.id);
      setSelectedRunId(publishDialogRun.id);
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
      if (!easycode) {
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
        await easycode.createRunLocalBranch(branchPublishDialogRun.id, trimmedBranchName);
      } else {
        await easycode.publishRunBranch(branchPublishDialogRun.id, trimmedBranchName);
      }
      await loadSnapshot();
      await loadRunDetail(branchPublishDialogRun.id);
      setSelectedRunId(branchPublishDialogRun.id);
      closeBranchPublishDialog();
    });
  };

  const respondToShellApproval = async (request: ShellApprovalRequestState, decision: ShellApprovalDecision) => {
    if (!easycode) {
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
    if (!easycode || !selectedRunId) {
      return;
    }

    await easycode.releaseRun(selectedRunId);
  }, [easycode, selectedRunId]);

  const handleProjectSelect = useCallback(async (projectId: string) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await leaveSelectedRun();
      await loadSnapshot();
      setLandingSelected(false);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      setRunProjectId(projectId);
      setSelectedRunId(null);
      setRunDetail(null);
    });
  }, [easycode, handleAction, leaveSelectedRun, loadSnapshot]);

  const handleLandingSelect = useCallback(async () => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await leaveSelectedRun();
      await loadSnapshot();
      setLandingSelected(true);
      setBookmarksSelected(false);
      setChatsSelected(false);
      setSettingsOpen(false);
      setSelectedRunId(null);
      setRunDetail(null);
    });
  }, [easycode, handleAction, leaveSelectedRun, loadSnapshot]);

  const handleBookmarksSelect = () => {
    setBookmarksSelected(true);
    setChatsSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setLandingSelected(false);
    setSettingsOpen(false);
    setSelectedRunId(null);
    setRunDetail(null);
  };

  const handleChatsSelect = useCallback(() => {
    setChatsSelected(true);
    setBookmarksSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setLandingSelected(false);
    setSettingsOpen(false);
    setSelectedRunId(null);
    setRunDetail(null);
  }, []);

  const openSettingsPage = useCallback(() => {
    setSettingsPreviousPage({
      landingSelected,
      bookmarksSelected,
      chatsSelected,
      selectedBookmark,
      selectedChat,
      chatDetail,
      selectedRunId,
      runDetail,
    });
    setSettingsOpen(true);
    setLandingSelected(false);
    setBookmarksSelected(false);
    setChatsSelected(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setSelectedRunId(null);
    setRunDetail(null);
  }, [bookmarksSelected, chatDetail, chatsSelected, landingSelected, runDetail, selectedBookmark, selectedChat, selectedRunId]);

  const handleSettingsBack = useCallback(() => {
    setSettingsOpen(false);
    if (settingsPreviousPage) {
      setLandingSelected(settingsPreviousPage.landingSelected);
      setBookmarksSelected(settingsPreviousPage.bookmarksSelected);
      setChatsSelected(settingsPreviousPage.chatsSelected);
      setSelectedBookmark(settingsPreviousPage.selectedBookmark);
      setSelectedChat(settingsPreviousPage.selectedChat);
      setChatDetail(settingsPreviousPage.chatDetail);
      setSelectedRunId(settingsPreviousPage.selectedRunId);
      setRunDetail(settingsPreviousPage.runDetail);
      setSettingsPreviousPage(null);
      return;
    }
    setLandingSelected(true);
    setBookmarksSelected(false);
    setChatsSelected(false);
  }, [settingsPreviousPage]);

  useEffect(() => {
    if (!easycode) {
      return;
    }

    return easycode.onAppMenuCommand((command) => {
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
          if (!easycode) {
            throw new Error("The Electron desktop bridge is unavailable.");
          }
          const next = cycleUiTheme(parseUiTheme(snapshot.settings));
          await easycode.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
          await easycode.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
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
          setBookmarksSelected(false);
          setChatsSelected(false);
        }
      }
    });
  }, [easycode, handleAction, handleChatsSelect, handleLandingSelect, handleProjectSelect, loadSnapshot, openSettingsPage, runProjectId, selectedProject, snapshot.projects, snapshot.settings]);

  useEffect(() => {
    if (!easycode) {
      return;
    }
    return easycode.onAppSettingsChanged(() => {
      void loadSnapshot();
    });
  }, [easycode, loadSnapshot]);

  const addRunToBookmarks = async (runId: string) => {
    if (!easycode) return;
    await easycode.addBookmark(runId);
    await loadSnapshot();
  };

  const removeRunFromBookmarks = async (runId: string) => {
    if (!easycode) return;
    await easycode.removeBookmark(runId);
    await loadSnapshot();
  };

  const removeBookmarkById = async (bookmarkId: string) => {
    if (!easycode) return;
    await easycode.removeBookmarkById(bookmarkId);
    await loadSnapshot();
  };

  const removeChatBookmarkById = async (bookmarkId: string) => {
    if (!easycode) return;
    await easycode.removeChatBookmarkById(bookmarkId);
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
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      const next = await easycode.refreshSnapshot();
      const model = next.models.find((m) => m.id === input.modelId);
      if (!model) {
        throw new Error("Select a model in Settings before starting a chat.");
      }
      const chat = await easycode.createChat({
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
      const detail = await easycode.getChatDetail(chat.id);
      setChatDetail(detail);
    });
  };

  const handleChatSelect = async (chat: ChatRecord) => {
    setSelectedChat(chat);
    const detail = await easycode?.getChatDetail(chat.id);
    if (detail) setChatDetail(detail);
  };

  const followUpChat = async (
    chatId: string,
    prompt: string,
    options?: { modelId?: string; attachments?: ChatAttachmentPayload[]; reasoningEffort?: string; anthropicEffort?: string },
  ) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }
      await easycode.followUpChat(chatId, prompt, options);
      await loadSnapshot();
      const detail = await easycode.getChatDetail(chatId);
      setChatDetail(detail);
    });
  };

  const deleteChat = async (chatId: string) => {
    if (!easycode) return;
    await easycode.deleteChat(chatId);
    await loadSnapshot();
    if (selectedChat?.id === chatId) {
      setSelectedChat(null);
      setChatDetail(null);
    }
  };

  const cancelChat = async (chatId: string) => {
    if (!easycode) return;
    await easycode.cancelChat(chatId);
    await loadSnapshot();
    const detail = await easycode.getChatDetail(chatId);
    setChatDetail(detail);
  };

  const handleRunSelect = useCallback(async (projectId: string, runId: string) => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    setLandingSelected(false);
    setBookmarksSelected(false);
    setChatsSelected(false);
    setSettingsOpen(false);
    setSelectedBookmark(null);
    setSelectedChat(null);
    setChatDetail(null);
    setRunProjectId(projectId);
    setSelectedRunId(runId);
    setRunDetail(null);

    const runActivateAndSnapshot = async () => {
      if (selectedRunId && selectedRunId !== runId) {
        await leaveSelectedRun();
      }
      await easycode.activateRun(runId);
      await loadSnapshot();
    };

    Promise.all([runActivateAndSnapshot(), loadRunDetail(runId)]).catch((caught) => {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
    });
  }, [easycode, leaveSelectedRun, loadRunDetail, loadSnapshot, selectedRunId]);

  const openShellApprovalRun = useCallback(async (request: ShellApprovalRequestState) => {
    if (!easycode) {
      return;
    }

    const target = getShellApprovalTarget(request);
    const knownProjectId = target?.project?.project.id ?? target?.run.projectId;
    if (knownProjectId) {
      await handleRunSelect(knownProjectId, request.runId);
      return;
    }

    try {
      const detail = await easycode.getRunDetail(request.runId);
      await handleRunSelect(detail.run.projectId, request.runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unexpected error");
    }
  }, [easycode, getShellApprovalTarget, handleRunSelect]);

  const updateBooleanSetting = async (key: string, value: boolean) => {
    await handleAction(async () => {
      if (!easycode) {
        throw new Error("The Electron desktop bridge is unavailable.");
      }

      await easycode.setAppSetting(key, String(value));
      await loadSnapshot();
    });
  };

  const keyboardShortcuts = useMemo(
    () => parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]),
    [snapshot.settings],
  );

  const shellAllowlistExtraText = useMemo(
    () => parseShellAllowlistExtraSetting(snapshot.settings[APP_SETTING_KEYS.shellAllowlistExtra]).join("\n"),
    [snapshot.settings],
  );
  const integratedSkillsCatalog = useMemo(() => dedupeIntegratedSkillsCatalog(), []);

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
      if (!easycode) {
        return;
      }
      const lines = text
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await easycode.setAppSetting(APP_SETTING_KEYS.shellAllowlistExtra, JSON.stringify(lines));
      await loadSnapshot();
    },
    [easycode, loadSnapshot],
  );

  const updateKeyboardShortcut = useCallback(
    async (id: KeyboardShortcutId, value: string) => {
      if (!easycode) return;
      const current = parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]);
      const next = { ...current, [id]: value };
      await easycode.setAppSetting(APP_SETTING_KEYS.keyboardShortcuts, JSON.stringify(next));
      await loadSnapshot();
    },
    [easycode, loadSnapshot, snapshot.settings],
  );

  const updateGloballyDisabledIntegratedSkills = useCallback(
    async (skillIds: string[]) => {
      if (!easycode) {
        return;
      }
      const validIds = new Set(integratedSkillsCatalog.map((skill) => skill.id));
      await easycode.setAppSetting(
        APP_SETTING_KEYS.integratedSkillsDisabled,
        JSON.stringify([...new Set(skillIds.filter((skillId) => validIds.has(skillId)))].sort()),
      );
      await loadSnapshot();
    },
    [easycode, integratedSkillsCatalog, loadSnapshot],
  );

  const updateProjectActiveSkills = useCallback(
    async (projectId: string, skillIds: string[]) => {
      if (!easycode) {
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
      await easycode.setAppSetting(APP_SETTING_KEYS.projectActiveSkills, JSON.stringify(next));
      await loadSnapshot();
    },
    [easycode, loadSnapshot, snapshot.settings],
  );

  const updateProjectLabSettings = useCallback(
    async (projectId: string, settings: ProjectLabSettings) => {
      if (!easycode) {
        return;
      }
      const current = parseProjectLabSettingsSetting(snapshot.settings[APP_SETTING_KEYS.projectLabSettings]);
      const next = { ...current, [projectId]: settings };
      await easycode.setAppSetting(APP_SETTING_KEYS.projectLabSettings, JSON.stringify(next));
      await loadSnapshot();
    },
    [easycode, loadSnapshot, snapshot.settings],
  );

  const openAppMenuSection = useCallback(
    async (section: AppMenuSection, anchor: HTMLButtonElement) => {
      if (!easycode) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      await easycode.showAppMenu(section, Math.round(rect.left), Math.round(rect.bottom));
    },
    [easycode],
  );

  const deleteProject = async (projectId: string) => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const deletedRunIds = snapshot.projects.find((project) => project.project.id === projectId)?.runs.map((run) => run.id) ?? [];

    const confirmed = await requestConfirmation({
      title: "Delete project",
      message:
        "Delete this project from Easycode and remove all of its runs, run history, and tracked workspace data? The original repository folder will not be deleted.",
      confirmLabel: "Delete project",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await easycode.deleteProject(projectId);
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
      setSelectedRunId(undefined);
      setRunDetail(null);
      await loadSnapshot();
    });
  };

  const deleteRun = useCallback(async (run: RunRecord) => {
    if (!easycode) {
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

    if (wasViewingThisRun) {
      setSelectedRunId(null);
      setRunDetail(null);
    }

    setPendingDeleteRunIds((current) => ({ ...current, [runId]: true }));

    void (async () => {
      try {
        await easycode.deleteRun(runId);
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
  }, [easycode, loadSnapshot, pendingDeleteRunIds, removeRunWorkspaceLayout, requestConfirmation, selectedRunId]);

  const deleteProviderAccount = async (providerAccountId: string) => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Delete provider",
      message: "Delete this provider and its models from Easycode? Providers referenced by existing runs cannot be deleted.",
      confirmLabel: "Delete provider",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await easycode.deleteProviderAccount(providerAccountId);
      await loadSnapshot();
    });
  };

  const deleteModel = async (modelId: string) => {
    if (!easycode) {
      setError("The Electron desktop bridge is unavailable.");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Delete model",
      message: "Delete this model from Easycode? Models referenced by existing runs cannot be deleted.",
      confirmLabel: "Delete model",
      confirmVariant: "danger",
    });

    if (!confirmed) {
      return;
    }

    await handleAction(async () => {
      await easycode.deleteModel(modelId);
      await loadSnapshot();
    });
  };

  useEffect(() => {
    const shortcuts = parseKeyboardShortcuts(snapshot.settings[APP_SETTING_KEYS.keyboardShortcuts]);

    const handleKeyDown = (e: KeyboardEvent) => {
      const keyStr = eventToKeyString(e);

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

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      {showCustomWindowsTitleBar ? (
        <AppTitleBar
          uiTheme={uiTheme}
          syncWindowsCaptionStrip
          onOpenMenu={(section, anchor) => void openAppMenuSection(section, anchor)}
        />
      ) : null}

      <div
        className={cn(
          "app-shell flex min-h-0 flex-1 gap-3 px-3 pb-3 text-zinc-100",
          showCustomWindowsTitleBar ? "pt-2" : "pt-3",
          uiTheme === "light" ? "theme-light" : uiTheme === "dim" ? "theme-dim" : "theme-dark",
        )}
      >
        <Sidebar
        projects={snapshot.projects}
        landingSelected={landingSelected}
        bookmarksSelected={bookmarksSelected}
        chatsSelected={chatsSelected}
        settingsSelected={settingsOpen}
        selectedProjectId={landingSelected || bookmarksSelected || chatsSelected || settingsOpen ? null : (selectedProject?.project.id ?? null)}
        highlightedRunId={
          !landingSelected && !bookmarksSelected && !chatsSelected && !settingsOpen && typeof selectedRunId === "string" ? selectedRunId : null
        }
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        bookmarksCount={snapshot.bookmarks.length + snapshot.chatBookmarks.length}
        chatsCount={snapshot.chats.length}
        bookmarkedRunIds={new Set(snapshot.bookmarks.map((b) => b.originalRunId))}
        onSelectLanding={() => void handleLandingSelect()}
        onSelectBookmarks={handleBookmarksSelect}
        onSelectChats={handleChatsSelect}
        onSelectProject={handleProjectSelect}
        onSelectRun={handleRunSelect}
        onReorderProjects={(projectIds) => void reorderProjects(projectIds)}
        onAddRunToBookmarks={(_, runId) => void addRunToBookmarks(runId)}
        onRemoveRunFromBookmarks={(runId) => void removeRunFromBookmarks(runId)}
        onContinueRun={(projectId, runId) => {
          const project = snapshot.projects.find((p) => p.project.id === projectId);
          const run = [...(project?.runs ?? []), ...(project?.forLaterRuns ?? [])].find((candidate) => candidate.id === runId);
          if (run) {
            openContinueRunDialog(run);
          }
        }}
        onDeleteRun={(projectId, runId) => {
          const project = snapshot.projects.find((p) => p.project.id === projectId);
          const run = project?.runs.find((r) => r.id === runId);
          if (run) {
            void deleteRun(run);
          }
        }}
        onSetRunForLater={(_, runId) => void setRunForLater(runId)}
        pendingDeleteRunIds={pendingDeleteRunIds}
        onOpenSettings={openSettingsPage}
        onWidthChange={setSidebarWidth}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />

        <main
          className={cn(
            "glass-island min-h-0 min-w-0 flex-1 p-4",
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
          {settingsOpen ? (
            <SettingsPage
              busy={busy}
              projects={snapshot.projects}
              projectName={projectName}
              projectPath={projectPath}
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
              uiTheme={uiTheme}
              enableDevMode={snapshot.settings[APP_SETTING_KEYS.enableDevMode] === "true"}
              appLogDirPath={appLogDirPath}
              networkProxySettings={networkProxySettings}
              providerAccounts={snapshot.providerAccounts}
              models={snapshot.models}
              onBack={handleSettingsBack}
              onChooseDirectory={() => void chooseDirectory()}
              onPickDirectory={pickDirectory}
              onSubmitProject={() => void submitProject()}
              onSubmitProvider={() => void submitProvider()}
              onSubmitModel={() => void submitModel()}
              onDeleteProject={(projectId) => void deleteProject(projectId)}
              onDeleteProviderAccount={(providerAccountId) => void deleteProviderAccount(providerAccountId)}
              onDeleteModel={(modelId) => void deleteModel(modelId)}
              onAutoCheckoutRunBranchOnOpenChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.autoCheckoutRunBranchOnOpen, value)}
              onAutoReleaseRunBranchOnLeaveChange={(value) => void updateBooleanSetting(APP_SETTING_KEYS.autoReleaseRunBranchOnLeave, value)}
              onUiThemeChange={(next: UiTheme) =>
                void handleAction(async () => {
                  if (!easycode) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await easycode.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
                  await easycode.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
                  await loadSnapshot();
                })
              }
              worktreeRootOverrideSettingValue={snapshot.settings[APP_SETTING_KEYS.worktreeRootOverride] ?? ""}
              onSaveWorktreeRootOverride={(value) =>
                void handleAction(async () => {
                  if (!easycode) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await easycode.setAppSetting(APP_SETTING_KEYS.worktreeRootOverride, value);
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
                void easycode?.resetDatabase();
              }}
              onSaveNetworkProxySettings={async (input) => {
                if (!easycode) {
                  throw new Error("The Electron desktop bridge is unavailable.");
                }
                const saved = await easycode.saveNetworkProxySettings(input);
                setNetworkProxySettings(saved);
                await loadSnapshot();
                return saved;
              }}
              onOpenAppLogDirectory={() =>
                void handleAction(async () => {
                  if (!easycode || !appLogDirPath) {
                    throw new Error("The app log directory is unavailable.");
                  }
                  const result = await easycode.openPathInFileManager(appLogDirPath);
                  if (!result.ok) {
                    throw new Error(result.error || "Could not open log directory.");
                  }
                })
              }
              idePathsSettingValue={snapshot.settings[APP_SETTING_KEYS.idePaths] ?? ""}
              onSaveIdePaths={(serialized) =>
                void handleAction(async () => {
                  if (!easycode) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await easycode.setAppSetting(APP_SETTING_KEYS.idePaths, serialized);
                  await loadSnapshot();
                })
              }
              onPickIdeExecutable={async () => (easycode ? easycode.pickIdeExecutable() : null)}
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
                await easycode?.addChatBookmark(selectedChat.id);
                await loadSnapshot();
              }}
              onRemoveBookmark={async () => {
                await easycode?.removeChatBookmark(selectedChat.id);
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
              <Card className="relative z-30 shrink-0 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    {selectedRun ? <Badge tone={selectedRun.status}>{selectedRun.status}</Badge> : null}
                    {!selectedRun ? <h2 className="truncate text-xl font-semibold">{selectedProject?.project.name ?? "No project selected"}</h2> : null}
                    {selectedRun && runDetail ? (
                      <>
                        <button
                          type="button"
                          className="inline-flex min-w-0 max-w-[24rem] items-center gap-2 rounded-full border border-zinc-800/80 bg-zinc-950/60 px-3 py-1 text-[11px] text-zinc-300 transition hover:border-zinc-700 hover:bg-zinc-900/70"
                          onClick={() => void navigator.clipboard.writeText(runDetail.run.branchName)}
                          title={runDetail.run.branchName}
                        >
                          <GitBranch className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                          <span className="truncate font-mono text-[11px] text-zinc-100">{runDetail.run.branchName}</span>
                        </button>
                        <RunTokenBadge
                          inputTokens={runDetail.run.inputTokens}
                          outputTokens={runDetail.run.outputTokens}
                        />
                      </>
                    ) : null}
                  </div>
                  {!selectedRun && selectedProject ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-8 border border-zinc-800 bg-zinc-900/80 px-2 text-rose-400 hover:border-rose-500/30 hover:bg-zinc-900 hover:text-rose-300"
                      onClick={() => void deleteProject(selectedProject.project.id)}
                      title="Delete project"
                      aria-label="Delete project"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ) : selectedRun ? (
                    <div className="flex max-w-full shrink-0 flex-nowrap items-center gap-2 overflow-x-auto sm:gap-3">
                      {runDetail?.run ? (
                        <div ref={runPanelsMenuAnchorRef} className="relative shrink-0">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-8 shrink-0 gap-2 border-cyan-500/20 bg-cyan-500/5 px-2 text-xs text-cyan-100 hover:bg-cyan-500/10"
                            onClick={() => setRunPanelsMenuOpen((current) => !current)}
                            aria-expanded={runPanelsMenuOpen}
                            aria-haspopup="menu"
                            title="Choose visible run panels"
                          >
                            Panels
                            <span className="rounded-full border border-zinc-700 bg-zinc-900/80 px-1.5 text-[10px] text-zinc-300">
                              {runWorkspaceVisiblePanelCount}
                            </span>
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition ${runPanelsMenuOpen ? "rotate-180" : ""}`} />
                          </Button>
                          <AnchorDropdownPortal
                            open={runPanelsMenuOpen}
                            anchorRef={runPanelsMenuAnchorRef}
                            onClose={() => setRunPanelsMenuOpen(false)}
                            align="start"
                            widthPx={240}
                            className="overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-950 py-1 shadow-xl shadow-black/40 ring-1 ring-cyan-500/10"
                          >
                            <div role="menu">
                              {runPanelToggleItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                  <button
                                    key={item.key}
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={item.active}
                                    disabled={item.disabled}
                                    className={cn(
                                      "flex w-full items-center gap-3 px-3 py-2 text-left transition",
                                      item.disabled
                                        ? "cursor-not-allowed text-zinc-600"
                                        : "text-zinc-200 hover:bg-zinc-800/80",
                                    )}
                                    onClick={() => {
                                      item.onClick();
                                    }}
                                  >
                                    <span
                                      className={cn(
                                        "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px]",
                                        item.active
                                          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                                          : "border-zinc-700 bg-zinc-900/80 text-zinc-500",
                                      )}
                                    >
                                      {item.active ? "ON" : ""}
                                    </span>
                                    <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm">{item.label}</div>
                                      <div className="text-[10px] text-zinc-500">{item.subtitle}</div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </AnchorDropdownPortal>
                        </div>
                      ) : null}
                      {selectedRunCanManageChanges ? (
                        <div ref={publishMenuAnchorRef} className="relative shrink-0">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            className="border border-emerald-500/35 bg-emerald-950/55 text-emerald-100 hover:border-emerald-400/45 hover:bg-emerald-900/65"
                            title="Commit, publish branch, or open a merge request"
                            onClick={() => setPublishMenuOpen((current) => !current)}
                          >
                            <GitBranch className="mr-2 h-4 w-4 shrink-0 text-emerald-300/95" aria-hidden />
                            Changes
                            {publishMenuOpen ? <ChevronDown className="ml-2 h-4 w-4 shrink-0" /> : <ChevronRight className="ml-2 h-4 w-4 shrink-0" />}
                          </Button>
                          <AnchorDropdownPortal
                            open={publishMenuOpen}
                            anchorRef={publishMenuAnchorRef}
                            onClose={() => setPublishMenuOpen(false)}
                            align="end"
                            widthPx={192}
                            className="rounded-xl border border-zinc-800 bg-zinc-900 p-1 shadow-2xl"
                          >
                            {selectedRunCanCommit ? (
                              <button
                                type="button"
                                className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
                                onClick={() => {
                                  setPublishMenuOpen(false);
                                  void commitRun(selectedRun);
                                }}
                              >
                                Create commit
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={cn(
                                "block w-full rounded-lg px-3 py-2 text-left text-sm",
                                selectedRunCanCreateLocalBranch ? "text-zinc-100 hover:bg-zinc-800" : "cursor-not-allowed text-zinc-500",
                              )}
                              disabled={!selectedRunCanCreateLocalBranch}
                              title={!selectedRunCanCreateLocalBranch ? "Create changes before creating a local branch." : undefined}
                              onClick={() => {
                                if (!selectedRunCanCreateLocalBranch) return;
                                setPublishMenuOpen(false);
                                openBranchPublishDialog(selectedRun, "local");
                              }}
                            >
                              Create local branch
                            </button>
                            <button
                              type="button"
                              className={cn(
                                "block w-full rounded-lg px-3 py-2 text-left text-sm",
                                selectedRunCanPublish ? "text-zinc-100 hover:bg-zinc-800" : "cursor-not-allowed text-zinc-500",
                              )}
                              disabled={!selectedRunCanPublish}
                              title={selectedRunHasOpenChanges ? "Create a commit before creating a merge request or pull request." : undefined}
                              onClick={() => {
                                if (!selectedRunCanPublish) return;
                                setPublishMenuOpen(false);
                                void openPublishDialog(selectedRun);
                              }}
                            >
                              Create MR / PR
                            </button>
                            <button
                              type="button"
                              className={cn(
                                "block w-full rounded-lg px-3 py-2 text-left text-sm",
                                selectedRunCanPublish ? "text-zinc-100 hover:bg-zinc-800" : "cursor-not-allowed text-zinc-500",
                              )}
                              disabled={!selectedRunCanPublish}
                              title={selectedRunHasOpenChanges ? "Create a commit before publishing the branch." : undefined}
                              onClick={() => {
                                if (!selectedRunCanPublish) return;
                                setPublishMenuOpen(false);
                                openBranchPublishDialog(selectedRun, "publish");
                              }}
                            >
                              Publish branch
                            </button>
                          </AnchorDropdownPortal>
                        </div>
                      ) : null}
                      {runDetail && runDetail.worktreeUnavailable !== true && configuredIdeKinds.length > 0 ? (
                        <OpenInIdeControl
                          compact
                          configuredIdeKinds={configuredIdeKinds}
                          onOpen={(ideKind) =>
                            void handleAction(async () => {
                              if (!easycode) {
                                throw new Error("The Electron desktop bridge is unavailable.");
                              }
                              await easycode.openRunWorktreeInIde(runDetail.run.id, ideKind);
                            })
                          }
                        />
                      ) : null}
                      {isRunContinuable(selectedRun) ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          className="h-8 shrink-0 border-cyan-500/20 bg-cyan-500/5 px-2 text-xs text-cyan-100 hover:bg-cyan-500/10"
                          title="Continue as new run. Start a fresh worktree and branch from this run's current state."
                          aria-label="Continue as new run"
                          onClick={() => openContinueRunDialog(selectedRun)}
                        >
                          <GitBranch className="h-4 w-4 shrink-0" aria-hidden />
                          <span className="sr-only">Continue as new run</span>
                        </Button>
                      ) : null}
                      {runDetail && runDetail.worktreeUnavailable !== true ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-8 shrink-0 border-cyan-500/20 bg-cyan-500/5 px-2 text-xs text-cyan-100 hover:bg-cyan-500/10"
                          title="Open current workspace in file explorer"
                          aria-label="Open current workspace in file explorer"
                          onClick={() =>
                            void handleAction(async () => {
                              if (!easycode) {
                                throw new Error("The Electron desktop bridge is unavailable.");
                              }
                              const result = await easycode.openPathInFileManager(runDetail.run.worktreePath);
                              if (!result.ok) {
                                throw new Error(result.error || "Could not open the workspace folder.");
                              }
                            })
                          }
                        >
                          <FolderOpen className="h-4 w-4 shrink-0" />
                          <span className="sr-only">Open in file explorer</span>
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        className="border border-zinc-800 bg-zinc-900/80 px-2 text-rose-400 hover:border-rose-500/30 hover:bg-zinc-900 hover:text-rose-300"
                        disabled={Boolean(selectedRun && pendingDeleteRunIds[selectedRun.id])}
                        onClick={() => void deleteRun(selectedRun)}
                        title="Delete run"
                        aria-label="Delete run"
                      >
                        {selectedRun && pendingDeleteRunIds[selectedRun.id] ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                        ) : (
                          <Trash2 className="h-4 w-4 shrink-0" aria-hidden />
                        )}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>

              {selectedRunId && runDetail?.run ? (
            <RunDetailPage
              className="min-h-0 min-w-0 flex-1"
              runDetail={runDetail}
              busy={busy}
              modelOptions={configuredRunModelOptions}
              keyboardShortcuts={keyboardShortcuts}
              pendingShellApproval={null}
              showActivity={runWorkspaceShowActivity}
              showDiff={runWorkspaceShowDiff}
              showTerminal={runWorkspaceShowTerminal}
              showBrowser={runWorkspaceShowBrowser}
              onTogglePanel={(panelId) => {
                if (panelId === "activity") toggleRunWorkspaceActivity();
                else if (panelId === "diff") toggleRunWorkspaceDiff();
                else if (panelId === "terminal") toggleRunWorkspaceTerminal();
                else if (panelId === "browser") toggleRunWorkspaceBrowser();
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
              onFollowUpRun={(run, prompt, options) => followUpRun(run, prompt, options)}
            />
          ) : selectedRunId ? (
            <Card className="flex min-h-[400px] flex-col items-center justify-center gap-4 p-8">
              <Loader2 className="h-10 w-10 animate-spin text-cyan-400" />
              <p className="text-sm text-zinc-500">Loading runâ€¦</p>
            </Card>
          ) : selectedProject ? (
            <ProjectPage
              project={selectedProject}
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
              onCreateTask={(input) => void createProjectTask(selectedProject.project.id, input)}
              onDeleteTask={(taskId) => void deleteProjectTask(taskId)}
              onStartTask={(prompt, modelId) => void submitRunFromPrompt(prompt, modelId)}
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
                  if (!easycode) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await easycode.runProjectLab({
                    projectId: selectedProject.project.id,
                    mode: input.mode,
                    baseBranch: input.baseBranch,
                    origin: "manual",
                  });
                  await loadSnapshot();
                })
              }
              onStartProjectLabImplementation={(threadId) =>
                void handleAction(async () => {
                  if (!easycode) {
                    throw new Error("The Electron desktop bridge is unavailable.");
                  }
                  await easycode.startProjectLabImplementation(threadId);
                  await loadSnapshot();
                })
              }
                onDeleteProjectLabThread={(threadId) =>
                  void handleAction(async () => {
                    if (!easycode) {
                      throw new Error("The Electron desktop bridge is unavailable.");
                    }
                    await easycode.deleteProjectLabThread(threadId);
                    await loadSnapshot();
                  })
                }
                onOpenProjectLabImplementation={(runId) => void handleRunSelect(selectedProject.project.id, runId)}
              />
              ) : (
                <Card className="p-8 text-center">
                  <p className="text-lg font-medium">No project selected</p>
                  <p className="mt-2 text-sm text-zinc-500">Open Settings to add your first project, provider, and model.</p>
                  <Button className="mt-4" variant="secondary" onClick={() => setSettingsOpen(true)}>
                    Open settings
                  </Button>
                </Card>
              )}
            </div>
          )}

        </section>
        </main>
      </div>

      {Object.keys(pendingDeleteRunIds).length > 0 ? (
        <div
          className="fixed bottom-6 left-1/2 z-[65] flex max-w-[min(90vw,24rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-cyan-500/35 bg-zinc-950/95 px-4 py-2 text-sm text-cyan-100 shadow-lg backdrop-blur"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" aria-hidden />
          <span>
            {Object.keys(pendingDeleteRunIds).length === 1
              ? "Deleting runâ€¦"
              : `Deleting ${Object.keys(pendingDeleteRunIds).length} runsâ€¦`}
          </span>
        </div>
      ) : null}

      {visibleShellApprovals.length > 0 ? (
        <div
          className="fixed bottom-4 right-4 z-[20040] flex w-[calc(100vw-2rem)] max-w-xl flex-col gap-2"
          role="region"
          aria-live="assertive"
          aria-label="Shell command approvals"
        >
          {visibleShellApprovals.map((request, index) => {
            const target = getShellApprovalTarget(request);
            const visibleStartedAt = visibleShellApprovalStartedAtById[request.requestId] ?? shellApprovalNow;
            const secondsRemaining = Math.max(0, Math.ceil((visibleStartedAt + 30_000 - shellApprovalNow) / 1000));

            return (
              <Card
                key={request.requestId}
                className="border-amber-500/35 bg-zinc-950/96 p-3 shadow-2xl shadow-amber-950/25 backdrop-blur"
              >
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-start gap-2.5">
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-1.5 text-amber-300">
                      <SquareTerminal className="h-3.5 w-3.5" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/90">
                          Shell approval needed
                        </p>
                        <span className="shrink-0 rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-100">
                          {secondsRemaining}s left
                        </span>
                        {visibleShellApprovals.length > 1 ? (
                          <span className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[10px] text-zinc-400">
                            {index + 1}/{shellApprovalQueue.length}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-sm font-medium text-zinc-100" title={target?.run.prompt ?? undefined}>
                        {target?.run.prompt ?? "Agent run is waiting for a command decision"}
                      </p>
                    </div>
                  </div>

                  <pre className="app-scrollbar max-h-20 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/90 px-2.5 py-2 text-[11px] leading-relaxed text-zinc-200">
                    {request.command}
                  </pre>

                  <div className="flex flex-col gap-2">
                    <p className="text-[11px] leading-snug text-zinc-500">
                      Outside the safe allowlist. Auto-denies if no decision is made.
                    </p>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 gap-1.5 border-cyan-500/25 bg-cyan-500/10 px-2.5 text-xs text-cyan-100 hover:bg-cyan-500/15"
                        onClick={() => void openShellApprovalRun(request)}
                        disabled={busy}
                      >
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        Go to run
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-8 px-2.5 text-xs" onClick={() => void respondToShellApproval(request, "deny")} disabled={busy}>
                        Deny
                      </Button>
                      <Button type="button" variant="secondary" size="sm" className="h-8 px-2.5 text-xs" onClick={() => void respondToShellApproval(request, "allow-once")} disabled={busy}>
                        Allow once
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 px-2.5 text-xs"
                        onClick={() => void respondToShellApproval(request, "allow-for-run")}
                        disabled={busy}
                        title="Remember this exact command until the run ends"
                      >
                        For this run
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 gap-1.5 px-2.5 text-xs"
                        onClick={() => void respondToShellApproval(request, "allow-always")}
                        disabled={busy}
                        title="Adds an exact-match regex for this command to Settings"
                      >
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        Always allow
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
          {queuedShellApprovalCount > 0 ? (
            <div className="self-end rounded-full border border-amber-500/25 bg-zinc-950/95 px-3 py-1 text-[11px] font-medium text-amber-100 shadow-lg backdrop-blur">
              {queuedShellApprovalCount} more approval{queuedShellApprovalCount === 1 ? "" : "s"} queued
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="fixed right-4 top-14 z-[20050] w-[calc(100vw-2rem)] max-w-md">
          <Card className="border-rose-500/40 bg-zinc-950/95 p-4 shadow-2xl shadow-rose-950/30 backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.25em] text-rose-300/80">Error</p>
                {isDetachedHeadProjectErrorMessage(error) && selectedProject ? (
                  <p className="mt-1.5 truncate text-sm font-medium text-zinc-100" title={selectedProject.project.name}>
                    Project: {selectedProject.project.name}
                  </p>
                ) : null}
                <p className="mt-2 text-sm text-rose-100">
                  {isDetachedHeadProjectErrorMessage(error) ? GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE : error}
                </p>
                {isDetachedHeadProjectErrorMessage(error) ? (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                    <label className="sr-only" htmlFor="error-detached-branch">
                      Branch to check out
                    </label>
                    <select
                      id="error-detached-branch"
                      className={cn(
                        "min-h-10 min-w-0 flex-1 rounded-lg border border-rose-500/25 bg-zinc-900 px-3 py-2 text-sm text-rose-50",
                        "focus:border-rose-400/50 focus:outline-none focus:ring-1 focus:ring-rose-500/30",
                      )}
                      value={detachedCheckoutBranch}
                      onChange={(event) => setDetachedCheckoutBranch(event.target.value)}
                      disabled={projectCheckoutBusy || availableRunBranches.length === 0}
                    >
                      {availableRunBranches.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="secondary"
                      className="shrink-0 border-rose-500/30 bg-rose-950/50 text-rose-100 hover:bg-rose-950/80"
                      disabled={projectCheckoutBusy || !detachedCheckoutBranch.trim()}
                      onClick={() => void submitCheckoutDetachedProjectBranch()}
                    >
                      {projectCheckoutBusy ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                          Checking outâ€¦
                        </>
                      ) : (
                        "Check out branch"
                      )}
                    </Button>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => {
                  setError(null);
                  setDetachedCheckoutBranch("");
                }}
                aria-label="Dismiss error notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Card>
        </div>
      ) : null}

      {appWarning ? (
        <div className="fixed right-4 top-14 z-[20040] w-[calc(100vw-2rem)] max-w-md">
          <Card className="border-amber-500/40 bg-zinc-950/95 p-4 shadow-2xl shadow-amber-950/30 backdrop-blur">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 p-2 text-amber-300">
                <AlertTriangle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.25em] text-amber-300/80">Warning</p>
                <p className="mt-1.5 text-sm font-medium text-zinc-100">{appWarning.title}</p>
                <p className="mt-2 text-sm text-amber-100">{appWarning.message}</p>
                {appWarning.detail ? (
                  <pre className="app-scrollbar mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-500/20 bg-zinc-900/80 p-2 text-xs text-amber-50/90">
                    {appWarning.detail}
                  </pre>
                ) : null}
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => setAppWarning(null)}
                aria-label="Dismiss warning notification"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </Card>
        </div>
      ) : null}

      {commitDialogRun ? (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
          onKeyDown={handleCommitDialogKeyDown}
        >
          <Card className="w-full max-w-xl p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Create commit</p>
            <h3 className="mt-2 text-xl font-semibold">{commitDialogRun.prompt}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Choose the commit message for this run&apos;s {commitDialogRun.workspaceType === "local" ? "local repository" : "worktree"} changes.
              <span className="mt-1 block text-[11px] text-zinc-600">Ctrl+Enter (âŒ˜+Enter on Mac) to commit.</span>
            </p>
            <div className="relative mt-4">
              <Textarea
                className="min-h-32 resize-y pr-11 font-mono text-sm leading-relaxed"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder={`Message (Ctrl+Enter to commit on "${commitDialogRun.branchName}")`}
                autoFocus
                rows={6}
                spellCheck={false}
              />
              <button
                type="button"
                className="absolute right-2 top-2 rounded-md border border-zinc-700 bg-zinc-900/95 p-2 text-zinc-400 shadow-sm transition hover:border-cyan-500/40 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                title="Generate commit message with AI"
                aria-label="Generate commit message with AI"
                disabled={busy || commitSuggestBusy}
                onClick={() => void suggestCommitMessageWithAi()}
              >
                {commitSuggestBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              </button>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={closeCommitDialog}>
                Cancel
              </Button>
              <Button onClick={() => void submitCommitRun()} disabled={busy || !commitMessage.trim()}>
                Create commit
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {publishDialogRun && publishOptions ? (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
          onKeyDown={handlePublishDialogKeyDown}
        >
          <Card className="w-full max-w-xl p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Create merge request / pull request</p>
            <h3 className="mt-2 text-xl font-semibold">{publishDialogRun.prompt}</h3>
            <p className="mt-1 text-sm text-zinc-500">Choose the source branch, target branch, and review the generated title before publishing.</p>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Source branch</span>
                <select
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pullRequestSourceBranchMode}
                  onChange={(event) => setPullRequestSourceBranchMode(event.target.value === "custom" ? "custom" : "worktree")}
                  onKeyDown={handlePublishDialogKeyDown}
                >
                  <option value="worktree">Keep worktree branch ({publishOptions.defaultSourceBranch})</option>
                  <option value="custom">Create and use a custom branch</option>
                </select>
              </label>
              {pullRequestSourceBranchMode === "custom" ? (
                <label className="block text-sm">
                  <span className="mb-1 block text-zinc-300">Custom source branch name</span>
                  <Input
                    value={pullRequestSourceBranchName}
                    onChange={(event) => setPullRequestSourceBranchName(event.target.value)}
                    onKeyDown={handlePublishDialogKeyDown}
                    placeholder="feature/my-custom-branch"
                    autoFocus
                  />
                </label>
              ) : null}
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Target branch</span>
                <select
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={pullRequestTargetBranch}
                  onChange={(event) => setPullRequestTargetBranch(event.target.value)}
                  onKeyDown={handlePublishDialogKeyDown}
                >
                  {publishOptions.targetBranches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Merge request / pull request title</span>
                <Input
                  value={pullRequestTitle}
                  onChange={(event) => setPullRequestTitle(event.target.value)}
                  onKeyDown={handlePublishDialogKeyDown}
                  placeholder="Merge request / pull request title"
                  autoFocus={pullRequestSourceBranchMode !== "custom"}
                />
              </label>
              <label className="block text-sm">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span className="block text-zinc-300">Merge request / pull request description</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void generatePullRequestDescription()}
                    disabled={busy || pullRequestDescriptionBusy || !pullRequestTitle.trim() || !pullRequestTargetBranch.trim()}
                  >
                    {pullRequestDescriptionBusy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Generate
                  </Button>
                </div>
                <Textarea
                  value={pullRequestDescription}
                  onChange={(event) => setPullRequestDescription(event.target.value)}
                  onKeyDown={handlePublishDialogKeyDown}
                  placeholder="Merge request / pull request description"
                  className="min-h-36"
                />
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={closePublishDialog}>
                Cancel
              </Button>
              <Button
                onClick={() => void submitPullRequest()}
                disabled={
                  busy ||
                  !pullRequestTitle.trim() ||
                  !pullRequestTargetBranch.trim() ||
                  (pullRequestSourceBranchMode === "custom" && !pullRequestSourceBranchName.trim())
                }
              >
                Create MR / PR
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {branchPublishDialogRun ? (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
          onKeyDown={handleBranchPublishDialogKeyDown}
        >
          <Card className="w-full max-w-md p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">
              {branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
            </p>
            <h3 className="mt-2 text-xl font-semibold">{branchPublishDialogRun.prompt}</h3>
            <label className="mt-4 block text-sm">
              <span className="mb-1 block text-zinc-300">Branch name</span>
              <Input
                value={branchPublishName}
                onChange={(event) => setBranchPublishName(event.target.value)}
                placeholder="feature/my-custom-branch"
                autoFocus
              />
            </label>
            <div className="mt-4 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={closeBranchPublishDialog}>
                Cancel
              </Button>
              <Button
                onClick={() => void publishBranch()}
                disabled={
                  busy ||
                  !branchPublishName.trim() ||
                  (branchPublishMode === "local" &&
                    branchPublishDialogRun.workspaceType !== "worktree" &&
                    branchPublishName.trim() === branchPublishDialogRun.branchName)
                }
              >
                {branchPublishMode === "local" ? "Create local branch" : "Publish branch"}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {continueDialogRun ? (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeContinueRunDialog();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.preventDefault();
              void submitContinueRun();
            }
          }}
        >
          <Card className="w-full max-w-xl p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Continue run</p>
            <h3 className="mt-2 text-xl font-semibold">{continueDialogRun.prompt}</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Start a new run from branch <span className="font-medium text-zinc-300">{continueDialogRun.branchName}</span> in a fresh worktree.
            </p>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Continuation prompt</span>
                <Textarea
                  value={continuePrompt}
                  onChange={(event) => setContinuePrompt(event.target.value)}
                  placeholder="Continue from the current state and..."
                  className="min-h-28"
                  autoFocus
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-zinc-300">Model</span>
                <select
                  className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-sm"
                  value={continueModelId}
                  onChange={(event) => setContinueModelId(event.target.value)}
                >
                  {configuredRunModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border border-zinc-700 bg-zinc-950 accent-cyan-400"
                  checked={continueIncludeWorkspaceChanges}
                  onChange={(event) => setContinueIncludeWorkspaceChanges(event.target.checked)}
                />
                <span>Include the source run&apos;s current workspace changes</span>
              </label>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={closeContinueRunDialog}>
                Cancel
              </Button>
              <Button onClick={() => void submitContinueRun()} disabled={busy || !continuePrompt.trim() || !continueModelId}>
                Start continuation
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {confirmDialog ? (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-6 backdrop-blur-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              resolveConfirmation(false);
            }
          }}
        >
          <Card className="w-full max-w-lg p-5">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Confirm action</p>
            <h3 className="mt-2 text-xl font-semibold text-zinc-100">{confirmDialog.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">{confirmDialog.message}</p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={() => resolveConfirmation(false)} autoFocus>
                Cancel
              </Button>
              <Button
                variant={confirmDialog.confirmVariant ?? "default"}
                onClick={() => resolveConfirmation(true)}
              >
                {confirmDialog.confirmLabel}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

    </div>
  );
};
