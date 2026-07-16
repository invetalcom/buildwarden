import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { getDefaultDatabasePath, BuildWardenDatabase } from "@buildwarden/db";
import {
  RemoteAccessServer,
  RemoteAuthService,
  RemoteOperationRegistry,
  defineRemoteArgsValidator,
  validateNoRemoteArgs,
  type RemoteHostEventSource,
} from "@buildwarden/remote-server";
import {
  APP_SETTING_KEYS,
  IPC_CHANNELS,
  isUiTheme,
  parseSupportedIdeKind,
  parseRemoteAccessEnabledSetting,
  parseRemoteAccessWebOriginsSetting,
  normalizeRemoteAccessWebOrigin,
  parseUiTheme,
  uiThemeToLegacyDarkMode,
  WINDOWS_TITLEBAR_OVERLAY_BACKGROUND,
  WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
  type AppMenuSection,
  type ChatInput,
  type ListAvailableProviderModelsInput,
  type ModelInput,
  type NetworkProxySettingsInput,
  type ProjectInput,
  type ProjectForgePrMonitorConfig,
  type ProjectForgeRequestNotificationPayload,
  type ProviderAccountInput,
  type RemoteAccessPairingInput,
  type RendererLogPayload,
  type RunChatInput,
  type RunInput,
  type RunWorkspaceFileInput,
  type UiTheme,
} from "@buildwarden/shared";
import { AppController } from "./app-controller";
import { getAppLogDirPath, initializeAppLogger, logError, logInfo, logWarn } from "./logger";
import { ElectronSecretStore } from "./secret-store";
import { registerRunTerminalIpc } from "./run-terminal-ipc";
import { ElectronDesktopPlatformServices, isAppNavigationUrl, isSafeExternalUrl } from "./electron-desktop-platform";
import { HostEventBus } from "./host-events";
import { registerHostEventIpc } from "./host-events-ipc";
import { HostTerminalService } from "./host-terminal-service";
import { TailscaleServeService } from "./tailscale-serve-service";
import { HostDirectoryService } from "./host-directory-service";
import { HostBrowserService } from "./host-browser-service";

const mainDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
const USE_CUSTOM_WINDOWS_TITLEBAR = process.platform === "win32";
const PROD_DB_FILE_NAME = "buildwarden.sqlite";
const DEV_DB_FILE_NAME = "buildwarden_dev.sqlite";
const PROD_SECRETS_FILE_NAME = "secrets.json";
const DEV_SECRETS_FILE_NAME = "secrets_dev.json";
let currentUiTheme: UiTheme = "dark";

const focusMainWindow = (): void => {
  if (!mainWindow) {
    createMainWindow(currentUiTheme);
  }
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
};

const hostEvents = new HostEventBus();
const hostTerminal = new HostTerminalService();
const desktopPlatform = new ElectronDesktopPlatformServices(() => mainWindow, focusMainWindow);

const publishProjectForgeRequestOpen = (payload: { projectId: string; prUrl: string }): void => {
  focusMainWindow();
  const publish = () => hostEvents.publish("forgeRequestOpen", payload);
  if (mainWindow?.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", publish);
    return;
  }
  publish();
};

type ProjectForgeMonitorState = {
  intervalMinutes: number;
  timer: ReturnType<typeof setInterval>;
  seenRequestKeys: Set<string>;
  baselineComplete: boolean;
  inFlight: boolean;
};

const projectForgeMonitorStates = new Map<string, ProjectForgeMonitorState>();

const projectForgeRequestKey = (item: { provider: string; number: number }): string => `${item.provider}:${String(item.number)}`;

const runProjectForgeMonitorCheck = async (
  controller: AppController,
  config: ProjectForgePrMonitorConfig,
): Promise<void> => {
  const state = projectForgeMonitorStates.get(config.projectId);
  if (!state || state.inFlight) {
    return;
  }

  state.inFlight = true;
  try {
    const result = await controller.listProjectForgeRequests(config.projectId, { state: "open" });
    try {
      const changedTasks = await controller.syncProjectTaskPullRequestStatuses(config.projectId);
      for (const task of changedTasks) {
        hostEvents.publish("task", {
          projectId: task.projectId,
          taskId: task.id,
          status: task.status,
        });
      }
    } catch (error) {
      logWarn("Failed to reconcile task statuses; continuing PR/MR notification check.", {
        projectId: config.projectId,
        projectName: config.projectName,
        provider: config.provider,
        error,
      });
    }
    const openRequests = result.items.filter((item) => item.state === "open");
    const currentKeys = new Set(openRequests.map(projectForgeRequestKey));

    if (!state.baselineComplete) {
      state.seenRequestKeys = currentKeys;
      state.baselineComplete = true;
      return;
    }

    const newRequests = openRequests.filter((item) => !state.seenRequestKeys.has(projectForgeRequestKey(item)));
    state.seenRequestKeys = new Set([...state.seenRequestKeys, ...currentKeys]);

    for (const item of newRequests) {
      const payload: ProjectForgeRequestNotificationPayload = {
        projectId: config.projectId,
        prUrl: item.url,
        projectName: config.projectName,
        repoLabel: config.repoLabel,
        title: item.title,
        author: item.author,
        providerLabel: config.provider === "gitlab" ? "MR" : "PR",
      };
      hostEvents.publish("forgeRequestNotification", payload);
      desktopPlatform.showProjectForgeRequestNotification({
        payload,
        onOpen: () => publishProjectForgeRequestOpen(payload),
      });
    }
  } catch (error) {
    logWarn("Failed to check Git hosting for new open PRs/MRs.", {
      projectId: config.projectId,
      projectName: config.projectName,
      provider: config.provider,
      error,
    });
  } finally {
    const latest = projectForgeMonitorStates.get(config.projectId);
    if (latest) {
      latest.inFlight = false;
    }
  }
};

const refreshProjectForgePrMonitors = async (controller: AppController): Promise<void> => {
  const configs = await controller.listProjectForgePrMonitorConfigs();
  const activeProjectIds = new Set(configs.map((config) => config.projectId));

  for (const [projectId, state] of projectForgeMonitorStates) {
    if (!activeProjectIds.has(projectId)) {
      clearInterval(state.timer);
      projectForgeMonitorStates.delete(projectId);
    }
  }

  for (const config of configs) {
    const current = projectForgeMonitorStates.get(config.projectId);
    if (current && current.intervalMinutes === config.intervalMinutes) {
      continue;
    }
    if (current) {
      clearInterval(current.timer);
    }

    const timer = setInterval(() => {
      void runProjectForgeMonitorCheck(controller, config);
    }, config.intervalMinutes * 60_000);

    projectForgeMonitorStates.set(config.projectId, {
      intervalMinutes: config.intervalMinutes,
      timer,
      seenRequestKeys: new Set(),
      baselineComplete: false,
      inFlight: false,
    });

    void runProjectForgeMonitorCheck(controller, config);
  }
};

const getAppIconPath = (): string | undefined => {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  const candidate = app.isPackaged ? join(process.resourcesPath, "icons", iconFile) : join(mainDir, "../../build", iconFile);
  return existsSync(candidate) ? candidate : undefined;
};

try {
  app.setAppLogsPath();
  initializeAppLogger(app.getPath("logs"));
} catch (error) {
  console.error("[buildwarden:error] Failed to set Electron logs path", error);
}

const getWindowThemeColors = (theme: UiTheme) => {
  const caption = WINDOWS_TITLEBAR_OVERLAY_BACKGROUND[theme];
  if (theme === "light") {
    return {
      backgroundColor: "#c4d9ec",
      titleBarOverlay: {
        color: caption,
        symbolColor: "#1c2733",
        height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
      },
    };
  }
  return {
    backgroundColor: "#0b0d0e",
    titleBarOverlay: {
      color: caption,
      symbolColor: "#f2f5f7",
      height: WINDOWS_TITLEBAR_OVERLAY_HEIGHT,
    },
  };
};

const applyWindowTheme = (theme: UiTheme) => {
  if (!mainWindow) {
    return;
  }

  const colors = getWindowThemeColors(theme);
  mainWindow.setBackgroundColor(colors.backgroundColor);
  if (USE_CUSTOM_WINDOWS_TITLEBAR) {
    mainWindow.setTitleBarOverlay(colors.titleBarOverlay);
  }
};

/**
 * Last applied theme, cached outside the database so the window can be created
 * with the right chrome immediately at boot, before the database has loaded.
 */
const themeCachePath = (): string => join(app.getPath("userData"), "window-theme.json");

const readCachedUiTheme = (): UiTheme => {
  try {
    const raw = JSON.parse(readFileSync(themeCachePath(), "utf8")) as { uiTheme?: unknown };
    return isUiTheme(raw.uiTheme) ? raw.uiTheme : "dark";
  } catch {
    return "dark";
  }
};

const writeCachedUiTheme = (theme: UiTheme): void => {
  try {
    writeFileSync(themeCachePath(), JSON.stringify({ uiTheme: theme }));
  } catch {
    // Best-effort cache; boot falls back to dark when missing.
  }
};

const bootstrap = async (): Promise<void> => {
  const bootStartedAt = Date.now();
  const userDataPath = app.getPath("userData");
  const logDirPath = app.getPath("logs");
  const isDevelopmentDataMode = !app.isPackaged;
  const dataDirPath = join(userDataPath, "data");
  const databaseFileName = isDevelopmentDataMode ? DEV_DB_FILE_NAME : PROD_DB_FILE_NAME;
  const secretsFileName = isDevelopmentDataMode ? DEV_SECRETS_FILE_NAME : PROD_SECRETS_FILE_NAME;
  initializeAppLogger(logDirPath);
  logInfo("Bootstrapping BuildWarden main process.", {
    userDataPath,
    logDirPath,
    dataMode: isDevelopmentDataMode ? "development" : "production",
    databaseFileName,
    secretsFileName,
    platform: process.platform,
    version: app.getVersion(),
    processUptimeMs: Math.round(process.uptime() * 1000),
  });

  // Show the window and start loading the renderer immediately; the database
  // and controller initialize in parallel. The preload bridge retries briefly
  // when an IPC handler has not been registered yet.
  currentUiTheme = readCachedUiTheme();
  createMainWindow(currentUiTheme);
  const windowCreatedAt = Date.now();

  const db = new BuildWardenDatabase(getDefaultDatabasePath(dataDirPath, databaseFileName));
  await db.init();
  const dbReadyAt = Date.now();

  const secretStore = new ElectronSecretStore(join(dataDirPath, secretsFileName));
  const controller = new AppController(
    db,
    secretStore,
    logDirPath,
    desktopPlatform,
    hostTerminal,
    hostEvents,
  );
  const hostDirectory = new HostDirectoryService();
  const hostBrowser = new HostBrowserService({
    getMainWindow: () => mainWindow,
    resolveRunProjectId: async (runId) => (await controller.getRunDetail(runId)).run.projectId,
  });
  hostBrowser.onEvent((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.runBrowserEvent, event);
    }
  });
  mainWindow?.on("focus", () => hostBrowser.setDesktopWindowVisible(true));
  mainWindow?.on("show", () => hostBrowser.setDesktopWindowVisible(true));
  mainWindow?.on("restore", () => hostBrowser.setDesktopWindowVisible(true));
  mainWindow?.on("blur", () => hostBrowser.setDesktopWindowVisible(false));
  mainWindow?.on("hide", () => hostBrowser.setDesktopWindowVisible(false));
  mainWindow?.on("minimize", () => hostBrowser.setDesktopWindowVisible(false));
  const startupReconciliation = controller
    .migrateProjectBaseBranches()
    .then(() => controller.reconcileOrphanedActiveSessions())
    .then(() => {
      // Loops persist their full progress; re-enter their state machines only after the
      // interrupted-run reconciliation marked orphaned sessions terminal. Resuming on a
      // failed reconciliation could leave the runner waiting forever on a stale
      // "running" loop-iteration run that has no worker.
      controller.resumeActiveProjectLoops();
    })
    .catch((error) => {
      logError("Failed to migrate project state or reconcile active sessions during startup; active loops were not auto-resumed.", { error });
    });

  const applyUiTheme = async (next: UiTheme) => {
    await controller.setAppSetting(APP_SETTING_KEYS.uiTheme, next);
    await controller.setAppSetting(APP_SETTING_KEYS.darkMode, uiThemeToLegacyDarkMode(next));
    currentUiTheme = parseUiTheme(db.getSettings());
    writeCachedUiTheme(currentUiTheme);
    desktopPlatform.installApplicationMenu({
      logDirPath,
      theme: currentUiTheme,
      onCommand: (command) => hostEvents.publish("appMenuCommand", command),
      onThemeChange: (theme) => void applyUiTheme(theme),
    });
    applyWindowTheme(currentUiTheme);
    hostEvents.publish("appSettingsChanged", undefined);
  };

  const refreshAppMenu = () => {
    currentUiTheme = parseUiTheme(db.getSettings());
    writeCachedUiTheme(currentUiTheme);
    desktopPlatform.installApplicationMenu({
      logDirPath,
      theme: currentUiTheme,
      onCommand: (command) => hostEvents.publish("appMenuCommand", command),
      onThemeChange: (theme) => void applyUiTheme(theme),
    });
    applyWindowTheme(currentUiTheme);
  };
  refreshAppMenu();

  const remoteOperations = new RemoteOperationRegistry(({ method, requestId, error }) => {
    logError("Remote operation failed.", { method, requestId, error });
  }, db);
  remoteOperations.register("getSnapshot", async () => {
    await startupReconciliation;
    return controller.getSnapshot();
  }, validateNoRemoteArgs);
  remoteOperations.register("refreshSnapshot", async () => {
    await startupReconciliation;
    return controller.refreshSnapshot();
  }, validateNoRemoteArgs);

  const validateSingleRemoteStringArg = (args: unknown[]): args is [string] =>
    args.length === 1 && typeof args[0] === "string";
  const validateRunWorkspaceFileRemoteArgs = (args: unknown[]): args is [RunWorkspaceFileInput] => {
    const input = args[0];
    return args.length === 1 && input != null && typeof input === "object" && !Array.isArray(input) &&
      typeof (input as Record<string, unknown>).runId === "string" &&
      typeof (input as Record<string, unknown>).path === "string";
  };
  const validateRemoteStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  remoteOperations.register("getProjectBranches", (projectId) => controller.getProjectBranches(projectId), validateSingleRemoteStringArg);
  remoteOperations.register("getProjectCurrentBranch", (projectId) => controller.getProjectCurrentBranch(projectId), validateSingleRemoteStringArg);
  remoteOperations.register("getRunDetail", (runId) => controller.getRunDetail(runId), validateSingleRemoteStringArg);
  remoteOperations.register("getRunWorktreeDiff", (runId) => controller.getRunWorktreeDiff(runId), validateSingleRemoteStringArg);
  remoteOperations.register("getRunWorkspaceFile", (input) => controller.getRunWorkspaceFile(input), validateRunWorkspaceFileRemoteArgs);
  remoteOperations.register("getProjectLoopUiReviewImage", (reviewId) => controller.getProjectLoopUiReviewImage(reviewId), validateSingleRemoteStringArg);
  remoteOperations.register("getChatDetail", (chatId) => controller.getChatDetail(chatId), validateSingleRemoteStringArg);
  remoteOperations.register("listChatsWithSteps", () => controller.listChatsWithSteps(), validateNoRemoteArgs);
  remoteOperations.register("getBookmarksWithSteps", () => controller.getBookmarksWithSteps(), validateNoRemoteArgs);
  remoteOperations.register("getChatBookmarksWithSteps", () => controller.getChatBookmarksWithSteps(), validateNoRemoteArgs);

  const isRemoteRecord = (value: unknown): value is Record<string, unknown> =>
    value != null && typeof value === "object" && !Array.isArray(value);
  const hasRemoteStringFields = (value: unknown, fields: string[]): boolean =>
    isRemoteRecord(value) && fields.every((field) => typeof value[field] === "string");
  const optionalRemoteRecord = (value: unknown): boolean => value === undefined || isRemoteRecord(value);
  const validateTwoRemoteStrings = defineRemoteArgsValidator<"commitRun">(
    (args) => args.length === 2 && args.every((value) => typeof value === "string"),
  );
  const validateRunInput = defineRemoteArgsValidator<"createRun">(
    (args) => args.length === 1 && hasRemoteStringFields(
      args[0],
      ["projectId", "providerAccountId", "modelId", "harnessType", "mode", "workspaceType", "prompt"],
    ),
  );
  const validateContinueRunInput = defineRemoteArgsValidator<"continueRun">(
    (args) => args.length === 1 && hasRemoteStringFields(
      args[0],
      ["sourceRunId", "providerAccountId", "modelId", "harnessType", "mode", "prompt"],
    ),
  );
  const validateFollowUpRun = defineRemoteArgsValidator<"followUpRun">(
    (args) => (args.length === 2 || args.length === 3) && typeof args[0] === "string" &&
      typeof args[1] === "string" && optionalRemoteRecord(args[2]),
  );
  const validateFollowUpChat = defineRemoteArgsValidator<"followUpChat">(
    (args) => (args.length === 2 || args.length === 3) && typeof args[0] === "string" &&
      typeof args[1] === "string" && optionalRemoteRecord(args[2]),
  );
  const validateShellApproval = defineRemoteArgsValidator<"respondToShellApproval">((args) => {
    // Persistent allowlist changes remain a trusted desktop-only operation.
    const decisions = new Set(["allow-once", "allow-for-run", "deny"]);
    return (args.length === 3 || args.length === 4) && typeof args[0] === "string" &&
      typeof args[1] === "string" && typeof args[2] === "string" && decisions.has(args[2]) && optionalRemoteRecord(args[3]);
  });
  const validateUserInput = defineRemoteArgsValidator<"respondToRunUserInput">((args) =>
    args.length === 3 && typeof args[0] === "string" && typeof args[1] === "string" && isRemoteRecord(args[2]) &&
    Object.values(args[2]).every((answer) => typeof answer === "string" ||
      (Array.isArray(answer) && answer.every((item) => typeof item === "string"))));
  const validateChatInput = defineRemoteArgsValidator<"createChat">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["providerAccountId", "modelId", "prompt"]),
  );
  const validateOptionalSecondString = defineRemoteArgsValidator<"publishRunBranch">(
    (args) => (args.length === 1 || args.length === 2) && typeof args[0] === "string" &&
      (args[1] === undefined || typeof args[1] === "string"),
  );
  const validatePullRequest = defineRemoteArgsValidator<"createRunPullRequest">(
    (args) => args.length >= 3 && args.length <= 5 && args.slice(0, 3).every((value) => typeof value === "string") &&
      args.slice(3).every((value) => value === undefined || typeof value === "string"),
  );
  const validateProjectInput = defineRemoteArgsValidator<"addProject">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["repoPath"]) &&
      (!isRemoteRecord(args[0]) || args[0].name === undefined || typeof args[0].name === "string"),
  );
  const validateHostDirectoryInput = defineRemoteArgsValidator<"listHostDirectories">(
    (args) => args.length === 0 || (args.length === 1 && (args[0] === undefined ||
      (isRemoteRecord(args[0]) && (args[0].path === undefined || typeof args[0].path === "string")))),
  );
  const validateProjectAndBranchInput = <Method extends
    "createProjectBranch" | "renameProjectBranch" | "deleteProjectBranch" | "pushProjectBranch" | "getProjectBranchDeleteImpact">(
    fields: string[],
  ) => defineRemoteArgsValidator<Method>(
    (args) => args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], fields),
  );
  const validateTerminalStart = defineRemoteArgsValidator<"runTerminalStart">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["sessionId", "cwd"]),
  );
  const validateRunBrowserEnsure = defineRemoteArgsValidator<"ensureRunBrowser">((args) => {
    if (args.length !== 1 || !isRemoteRecord(args[0]) || typeof args[0].runId !== "string" || !isRemoteRecord(args[0].viewport)) return false;
    const viewport = args[0].viewport;
    return typeof viewport.width === "number" && Number.isFinite(viewport.width) && viewport.width >= 1 && viewport.width <= 4_096 &&
      typeof viewport.height === "number" && Number.isFinite(viewport.height) && viewport.height >= 1 && viewport.height <= 4_096 &&
      (args[0].initialUrl === undefined || typeof args[0].initialUrl === "string");
  });
  const validateRunBrowserNavigate = defineRemoteArgsValidator<"navigateRunBrowser">((args) =>
    args.length === 1 && hasRemoteStringFields(args[0], ["runId", "url"]));
  const validateRunBrowserAction = defineRemoteArgsValidator<"runBrowserAction">((args) =>
    args.length === 1 && isRemoteRecord(args[0]) && typeof args[0].runId === "string" &&
    ["back", "forward", "reload", "stop", "start-inspect", "cancel-inspect"].includes(String(args[0].action)));
  const validateRunBrowserViewport = defineRemoteArgsValidator<"setRunBrowserViewport">((args) => {
    if (args.length !== 1 || !isRemoteRecord(args[0]) || typeof args[0].runId !== "string" || !isRemoteRecord(args[0].viewport)) return false;
    const viewport = args[0].viewport;
    return typeof viewport.width === "number" && Number.isFinite(viewport.width) && viewport.width >= 1 && viewport.width <= 4_096 &&
      typeof viewport.height === "number" && Number.isFinite(viewport.height) && viewport.height >= 1 && viewport.height <= 4_096;
  });
  const validateRunBrowserCapture = defineRemoteArgsValidator<"getRunBrowserElementCapture">((args) =>
    args.length === 1 && hasRemoteStringFields(args[0], ["runId", "captureId"]));
  const validateTerminalWrite = defineRemoteArgsValidator<"runTerminalWrite">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["sessionId", "data"]) &&
      isRemoteRecord(args[0]) && String(args[0].data).length <= 65_536,
  );
  const validateTerminalResize = defineRemoteArgsValidator<"runTerminalResize">(
    (args) => args.length === 1 && isRemoteRecord(args[0]) && typeof args[0].sessionId === "string" &&
      Number.isInteger(args[0].cols) && Number.isInteger(args[0].rows) && Number(args[0].cols) >= 10 &&
      Number(args[0].cols) <= 500 && Number(args[0].rows) >= 2 && Number(args[0].rows) <= 300,
  );
  const validateProjectTaskCreate = defineRemoteArgsValidator<"createProjectTask">(
    (args) => args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["title", "prompt"]),
  );
  const validateProjectTaskUpdate = defineRemoteArgsValidator<"updateProjectTask">((args) => {
    if (args.length !== 2 || typeof args[0] !== "string" || !isRemoteRecord(args[1])) return false;
    const input = args[1];
    const statuses = new Set(["open", "in_progress", "in_review", "done"]);
    return (input.title === undefined || typeof input.title === "string") &&
      (input.prompt === undefined || typeof input.prompt === "string") &&
      (input.status === undefined || (typeof input.status === "string" && statuses.has(input.status)));
  });
  const validateProjectTaskPrompt = defineRemoteArgsValidator<"generateProjectTaskRunPrompt">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["projectId", "title", "notes", "modelId"]),
  );
  const validateProjectInsight = defineRemoteArgsValidator<"generateProjectInsight">((args) => {
    if (args.length !== 1 || !hasRemoteStringFields(args[0], ["projectId", "kind"])) return false;
    const input = args[0] as Record<string, unknown>;
    const kinds = new Set([
      "architecture-graph", "dependency-gravity", "repo-historian", "codebase-mood", "curiosity-mode", "narrative-branching",
    ]);
    return kinds.has(String(input.kind)) && (input.modelId === undefined || typeof input.modelId === "string");
  });
  const validateProjectLabRun = defineRemoteArgsValidator<"runProjectLab">((args) => {
    if (args.length !== 1 || !hasRemoteStringFields(args[0], ["projectId"])) return false;
    const input = args[0] as Record<string, unknown>;
    return (input.mode === undefined || ["new-feature", "bugfix", "refactoring", "rfc-only"].includes(String(input.mode))) &&
      (input.origin === undefined || ["manual", "idle", "task"].includes(String(input.origin))) &&
      ["baseBranch", "topic", "implementationModelId", "reviewModelId"].every((field) =>
        input[field] === undefined || input[field] === null || typeof input[field] === "string");
  });
  const validateProjectLoopCreate = defineRemoteArgsValidator<"createProjectLoop">((args) => {
    if (args.length !== 1 || !hasRemoteStringFields(
      args[0], ["projectId", "name", "prompt", "runnerModelId", "mergePolicy", "uiChangePolicy"],
    )) return false;
    const input = args[0] as Record<string, unknown>;
    return ["auto-merge", "wait-for-approval"].includes(String(input.mergePolicy)) &&
      ["auto", "manual-approval", "ai-review"].includes(String(input.uiChangePolicy)) &&
      (input.prReviewPolicy === undefined || ["none", "ai-review"].includes(String(input.prReviewPolicy))) &&
      ["reviewModelId", "uiReviewInstructions", "baseBranch"].every((field) =>
        input[field] === undefined || input[field] === null || typeof input[field] === "string");
  });
  const validateLoopUiReview = defineRemoteArgsValidator<"respondToProjectLoopUiReview">((args) =>
    args.length === 2 && typeof args[0] === "string" && isRemoteRecord(args[1]) &&
    (args[1].decision === "approve" || args[1].decision === "request-changes") &&
    (args[1].feedback === undefined || typeof args[1].feedback === "string"));
  const validateForgeRequestDetails = defineRemoteArgsValidator<"getProjectForgeRequestDetails">(
    (args) => args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["prUrl"]),
  );
  const validateFetchForgeDiff = defineRemoteArgsValidator<"fetchProjectPrMrDiff">((args) => {
    if (args.length !== 2 || typeof args[0] !== "string" || !hasRemoteStringFields(args[1], ["prUrl"]) ||
      !isRemoteRecord(args[1])) return false;
    const input = args[1];
    return ["baseBranch", "commitSha"].every((field) => input[field] === undefined || typeof input[field] === "string");
  });
  const validateAnalyzeForgeDiff = defineRemoteArgsValidator<"analyzeProjectPrMrDiff">((args) =>
    args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["prUrl", "diff"]) &&
    isRemoteRecord(args[1]) && (args[1].modelId === undefined || typeof args[1].modelId === "string"));
  const validateListForgeRequests = defineRemoteArgsValidator<"listProjectForgeRequests">(
    (args) => (args.length === 1 || args.length === 2) && typeof args[0] === "string" &&
      (args[1] === undefined || (isRemoteRecord(args[1]) &&
        (args[1].state === undefined || ["open", "closed", "merged", "all"].includes(String(args[1].state))))),
  );
  const validatePostForgeReview = defineRemoteArgsValidator<"postProjectPrMrReview">((args) =>
    args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["prUrl", "body", "event"]) &&
    isRemoteRecord(args[1]) && (args[1].event === "comment" || args[1].event === "approve"));
  const validateSubmitForgeComments = defineRemoteArgsValidator<"submitProjectPrMrComments">((args) => {
    if (args.length !== 2 || typeof args[0] !== "string" || !hasRemoteStringFields(args[1], ["prUrl"]) ||
      !isRemoteRecord(args[1]) || !Array.isArray(args[1].comments)) return false;
    const input = args[1];
    const comments = input.comments;
    const validLineNumber = (value: unknown) => value === null || Number.isInteger(value);
    return (input.body === undefined || typeof input.body === "string") &&
      (input.mode === undefined || input.mode === "review" || input.mode === "single") &&
      Array.isArray(comments) && comments.length <= 500 && comments.every((comment: unknown) =>
        hasRemoteStringFields(comment, ["oldPath", "newPath", "side", "changeType", "body"]) && isRemoteRecord(comment) &&
        (comment.side === "old" || comment.side === "new") &&
        ["insert", "delete", "normal"].includes(String(comment.changeType)) &&
        validLineNumber(comment.oldLineNumber) && validLineNumber(comment.newLineNumber));
  });
  const validateResolveForgeThread = defineRemoteArgsValidator<"resolveProjectPrMrReviewThread">((args) =>
    args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["prUrl", "threadId"]) &&
    isRemoteRecord(args[1]) && typeof args[1].resolved === "boolean");
  const validateReplyForgeThread = defineRemoteArgsValidator<"replyProjectPrMrReviewThread">((args) =>
    args.length === 2 && typeof args[0] === "string" && hasRemoteStringFields(args[1], ["prUrl", "threadId", "body"]) &&
    isRemoteRecord(args[1]) && (args[1].replyToCommentId === undefined || args[1].replyToCommentId === null ||
      typeof args[1].replyToCommentId === "string"));
  const validateStringArrayArg = defineRemoteArgsValidator<"reorderProjects">(
    (args) => args.length === 1 && validateRemoteStringArray(args[0]),
  );
  const validateProviderAccount = defineRemoteArgsValidator<"addProviderAccount">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["providerType", "label", "apiKey"]) &&
      isRemoteRecord(args[0]) && ["ai-sdk", "azure-legacy", "codex-cli", "claude-code", "cursor-agent"].includes(String(args[0].providerType)) &&
      (args[0].apiBaseUrl === undefined || args[0].apiBaseUrl === null || typeof args[0].apiBaseUrl === "string") &&
      (args[0].config === undefined || isRemoteRecord(args[0].config)),
  );
  const validateModel = defineRemoteArgsValidator<"addModel">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["providerAccountId", "modelId", "displayName"]) &&
      isRemoteRecord(args[0]) &&
      (args[0].baseUrlOverride === undefined || args[0].baseUrlOverride === null || typeof args[0].baseUrlOverride === "string") &&
      (args[0].config === undefined || isRemoteRecord(args[0].config)) &&
      (args[0].capabilities === undefined || isRemoteRecord(args[0].capabilities)) &&
      (args[0].enabled === undefined || typeof args[0].enabled === "boolean"),
  );
  const validateAvailableProviderModels = defineRemoteArgsValidator<"listAvailableProviderModels">(
    (args) => args.length === 1 && hasRemoteStringFields(args[0], ["providerAccountId"]),
  );
  const remoteAppSettingKeys = new Set<string>(Object.values(APP_SETTING_KEYS).filter((key) =>
    key !== APP_SETTING_KEYS.remoteAccessEnabled &&
    key !== APP_SETTING_KEYS.remoteAccessTailscaleEnabled &&
    key !== APP_SETTING_KEYS.remoteAccessWebOrigins));
  const validateAppSetting = defineRemoteArgsValidator<"setAppSetting">(
    (args) => args.length === 2 && typeof args[0] === "string" && remoteAppSettingKeys.has(args[0]) &&
      typeof args[1] === "string" && args[1].length <= 1_000_000,
  );
  const validateNetworkProxySettings = defineRemoteArgsValidator<"saveNetworkProxySettings">((args) => {
    if (args.length !== 1 || !isRemoteRecord(args[0])) return false;
    const input = args[0];
    return typeof input.enabled === "boolean" && (input.protocol === "http" || input.protocol === "https") &&
      ["host", "port", "username"].every((field) => typeof input[field] === "string") &&
      (input.password === undefined || typeof input.password === "string") &&
      (input.clearSavedPassword === undefined || typeof input.clearSavedPassword === "boolean");
  });
  const validateForgeMonitorSettings = defineRemoteArgsValidator<"saveProjectForgePrMonitorSettings">((args) =>
    args.length === 2 && typeof args[0] === "string" && isRemoteRecord(args[1]) &&
    Number.isFinite(args[1].intervalMinutes) && Number(args[1].intervalMinutes) >= 0);

  remoteOperations.register("getRunPublishOptions", (runId) => controller.getRunPublishOptions(runId), validateSingleRemoteStringArg);
  remoteOperations.register("getProjectBranchOverview", (projectId) => controller.getProjectBranchOverview(projectId), validateSingleRemoteStringArg);
  remoteOperations.register("getProjectForgeAuthStatus", (projectId) => controller.getProjectForgeAuthStatus(projectId), validateSingleRemoteStringArg);
  remoteOperations.register("getNetworkProxySettings", () => controller.getNetworkProxySettings(), validateNoRemoteArgs, "admin");
  remoteOperations.register("checkProjectFolderGitStatus", (repoPath) => controller.checkProjectFolderGitStatus(repoPath), validateSingleRemoteStringArg, "admin");
  remoteOperations.register("getProjectLoopDetail", (loopId) => controller.getProjectLoopDetail(loopId), validateSingleRemoteStringArg, "admin");
  remoteOperations.register("getProjectLoopAvailability", (projectId) => controller.getProjectLoopAvailability(projectId), validateSingleRemoteStringArg, "admin");
  remoteOperations.register("getProjectForgePrMonitorSettings", (projectId) => controller.getProjectForgePrMonitorSettings(projectId), validateSingleRemoteStringArg, "admin");
  remoteOperations.register("listProjectForgeRequests", (projectId, input) => controller.listProjectForgeRequests(projectId, input), validateListForgeRequests, "git:write");
  remoteOperations.register(
    "getProjectForgeRequestDetails",
    (projectId, input) => controller.getProjectForgeRequestDetails(projectId, input),
    validateForgeRequestDetails,
    "git:write",
  );
  remoteOperations.register(
    "fetchProjectPrMrDiff",
    (projectId, input) => controller.fetchProjectPrMrDiff(projectId, input),
    validateFetchForgeDiff,
    "git:write",
    true,
  );
  remoteOperations.register("listAvailableProviderModels", (input) => controller.listAvailableProviderModels(input), validateAvailableProviderModels, "admin");
  remoteOperations.register("getAppPaths", () => controller.getAppPaths(), validateNoRemoteArgs, "admin");
  remoteOperations.register("getDetectedCodexInstallation", () => controller.getDetectedCodexInstallation(), validateNoRemoteArgs, "admin");
  remoteOperations.register("getDetectedClaudeInstallation", () => controller.getDetectedClaudeInstallation(), validateNoRemoteArgs, "admin");
  remoteOperations.register("getDetectedCursorInstallation", () => controller.getDetectedCursorInstallation(), validateNoRemoteArgs, "admin");
  remoteOperations.register("listIntegratedSkills", () => controller.listIntegratedSkills(), validateNoRemoteArgs, "admin");
  remoteOperations.register("getIntegratedSkillContent", (skillId) => controller.getIntegratedSkillContent(skillId), validateSingleRemoteStringArg, "admin");
  remoteOperations.register("checkProjectGitConversion", (projectId) => controller.checkProjectGitConversion(projectId), validateSingleRemoteStringArg);
  remoteOperations.register(
    "getProjectBranchDeleteImpact",
    (projectId, input) => controller.getProjectBranchDeleteImpact(projectId, input),
    validateProjectAndBranchInput<"getProjectBranchDeleteImpact">(["branchName"]),
  );
  remoteOperations.register("listHostDirectories", (input) => hostDirectory.list(input), validateHostDirectoryInput, "admin");

  remoteOperations.register("createRun", (input) => controller.createRun(input), validateRunInput, "run:operate", true);
  remoteOperations.register("continueRun", (input) => controller.continueRun(input), validateContinueRunInput, "run:operate", true);
  remoteOperations.register("followUpRun", (runId, prompt, options) => controller.followUpRun(runId, prompt, options), validateFollowUpRun, "run:operate", true);
  remoteOperations.register("cancelRun", (runId) => controller.cancelRun(runId), validateSingleRemoteStringArg, "run:operate", true);
  remoteOperations.register("cancelRunShell", (runId, toolCallId) => controller.cancelRunShell(runId, toolCallId), validateTwoRemoteStrings, "run:operate", true);
  remoteOperations.register("resumeRunFromCheckpoint", (runId) => controller.resumeRunFromCheckpoint(runId), validateSingleRemoteStringArg, "run:operate", true);
  remoteOperations.register("recoverInterruptedRun", (runId) => controller.recoverInterruptedRun(runId), validateSingleRemoteStringArg, "run:operate", true);
  remoteOperations.register("undoRunToLastPrompt", (runId) => controller.undoRunToLastPrompt(runId), validateSingleRemoteStringArg, "run:operate", true);
  remoteOperations.register("deleteRun", (runId) => controller.deleteRun(runId), validateSingleRemoteStringArg, "run:operate", true);
  remoteOperations.register(
    "setRunListVisibility",
    (runId, visibility) => controller.setRunListVisibility(runId, visibility),
    defineRemoteArgsValidator<"setRunListVisibility">((args) =>
      args.length === 2 && typeof args[0] === "string" && (args[1] === "default" || args[1] === "for-later")),
    "run:operate",
    true,
  );
  for (const method of ["addBookmark", "removeBookmark", "removeBookmarkById"] as const) {
    remoteOperations.register(method, (id) => controller[method](id), validateSingleRemoteStringArg, "run:operate", true);
  }
  remoteOperations.register(
    "respondToShellApproval",
    (runId, requestId, decision, options) => controller.respondToShellApproval(runId, requestId, decision, options),
    validateShellApproval,
    "approval:respond",
    true,
  );
  remoteOperations.register(
    "respondToRunUserInput",
    (runId, requestId, answers) => controller.respondToRunUserInput(runId, requestId, answers),
    validateUserInput,
    "approval:respond",
    true,
  );
  remoteOperations.register("createChat", (input) => controller.createChat(input), validateChatInput, "chat:operate", true);
  remoteOperations.register("followUpChat", (chatId, prompt, options) => controller.followUpChat(chatId, prompt, options), validateFollowUpChat, "chat:operate", true);
  remoteOperations.register("cancelChat", (chatId) => controller.cancelChat(chatId), validateSingleRemoteStringArg, "chat:operate", true);
  remoteOperations.register("deleteChat", (chatId) => controller.deleteChat(chatId), validateSingleRemoteStringArg, "chat:operate", true);
  for (const method of ["addChatBookmark", "removeChatBookmark", "removeChatBookmarkById"] as const) {
    remoteOperations.register(method, (id) => controller[method](id), validateSingleRemoteStringArg, "chat:operate", true);
  }

  remoteOperations.register("createProjectTask", (projectId, input) => controller.createProjectTask(projectId, input), validateProjectTaskCreate, "admin", true);
  remoteOperations.register("updateProjectTask", (taskId, input) => controller.updateProjectTask(taskId, input), validateProjectTaskUpdate, "admin", true);
  remoteOperations.register("deleteProjectTask", (taskId) => controller.deleteProjectTask(taskId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("generateProjectTaskRunPrompt", (input) => controller.generateProjectTaskRunPrompt(input), validateProjectTaskPrompt, "admin", true);
  remoteOperations.register("generateProjectInsight", (input) => controller.generateProjectInsight(input), validateProjectInsight, "admin", true);
  remoteOperations.register("runProjectLab", (input) => controller.runProjectLab(input), validateProjectLabRun, "admin", true);
  remoteOperations.register("deleteProjectLabThread", (threadId) => controller.deleteProjectLabThread(threadId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("createProjectLoop", (input) => controller.createProjectLoop(input), validateProjectLoopCreate, "admin", true);
  remoteOperations.register("cancelProjectLoop", (loopId) => controller.cancelProjectLoop(loopId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("resumeProjectLoop", (loopId) => controller.resumeProjectLoop(loopId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("deleteProjectLoop", (loopId) => controller.deleteProjectLoop(loopId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register(
    "respondToProjectLoopUiReview",
    (reviewId, input) => controller.respondToProjectLoopUiReview(reviewId, input),
    validateLoopUiReview,
    "admin",
    true,
  );
  remoteOperations.register(
    "analyzeProjectPrMrDiff",
    (projectId, input) => controller.analyzeProjectPrMrDiff(projectId, input),
    validateAnalyzeForgeDiff,
    "git:write",
    true,
  );
  remoteOperations.register(
    "postProjectPrMrReview",
    (projectId, input) => controller.postProjectPrMrReview(projectId, input),
    validatePostForgeReview,
    "git:write",
    true,
  );
  remoteOperations.register(
    "submitProjectPrMrComments",
    (projectId, input) => controller.submitProjectPrMrComments(projectId, input),
    validateSubmitForgeComments,
    "git:write",
    true,
  );
  remoteOperations.register(
    "replyProjectPrMrReviewThread",
    (projectId, input) => controller.replyProjectPrMrReviewThread(projectId, input),
    validateReplyForgeThread,
    "git:write",
    true,
  );
  remoteOperations.register(
    "resolveProjectPrMrReviewThread",
    (projectId, input) => controller.resolveProjectPrMrReviewThread(projectId, input),
    validateResolveForgeThread,
    "git:write",
    true,
  );

  remoteOperations.register("commitRun", (runId, message) => controller.commitRun(runId, message), validateTwoRemoteStrings, "git:write", true);
  remoteOperations.register("createRunLocalBranch", (runId, branchName) => controller.createRunLocalBranch(runId, branchName), validateTwoRemoteStrings, "git:write", true);
  remoteOperations.register("publishRunBranch", (runId, branchName) => controller.publishRunBranch(runId, branchName), validateOptionalSecondString, "git:write", true);
  remoteOperations.register(
    "createRunPullRequest",
    (runId, targetBranch, title, sourceBranchName, description) =>
      controller.createRunPullRequest(runId, targetBranch, title, sourceBranchName, description),
    validatePullRequest,
    "git:write",
    true,
  );
  remoteOperations.register("checkoutProjectBranch", (projectId, branchName) => controller.checkoutProjectBranch(projectId, branchName), validateTwoRemoteStrings, "git:write", true);
  remoteOperations.register("fetchProjectBranches", (projectId) => controller.fetchProjectBranches(projectId), validateSingleRemoteStringArg, "git:write", true);
  remoteOperations.register(
    "createProjectBranch",
    (projectId, input) => controller.createProjectBranch(projectId, input),
    validateProjectAndBranchInput<"createProjectBranch">(["branchName", "startPoint"]),
    "git:write",
    true,
  );
  remoteOperations.register(
    "renameProjectBranch",
    (projectId, input) => controller.renameProjectBranch(projectId, input),
    validateProjectAndBranchInput<"renameProjectBranch">(["oldName", "newName"]),
    "git:write",
    true,
  );
  remoteOperations.register(
    "deleteProjectBranch",
    (projectId, input) => controller.deleteProjectBranch(projectId, input),
    validateProjectAndBranchInput<"deleteProjectBranch">(["branchName"]),
    "git:write",
    true,
  );
  remoteOperations.register("pullProjectBranch", (projectId) => controller.pullProjectBranch(projectId), validateSingleRemoteStringArg, "git:write", true);
  remoteOperations.register(
    "pushProjectBranch",
    (projectId, input) => controller.pushProjectBranch(projectId, input),
    validateProjectAndBranchInput<"pushProjectBranch">(["branchName"]),
    "git:write",
    true,
  );
  remoteOperations.register("convertProjectToGit", (projectId) => controller.convertProjectToGit(projectId), validateSingleRemoteStringArg, "git:write", true);
  remoteOperations.register(
    "updateProjectBaseBranch",
    (projectId, branchName) => controller.updateProjectBaseBranch(projectId, branchName),
    validateTwoRemoteStrings,
    "git:write",
    true,
  );
  remoteOperations.register("addProject", (input) => controller.addProject(input), validateProjectInput, "admin", true);
  remoteOperations.register("reorderProjects", (projectIds) => controller.reorderProjects(projectIds), validateStringArrayArg, "admin", true);
  remoteOperations.register("addProviderAccount", (input) => controller.addProviderAccount(input), validateProviderAccount, "admin", true);
  remoteOperations.register("addModel", (input) => controller.addModel(input), validateModel, "admin", true);
  remoteOperations.register("deleteProject", async (projectId) => {
    await controller.deleteProject(projectId);
    await refreshProjectForgePrMonitors(controller);
  }, validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("deleteProviderAccount", (providerAccountId) => controller.deleteProviderAccount(providerAccountId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("deleteModel", (modelId) => controller.deleteModel(modelId), validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("setAppSetting", async (key, value) => {
    await controller.setAppSetting(key, value);
    refreshAppMenu();
  }, validateAppSetting, "admin", true);
  remoteOperations.register("saveNetworkProxySettings", (input) => controller.saveNetworkProxySettings(input), validateNetworkProxySettings, "admin", true);
  remoteOperations.register("saveProjectForgeAuthToken", async (projectId, token) => {
    const result = await controller.saveProjectForgeAuthToken(projectId, token);
    await refreshProjectForgePrMonitors(controller);
    return result;
  }, validateTwoRemoteStrings, "admin", true);
  remoteOperations.register("deleteProjectForgeAuthToken", async (projectId) => {
    const result = await controller.deleteProjectForgeAuthToken(projectId);
    await refreshProjectForgePrMonitors(controller);
    return result;
  }, validateSingleRemoteStringArg, "admin", true);
  remoteOperations.register("saveProjectForgePrMonitorSettings", async (projectId, input) => {
    const result = await controller.saveProjectForgePrMonitorSettings(projectId, input);
    await refreshProjectForgePrMonitors(controller);
    return result;
  }, validateForgeMonitorSettings, "admin", true);

  remoteOperations.register("runTerminalStart", async (input) => {
    const prefix = "buildwarden-run-terminal:";
    const runId = input.sessionId.startsWith(prefix) ? input.sessionId.slice(prefix.length) : "";
    if (!runId) return { ok: false, error: "Invalid remote terminal session." };
    const detail = await controller.getRunDetail(runId);
    return hostTerminal.start({ ...input, cwd: detail.workspacePath ?? "" });
  }, validateTerminalStart, "terminal:operate", true);
  remoteOperations.register("runTerminalWrite", async (input) => hostTerminal.write(input), validateTerminalWrite, "terminal:operate", true);
  remoteOperations.register("runTerminalResize", async (input) => hostTerminal.resize(input), validateTerminalResize, "terminal:operate", true);
  remoteOperations.register("runTerminalKill", async (sessionId) => hostTerminal.kill(sessionId), validateSingleRemoteStringArg, "terminal:operate", true);
  remoteOperations.register("ensureRunBrowser", (input) => hostBrowser.ensure(input), validateRunBrowserEnsure, "browser:operate");
  remoteOperations.register("navigateRunBrowser", (input) => hostBrowser.navigate(input), validateRunBrowserNavigate, "browser:operate");
  remoteOperations.register("runBrowserAction", (input) => hostBrowser.action(input), validateRunBrowserAction, "browser:operate");
  remoteOperations.register("setRunBrowserViewport", async (input) => hostBrowser.setViewport(input), validateRunBrowserViewport, "browser:operate");
  remoteOperations.register("getRunBrowserElementCapture", async (input) => hostBrowser.getElementCapture(input), validateRunBrowserCapture, "browser:operate");

  const remoteEventSource: RemoteHostEventSource = {
    subscribe(listener) {
      const disposers = [
        hostEvents.subscribe("run", (payload) => listener({ event: "run", payload })),
        hostEvents.subscribe("chat", (payload) => listener({ event: "chat", payload })),
        hostEvents.subscribe("warning", (payload) => listener({ event: "warning", payload })),
        hostEvents.subscribe("loop", (payload) => listener({ event: "loop", payload })),
        hostEvents.subscribe("task", (payload) => listener({ event: "task", payload })),
        hostTerminal.onData((payload) => listener({ event: "terminal-data", payload })),
        hostTerminal.onExit((payload) => listener({ event: "terminal-exit", payload })),
        hostBrowser.onEvent((payload) => listener({ event: "browser", payload })),
      ];
      return () => disposers.forEach((dispose) => dispose());
    },
  };

  const remoteAccessAuthSecretKey = "app:remote-access-auth-key:v1";
  const tailscaleServe = new TailscaleServeService({
    read: (key) => db.getSettings()[key],
    write: (key, value) => db.setSetting(key, value),
  });
  let remoteAuthService: RemoteAuthService | null = null;
  let remoteAuthServiceInitialization: Promise<RemoteAuthService> | null = null;
  const ensureRemoteAuthService = (): Promise<RemoteAuthService> => {
    if (remoteAuthService) {
      return Promise.resolve(remoteAuthService);
    }
    if (remoteAuthServiceInitialization) {
      return remoteAuthServiceInitialization;
    }

    const initialization = (async () => {
      let encodedKey = await secretStore.readSecret(remoteAccessAuthSecretKey);
      let credentialKey = encodedKey ? Buffer.from(encodedKey, "base64") : Buffer.alloc(0);
      if (credentialKey.byteLength < 32) {
        credentialKey = randomBytes(32);
        encodedKey = credentialKey.toString("base64");
        await secretStore.saveSecret(remoteAccessAuthSecretKey, encodedKey);
      }
      remoteAuthService = new RemoteAuthService({ store: db, credentialKey });
      return remoteAuthService;
    })();
    remoteAuthServiceInitialization = initialization;
    void initialization.then(
      () => {
        if (remoteAuthServiceInitialization === initialization) remoteAuthServiceInitialization = null;
      },
      () => {
        if (remoteAuthServiceInitialization === initialization) remoteAuthServiceInitialization = null;
      },
    );
    return initialization;
  };

  let remoteAccessServer: RemoteAccessServer | null = null;
  let remoteAccessSync = Promise.resolve();
  const syncRemoteAccessServer = (): Promise<void> => {
    remoteAccessSync = remoteAccessSync.catch(() => undefined).then(async () => {
      const enabled = parseRemoteAccessEnabledSetting(db.getSettings()[APP_SETTING_KEYS.remoteAccessEnabled]);
      if (!enabled) {
        const tailscaleStatus = await tailscaleServe.disable();
        if (tailscaleStatus.state === "error") {
          const loopbackServerBound = Boolean(remoteAccessServer?.getInfo());
          logWarn(loopbackServerBound
            ? "BuildWarden could not remove its Tailscale Serve exposure; the authenticated loopback server will remain bound to protect its port."
            : "BuildWarden could not remove its Tailscale Serve exposure; ownership was retained so cleanup can be retried.", {
            message: tailscaleStatus.message,
          });
          return;
        }
        if (remoteAccessServer?.getInfo()) {
          try {
            await remoteAccessServer.stop();
            remoteAccessServer = null;
            logInfo("Remote access server stopped.");
          } catch (error) {
            logWarn("Remote access server did not stop cleanly; standalone Electron mode remains available.", { error });
          }
        }
        return;
      }
      if (!remoteAccessServer?.getInfo()) {
        try {
          remoteAccessServer = new RemoteAccessServer({
            appVersion: app.getVersion(),
            operations: remoteOperations,
            auth: await ensureRemoteAuthService(),
            staticRoot: join(app.getAppPath(), "out", "web"),
            events: remoteEventSource,
            onBrowserInput: (runId, input) => hostBrowser.sendInput({ runId, input }),
            onBrowserSubscriptionChange: (previousRunIds, nextRunIds) => hostBrowser.setRemoteSubscriptions(previousRunIds, nextRunIds),
            trustedProxyHosts: () => {
              const host = tailscaleServe.getManagedHost();
              return host ? [host] : [];
            },
            trustedWebOrigins: () =>
              parseRemoteAccessWebOriginsSetting(db.getSettings()[APP_SETTING_KEYS.remoteAccessWebOrigins]),
            onServerError: (error) => logError("Remote access server request failed.", { error }),
          });
          const info = await remoteAccessServer.start();
          logInfo("Remote access server started in loopback-only mode.", {
            baseUrl: info.baseUrl,
            authentication: "session",
          });
        } catch (error) {
          const tailscaleStatus = await tailscaleServe.disable();
          if (tailscaleStatus.state === "error") {
            logWarn("Remote access server startup failed and its previous Tailscale Serve exposure could not be removed.", {
              message: tailscaleStatus.message,
            });
          }
          remoteAccessServer = null;
          // Remote access is optional; a port conflict must never prevent the desktop app from starting.
          logWarn("Remote access server could not start; standalone Electron mode remains available.", { error });
        }
      }
      const serverInfo = remoteAccessServer?.getInfo();
      if (!serverInfo) return;
      const tailscaleDesired = db.getSettings()[APP_SETTING_KEYS.remoteAccessTailscaleEnabled] === "true";
      const tailscaleStatus = tailscaleDesired
        ? await tailscaleServe.enable(serverInfo.port)
        : await tailscaleServe.disable();
      if (tailscaleStatus.state === "managed") {
        logInfo("BuildWarden Tailscale Serve exposure verified.", { endpoint: tailscaleStatus.endpoint });
      } else if (tailscaleDesired && tailscaleStatus.state !== "available") {
        logWarn("BuildWarden Tailscale Serve exposure is unavailable.", {
          state: tailscaleStatus.state,
          message: tailscaleStatus.message,
        });
      }
    });
    return remoteAccessSync;
  };
  await syncRemoteAccessServer();

  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => remoteOperations.invoke("getSnapshot", []));
  ipcMain.handle(IPC_CHANNELS.getRemoteAccessStatus, async () => {
    const info = remoteAccessServer?.getInfo() ?? null;
    return {
      enabled: parseRemoteAccessEnabledSetting(db.getSettings()[APP_SETTING_KEYS.remoteAccessEnabled]),
      loopbackUrl: info?.baseUrl ?? null,
      tailscale: await tailscaleServe.getStatus(info?.port ?? null),
    };
  });
  ipcMain.handle(IPC_CHANNELS.listHostDirectories, (_, input) => hostDirectory.list(input));
  ipcMain.handle(IPC_CHANNELS.createRemoteAccessPairing, async (_, input?: RemoteAccessPairingInput) => {
    const enabled = parseRemoteAccessEnabledSetting(db.getSettings()[APP_SETTING_KEYS.remoteAccessEnabled]);
    if (!enabled) {
      throw new Error("Enable remote access before creating a pairing code.");
    }
    await syncRemoteAccessServer();
    if (!remoteAccessServer?.getInfo()) {
      throw new Error("Remote access could not be started.");
    }
    const info = remoteAccessServer.getInfo();
    const tailscaleStatus = await tailscaleServe.getStatus(info?.port ?? null);
    const requestedClientOrigin = input?.clientOrigin == null
      ? null
      : normalizeRemoteAccessWebOrigin(input.clientOrigin);
    if (input?.clientOrigin != null && !requestedClientOrigin) {
      throw new Error("The hosted website origin is invalid.");
    }
    if (requestedClientOrigin) {
      const trustedOrigins = parseRemoteAccessWebOriginsSetting(
        db.getSettings()[APP_SETTING_KEYS.remoteAccessWebOrigins],
      );
      if (!trustedOrigins.includes(requestedClientOrigin)) {
        throw new Error("Add this exact hosted website origin before creating a pairing code.");
      }
      if (!tailscaleStatus.verified || !tailscaleStatus.endpoint) {
        throw new Error("A verified Tailscale HTTPS endpoint is required for hosted website pairing.");
      }
    }
    const grant = (await ensureRemoteAuthService()).createPairingGrant({
      ...input,
      clientOrigin: requestedClientOrigin ?? undefined,
    });
    if (requestedClientOrigin && tailscaleStatus.endpoint) {
      const fragment = new URLSearchParams({
        host: tailscaleStatus.endpoint.replace(/\/$/, ""),
        pair: grant.code,
      });
      return {
        ...grant,
        pairingUrl: `${requestedClientOrigin}/#${fragment.toString()}`,
      };
    }
    const endpoint = tailscaleStatus.verified ? tailscaleStatus.endpoint : info?.baseUrl;
    return endpoint
      ? { ...grant, pairingUrl: `${endpoint.replace(/\/$/, "")}/#pair=${encodeURIComponent(grant.code)}` }
      : grant;
  });
  ipcMain.handle(IPC_CHANNELS.listRemoteAccessSessions, () => db.listRemoteAccessSessions());
  ipcMain.handle(IPC_CHANNELS.revokeRemoteAccessSession, async (_, sessionId: string) => {
    (await ensureRemoteAuthService()).revokeSession(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.getNetworkProxySettings, () => controller.getNetworkProxySettings());
  ipcMain.handle(IPC_CHANNELS.selectProject, (_, projectId: string) => controller.selectProject(projectId));
  ipcMain.handle(IPC_CHANNELS.reorderProjects, (_, projectIds: string[]) => controller.reorderProjects(projectIds));
  ipcMain.handle(IPC_CHANNELS.getProjectBranches, (_, projectId: string) => controller.getProjectBranches(projectId));
  ipcMain.handle(IPC_CHANNELS.getProjectCurrentBranch, (_, projectId: string) => controller.getProjectCurrentBranch(projectId));
  ipcMain.handle(IPC_CHANNELS.getProjectBranchOverview, (_, projectId: string) => controller.getProjectBranchOverview(projectId));
  ipcMain.handle(IPC_CHANNELS.checkProjectGitConversion, (_, projectId: string) => controller.checkProjectGitConversion(projectId));
  ipcMain.handle(IPC_CHANNELS.convertProjectToGit, (_, projectId: string) => controller.convertProjectToGit(projectId));
  ipcMain.handle(IPC_CHANNELS.updateProjectBaseBranch, (_, projectId: string, branchName: string) =>
    controller.updateProjectBaseBranch(projectId, branchName),
  );
  ipcMain.handle(IPC_CHANNELS.checkProjectFolderGitStatus, (_, repoPath: string) => controller.checkProjectFolderGitStatus(repoPath));
  ipcMain.handle(IPC_CHANNELS.checkoutProjectBranch, (_, projectId: string, branchName: string) =>
    controller.checkoutProjectBranch(projectId, branchName),
  );
  ipcMain.handle(IPC_CHANNELS.fetchProjectBranches, (_, projectId: string) => controller.fetchProjectBranches(projectId));
  ipcMain.handle(IPC_CHANNELS.createProjectBranch, (_, projectId: string, input) => controller.createProjectBranch(projectId, input));
  ipcMain.handle(IPC_CHANNELS.renameProjectBranch, (_, projectId: string, input) => controller.renameProjectBranch(projectId, input));
  ipcMain.handle(IPC_CHANNELS.getProjectBranchDeleteImpact, (_, projectId: string, input) =>
    controller.getProjectBranchDeleteImpact(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.deleteProjectBranch, (_, projectId: string, input) => controller.deleteProjectBranch(projectId, input));
  ipcMain.handle(IPC_CHANNELS.pullProjectBranch, (_, projectId: string) => controller.pullProjectBranch(projectId));
  ipcMain.handle(IPC_CHANNELS.pushProjectBranch, (_, projectId: string, input) => controller.pushProjectBranch(projectId, input));
  ipcMain.handle(IPC_CHANNELS.refreshSnapshot, () => remoteOperations.invoke("refreshSnapshot", []));
  ipcMain.handle(IPC_CHANNELS.getAppPaths, () => controller.getAppPaths());
  ipcMain.handle(IPC_CHANNELS.getDetectedCodexInstallation, () => controller.getDetectedCodexInstallation());
  ipcMain.handle(IPC_CHANNELS.getDetectedClaudeInstallation, () => controller.getDetectedClaudeInstallation());
  ipcMain.handle(IPC_CHANNELS.getDetectedCursorInstallation, () => controller.getDetectedCursorInstallation());
  ipcMain.handle(IPC_CHANNELS.listIntegratedSkills, () => controller.listIntegratedSkills());
  ipcMain.handle(IPC_CHANNELS.getIntegratedSkillContent, (_, skillId: string) => controller.getIntegratedSkillContent(skillId));
  ipcMain.handle(IPC_CHANNELS.addProject, (_, input: ProjectInput) => controller.addProject(input));
  ipcMain.handle(IPC_CHANNELS.addProviderAccount, (_, input: ProviderAccountInput) => controller.addProviderAccount(input));
  ipcMain.handle(IPC_CHANNELS.addModel, (_, input: ModelInput) => controller.addModel(input));
  ipcMain.handle(IPC_CHANNELS.listAvailableProviderModels, (_, input: ListAvailableProviderModelsInput) =>
    controller.listAvailableProviderModels(input),
  );
  ipcMain.handle(IPC_CHANNELS.listComposerCommands, (_, input) => controller.listComposerCommands(input));
  ipcMain.handle(IPC_CHANNELS.activateRun, (_, runId: string) => controller.activateRun(runId));
  ipcMain.handle(IPC_CHANNELS.commitRun, (_, runId: string, message: string) => controller.commitRun(runId, message));
  ipcMain.handle(IPC_CHANNELS.suggestCommitMessage, (_, runId: string) => controller.suggestCommitMessage(runId));
  ipcMain.handle(IPC_CHANNELS.analyzeRunDiff, (_, runId: string, options) => controller.analyzeRunDiff(runId, options));
  ipcMain.handle(IPC_CHANNELS.fetchProjectPrMrDiff, (_, projectId: string, input) => controller.fetchProjectPrMrDiff(projectId, input));
  ipcMain.handle(IPC_CHANNELS.analyzeProjectPrMrDiff, (_, projectId: string, input) =>
    controller.analyzeProjectPrMrDiff(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.getProjectForgeAuthStatus, (_, projectId: string) => controller.getProjectForgeAuthStatus(projectId));
  ipcMain.handle(IPC_CHANNELS.saveProjectForgeAuthToken, async (_, projectId: string, token: string) => {
    const result = await controller.saveProjectForgeAuthToken(projectId, token);
    await refreshProjectForgePrMonitors(controller);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.deleteProjectForgeAuthToken, async (_, projectId: string) => {
    const result = await controller.deleteProjectForgeAuthToken(projectId);
    await refreshProjectForgePrMonitors(controller);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.getProjectForgePrMonitorSettings, (_, projectId: string) =>
    controller.getProjectForgePrMonitorSettings(projectId),
  );
  ipcMain.handle(IPC_CHANNELS.saveProjectForgePrMonitorSettings, async (_, projectId: string, input) => {
    const result = await controller.saveProjectForgePrMonitorSettings(projectId, input);
    await refreshProjectForgePrMonitors(controller);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.listProjectForgeRequests, (_, projectId: string, input) =>
    controller.listProjectForgeRequests(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.getProjectForgeRequestDetails, (_, projectId: string, input) =>
    controller.getProjectForgeRequestDetails(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.postProjectPrMrReview, (_, projectId: string, input) => controller.postProjectPrMrReview(projectId, input));
  ipcMain.handle(IPC_CHANNELS.submitProjectPrMrComments, (_, projectId: string, input) =>
    controller.submitProjectPrMrComments(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.replyProjectPrMrReviewThread, (_, projectId: string, input) =>
    controller.replyProjectPrMrReviewThread(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.resolveProjectPrMrReviewThread, (_, projectId: string, input) =>
    controller.resolveProjectPrMrReviewThread(projectId, input),
  );
  ipcMain.handle(IPC_CHANNELS.createProjectTask, (_, projectId: string, input) => controller.createProjectTask(projectId, input));
  ipcMain.handle(IPC_CHANNELS.updateProjectTask, (_, taskId: string, input) => controller.updateProjectTask(taskId, input));
  ipcMain.handle(IPC_CHANNELS.deleteProjectTask, (_, taskId: string) => controller.deleteProjectTask(taskId));
  ipcMain.handle(IPC_CHANNELS.runProjectLab, (_, input) => controller.runProjectLab(input));
  ipcMain.handle(IPC_CHANNELS.deleteProjectLabThread, (_, threadId: string) => controller.deleteProjectLabThread(threadId));
  ipcMain.handle(IPC_CHANNELS.createProjectLoop, (_, input) => controller.createProjectLoop(input));
  ipcMain.handle(IPC_CHANNELS.getProjectLoopDetail, (_, loopId: string) => controller.getProjectLoopDetail(loopId));
  ipcMain.handle(IPC_CHANNELS.cancelProjectLoop, (_, loopId: string) => controller.cancelProjectLoop(loopId));
  ipcMain.handle(IPC_CHANNELS.resumeProjectLoop, (_, loopId: string) => controller.resumeProjectLoop(loopId));
  ipcMain.handle(IPC_CHANNELS.deleteProjectLoop, (_, loopId: string) => controller.deleteProjectLoop(loopId));
  ipcMain.handle(IPC_CHANNELS.respondToProjectLoopUiReview, (_, reviewId: string, input) =>
    controller.respondToProjectLoopUiReview(reviewId, input),
  );
  ipcMain.handle(IPC_CHANNELS.getProjectLoopUiReviewImage, (_, reviewId: string) =>
    controller.getProjectLoopUiReviewImage(reviewId),
  );
  ipcMain.handle(IPC_CHANNELS.getProjectLoopAvailability, (_, projectId: string) =>
    controller.getProjectLoopAvailability(projectId),
  );
  ipcMain.handle(IPC_CHANNELS.generateProjectTaskRunPrompt, (_, input) => controller.generateProjectTaskRunPrompt(input));
  ipcMain.handle(IPC_CHANNELS.generateProjectInsight, (_, input) => controller.generateProjectInsight(input));
  ipcMain.handle(IPC_CHANNELS.createRun, (_, input: RunInput) => controller.createRun(input));
  ipcMain.handle(IPC_CHANNELS.continueRun, (_, input) => controller.continueRun(input));
  ipcMain.handle(
    IPC_CHANNELS.createRunPullRequest,
    (_, runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string) =>
      controller.createRunPullRequest(runId, targetBranch, title, sourceBranchName, description),
  );
  ipcMain.handle(IPC_CHANNELS.suggestRunPullRequestDescription, (_, runId: string, targetBranch: string, title: string) =>
    controller.suggestRunPullRequestDescription(runId, targetBranch, title),
  );
  ipcMain.handle(IPC_CHANNELS.createRunLocalBranch, (_, runId: string, branchName: string) =>
    controller.createRunLocalBranch(runId, branchName),
  );
  ipcMain.handle(IPC_CHANNELS.followUpRun, (_, runId: string, prompt: string, options) => controller.followUpRun(runId, prompt, options));
  ipcMain.handle(IPC_CHANNELS.publishRunBranch, (_, runId: string, branchName?: string) =>
    controller.publishRunBranch(runId, branchName),
  );
  ipcMain.handle(IPC_CHANNELS.releaseRun, (_, runId: string) => controller.releaseRun(runId));
  ipcMain.handle(
    IPC_CHANNELS.respondToShellApproval,
    (_, runId: string, requestId: string, decision, options) => controller.respondToShellApproval(runId, requestId, decision, options),
  );
  ipcMain.handle(IPC_CHANNELS.respondToRunUserInput, (_, runId: string, requestId: string, answers) =>
    controller.respondToRunUserInput(runId, requestId, answers),
  );
  ipcMain.handle(IPC_CHANNELS.setAppSetting, async (_, key: string, value: string) => {
    await controller.setAppSetting(key, value);
    refreshAppMenu();
    if (key === APP_SETTING_KEYS.remoteAccessEnabled || key === APP_SETTING_KEYS.remoteAccessTailscaleEnabled) {
      await syncRemoteAccessServer();
    }
  });
  ipcMain.handle(IPC_CHANNELS.saveNetworkProxySettings, async (_, input: NetworkProxySettingsInput) =>
    controller.saveNetworkProxySettings(input),
  );
  ipcMain.handle(IPC_CHANNELS.deleteProject, async (_, projectId: string) => {
    await controller.deleteProject(projectId);
    await refreshProjectForgePrMonitors(controller);
  });
  ipcMain.handle(IPC_CHANNELS.deleteProviderAccount, (_, providerAccountId: string) =>
    controller.deleteProviderAccount(providerAccountId),
  );
  ipcMain.handle(IPC_CHANNELS.deleteRun, (_, runId: string) => controller.deleteRun(runId));
  ipcMain.handle(IPC_CHANNELS.deleteModel, (_, modelId: string) => controller.deleteModel(modelId));
  ipcMain.handle(IPC_CHANNELS.getRunDetail, (_, runId: string) => controller.getRunDetail(runId));
  ipcMain.handle(IPC_CHANNELS.addRunNote, (_, runId: string, input) => controller.addRunNote(runId, input));
  ipcMain.handle(IPC_CHANNELS.updateRunNote, (_, noteId: string, input) => controller.updateRunNote(noteId, input));
  ipcMain.handle(IPC_CHANNELS.deleteRunNote, (_, noteId: string) => controller.deleteRunNote(noteId));
  ipcMain.handle(IPC_CHANNELS.setRunListVisibility, (_, runId: string, visibility) => controller.setRunListVisibility(runId, visibility));
  ipcMain.handle(IPC_CHANNELS.getRunWorkspaceFile, (_, input) => controller.getRunWorkspaceFile(input));
  ipcMain.handle(IPC_CHANNELS.getRunWorktreeDiff, (_, runId: string) => controller.getRunWorktreeDiff(runId));
  ipcMain.handle(IPC_CHANNELS.resumeRunFromCheckpoint, (_, runId: string) => controller.resumeRunFromCheckpoint(runId));
  ipcMain.handle(IPC_CHANNELS.recoverInterruptedRun, (_, runId: string) => controller.recoverInterruptedRun(runId));
  ipcMain.handle(IPC_CHANNELS.undoRunToLastPrompt, (_, runId: string) => controller.undoRunToLastPrompt(runId));
  ipcMain.handle(IPC_CHANNELS.getRunPublishOptions, (_, runId: string) => controller.getRunPublishOptions(runId));
  ipcMain.handle(IPC_CHANNELS.cancelRunShell, (_, runId: string, toolCallId: string) => controller.cancelRunShell(runId, toolCallId));
  ipcMain.handle(IPC_CHANNELS.cancelRun, (_, runId: string) => controller.cancelRun(runId));
  ipcMain.handle(IPC_CHANNELS.pickProjectDirectory, () => controller.pickProjectDirectory());
  ipcMain.handle(IPC_CHANNELS.openPathInFileManager, (_, path: string) => controller.openPathInFileManager(path));
  ipcMain.handle(IPC_CHANNELS.openExternalUrl, (_, url: string) => desktopPlatform.openExternalUrl(url));
  ipcMain.handle(IPC_CHANNELS.ensureRunBrowser, (_, input) => hostBrowser.ensure(input));
  ipcMain.handle(IPC_CHANNELS.navigateRunBrowser, (_, input) => hostBrowser.navigate(input));
  ipcMain.handle(IPC_CHANNELS.runBrowserAction, (_, input) => hostBrowser.action(input));
  ipcMain.handle(IPC_CHANNELS.setRunBrowserViewport, (_, input) => hostBrowser.setViewport(input));
  ipcMain.handle(IPC_CHANNELS.setRunBrowserDesktopSurface, (_, input) => hostBrowser.setDesktopSurface(input));
  ipcMain.handle(IPC_CHANNELS.getRunBrowserElementCapture, (_, input) => hostBrowser.getElementCapture(input));
  ipcMain.handle(IPC_CHANNELS.sendRunBrowserInput, (_, input) => hostBrowser.sendInput(input));
  ipcMain.handle(IPC_CHANNELS.reportRendererLog, async (_, payload: RendererLogPayload) => {
    const metadata = {
      source: payload.source,
      stack: payload.stack,
      ...(payload.metadata ? { rendererMetadata: payload.metadata } : {}),
    };
    if (payload.level === "warn") {
      logWarn(payload.message, metadata);
      return;
    }
    logError(payload.message, metadata);
  });
  ipcMain.handle(IPC_CHANNELS.pickIdeExecutable, () => controller.pickIdeExecutable());
  ipcMain.handle(IPC_CHANNELS.openRunWorktreeInIde, (_, runId: string, ideKind: unknown) =>
    controller.openRunWorktreeInIde(runId, parseSupportedIdeKind(ideKind)),
  );
  ipcMain.handle(IPC_CHANNELS.openFolderInIde, (_, folderPath: string, ideKind: unknown) =>
    controller.openFolderInIde(folderPath, parseSupportedIdeKind(ideKind)),
  );
  ipcMain.handle(IPC_CHANNELS.addBookmark, (_, runId: string) => controller.addBookmark(runId));
  ipcMain.handle(IPC_CHANNELS.removeBookmark, (_, runId: string) => controller.removeBookmark(runId));
  ipcMain.handle(IPC_CHANNELS.removeBookmarkById, (_, bookmarkId: string) => controller.removeBookmarkById(bookmarkId));
  ipcMain.handle(IPC_CHANNELS.isBookmarked, (_, runId: string) => controller.isBookmarked(runId));
  ipcMain.handle(IPC_CHANNELS.getBookmarksWithSteps, () => controller.getBookmarksWithSteps());
  ipcMain.handle(IPC_CHANNELS.addChatBookmark, (_, chatId: string) => controller.addChatBookmark(chatId));
  ipcMain.handle(IPC_CHANNELS.removeChatBookmark, (_, chatId: string) => controller.removeChatBookmark(chatId));
  ipcMain.handle(IPC_CHANNELS.removeChatBookmarkById, (_, bookmarkId: string) =>
    controller.removeChatBookmarkById(bookmarkId),
  );
  ipcMain.handle(IPC_CHANNELS.isChatBookmarked, (_, chatId: string) => controller.isChatBookmarked(chatId));
  ipcMain.handle(IPC_CHANNELS.getChatBookmarksWithSteps, () => controller.getChatBookmarksWithSteps());
  ipcMain.handle(IPC_CHANNELS.resetDatabase, async () => {
    await controller.resetDatabase();
    app.relaunch();
    app.quit();
  });
  ipcMain.handle(IPC_CHANNELS.createChat, (_, input: ChatInput) => controller.createChat(input));
  ipcMain.handle(IPC_CHANNELS.createRunChat, (_, runId: string, input: RunChatInput) =>
    controller.createRunChat(runId, input),
  );
  ipcMain.handle(IPC_CHANNELS.getRunChat, (_, runId: string) => controller.getRunChat(runId));
  ipcMain.handle(IPC_CHANNELS.getChatDetail, (_, chatId: string) => controller.getChatDetail(chatId));
  ipcMain.handle(IPC_CHANNELS.followUpChat, (_, chatId: string, prompt: string, options) =>
    controller.followUpChat(chatId, prompt, options),
  );
  ipcMain.handle(IPC_CHANNELS.listChats, () => controller.listChats());
  ipcMain.handle(IPC_CHANNELS.listChatsWithSteps, () => controller.listChatsWithSteps());
  ipcMain.handle(IPC_CHANNELS.deleteChat, (_, chatId: string) => controller.deleteChat(chatId));
  ipcMain.handle(IPC_CHANNELS.cancelChat, (_, chatId: string) => controller.cancelChat(chatId));
  ipcMain.handle(IPC_CHANNELS.showAppMenu, (_, section: AppMenuSection, x: number, y: number) => {
    desktopPlatform.popupApplicationMenu(
      {
        logDirPath,
        theme: currentUiTheme,
        onCommand: (command) => hostEvents.publish("appMenuCommand", command),
        onThemeChange: (theme) => void applyUiTheme(theme),
      },
      section,
      x,
      y,
    );
  });

  registerHostEventIpc(hostEvents, () => mainWindow);
  registerRunTerminalIpc(hostTerminal, desktopPlatform);
  app.on("before-quit", () => {
    void remoteAccessServer?.stop().catch((error) => {
      logWarn("Remote access server did not stop cleanly.", { error });
    });
    hostTerminal.disposeAll();
    hostBrowser.disposeAll();
    for (const state of projectForgeMonitorStates.values()) {
      clearInterval(state.timer);
    }
    projectForgeMonitorStates.clear();
    try {
      db.flushToDiskSync();
    } catch (error) {
      logError("Failed to flush database during shutdown.", { error });
    }
  });

  hostEvents.subscribe("run", (event) => {
    if (event.metadata?.shellApprovalRequest === true) {
      desktopPlatform.showShellApprovalNotification(event);
    }
    if (event.metadata?.userInputRequest === true && event.metadata.requestStatus === "opened") {
      desktopPlatform.showRunUserInputNotification(event);
    }
  });

  logInfo("Startup timing.", {
    windowCreatedAfterMs: windowCreatedAt - bootStartedAt,
    dbReadyAfterMs: dbReadyAt - bootStartedAt,
    handlersReadyAfterMs: Date.now() - bootStartedAt,
    processUptimeMs: Math.round(process.uptime() * 1000),
  });
  await refreshProjectForgePrMonitors(controller);
};

const createMainWindow = (theme: UiTheme): void => {
  const colors = getWindowThemeColors(theme);
  const iconPath = getAppIconPath();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1160,
    minHeight: 760,
    backgroundColor: colors.backgroundColor,
    autoHideMenuBar: USE_CUSTOM_WINDOWS_TITLEBAR,
    titleBarStyle: USE_CUSTOM_WINDOWS_TITLEBAR ? "hidden" : undefined,
    titleBarOverlay: USE_CUSTOM_WINDOWS_TITLEBAR ? colors.titleBarOverlay : undefined,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(mainDir, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    logInfo("Main window closed.");
    mainWindow = null;
  });

  if (USE_CUSTOM_WINDOWS_TITLEBAR) {
    mainWindow.setMenuBarVisibility(false);
  }

  mainWindow.webContents.setWindowOpenHandler((details) => {
    const url = details.url;
    if (isAppNavigationUrl(url)) {
      return { action: "allow" };
    }
    if (isSafeExternalUrl(url)) {
      logInfo("Opening safe external URL from renderer window.", { url });
      void desktopPlatform.openExternalUrl(url);
    } else {
      logWarn("Blocked unsafe renderer window open request.", { url });
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logError("Renderer process exited unexpectedly.", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    logError("Renderer failed to load content.", {
      errorCode,
      errorDescription,
      validatedUrl,
      isMainFrame,
    });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(mainDir, "../renderer/index.html"));
  }
};

app.whenReady().then(async () => {
  try {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.buildwarden.desktop");
    }
    const iconPath = getAppIconPath();
    if (iconPath && process.platform === "darwin" && app.dock) {
      app.dock.setIcon(iconPath);
    }
    await bootstrap();
  } catch (err) {
    if (!getAppLogDirPath()) {
      try {
        initializeAppLogger(app.getPath("logs"));
      } catch {
        // Best-effort fallback before showing the startup error dialog.
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logError("Failed to start BuildWarden.", { error: err });
    await desktopPlatform.showErrorDialog("Startup Error", "Failed to start BuildWarden", [message, stack].filter(Boolean).join("\n\n"));
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      logInfo("Recreating main window after activate.");
      createMainWindow(currentUiTheme);
    }
  });
});

process.on("uncaughtException", (err) => {
  logError("Uncaught exception in main process.", { error: err });
  void app.whenReady().then(async () => {
    await desktopPlatform.showErrorDialog("Uncaught Exception", err.message, err.stack).catch(() => {});
    app.quit();
  });
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logError("Unhandled rejection in main process.", { reason });
  void app.whenReady().then(async () => {
    await desktopPlatform.showErrorDialog("Unhandled Rejection", message).catch(() => {});
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    logInfo("All windows closed; quitting application.");
    app.quit();
  }
});
