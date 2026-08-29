import type { RemoteAccessScope, RemoteApiMethod } from "@buildwarden/shared";
import type { BuildWardenClientCapabilities } from "./buildwarden-client-core";

export const webCapabilities = (scopes: readonly RemoteAccessScope[]): Readonly<BuildWardenClientCapabilities> => {
  const has = (scope: RemoteAccessScope) => scopes.includes(scope);
  const runMutations = has("run:operate");
  const chatMutations = has("chat:operate");
  const approvalResponses = has("approval:respond");
  const gitMutations = has("git:write");
  const adminMutations = has("admin");
  const terminalOperations = has("terminal:operate");
  const browserOperations = has("browser:operate");
  return Object.freeze({
    platform: "web" as const,
    nativeTitleBar: false,
    nativeAppMenu: false,
    directoryPicker: false,
    ideIntegration: false,
    fileManager: false,
    systemTerminal: false,
    embeddedTerminal: terminalOperations,
    browserControl: browserOperations,
    settings: adminMutations,
    mutations: runMutations || chatMutations || approvalResponses || gitMutations || adminMutations || terminalOperations || browserOperations,
    runMutations,
    chatMutations,
    bookmarkMutations: runMutations || chatMutations,
    runListVisibilityMutations: runMutations,
    taskMutations: adminMutations,
    automationMutations: adminMutations,
    insightMutations: adminMutations,
    projectLabMutations: adminMutations,
    projectLoopMutations: adminMutations,
    prReview: gitMutations,
    projectSettingsMutations: adminMutations,
    approvalResponses,
    gitMutations,
    projectCreation: adminMutations,
    hostDirectoryBrowser: adminMutations,
    orchestrationRead: has("state:read"),
    orchestrationOperate: runMutations,
    orchestrationAdoption: runMutations && gitMutations,
    orchestrationSettings: runMutations && adminMutations,
    liveEvents: true,
  });
};

export const REMOTE_READ_METHODS = new Set<RemoteApiMethod>([
  "getSnapshot", "refreshSnapshot", "getNetworkProxySettings", "getProjectBranches", "getProjectCurrentBranch",
  "queryProjectActivity", "checkProjectFolderGitStatus", "getRunDetail", "getOrchestrationDetail",
  "getOrchestrationTaskDetail", "getOrchestrationAdoptionPreview", "getRunDeletionImpact", "getModelDeletionImpact",
  "getRunWorktreeDiff", "getRunWorktreeDiffSummary", "getRunWorkspaceFile", "getProjectLoopUiReviewImage",
  "getProjectLoopDetail", "getProjectLoopAvailability", "getProjectTask", "getProjectAutomation", "getRunChat",
  "getChatDetail", "listChatsWithSteps", "getBookmarksWithSteps", "getChatBookmarksWithSteps", "getRunPublishOptions",
  "getProjectBranchOverview", "getProjectBranchDeleteImpact", "getProjectForgeAuthStatus",
  "getProjectForgePrMonitorSettings", "listProjectForgeRequests", "getProjectForgeRequestDetails",
  "getProjectForgeRequestStatus", "getRunForgeRequestDetails", "refreshRunForgeRequest", "getRunForgeRequestDiff",
  "checkProjectGitConversion", "listHostDirectories", "listAvailableProviderModels", "getAppPaths",
  "getDetectedCodexInstallation", "getDetectedClaudeInstallation", "getDetectedCursorInstallation",
  "listIntegratedSkills", "getIntegratedSkillContent",
]);

export const REMOTE_BROWSER_METHODS = new Set<RemoteApiMethod>([
  "ensureRunBrowser", "navigateRunBrowser", "runBrowserAction", "setRunBrowserViewport", "getRunBrowserElementCapture",
]);

export const REMOTE_MUTATION_METHODS = new Set<RemoteApiMethod>([
  "createRun", "continueRun", "followUpRun", "respondToShellApproval", "respondToRunUserInput", "cancelRunShell",
  "cancelRun", "resumeRunFromCheckpoint", "recoverInterruptedRun", "undoRunToLastPrompt", "deleteRun",
  "pauseOrchestration", "resumeOrchestration", "cancelOrchestration", "finishOrchestration", "sendOrchestrationTaskMessage",
  "retryOrchestrationTask", "decideOrchestrationAdoption", "refreshOrchestrationTeam", "setRunListVisibility",
  "addBookmark", "removeBookmark", "removeBookmarkById", "addRunNote", "updateRunNote", "deleteRunNote", "createChat",
  "createRunChat", "followUpChat", "cancelChat", "deleteChat", "addChatBookmark", "removeChatBookmark",
  "removeChatBookmarkById", "createProjectTask", "updateProjectTask", "deleteProjectTask", "generateProjectTaskRunPrompt",
  "createProjectAutomation", "updateProjectAutomation", "deleteProjectAutomation", "runProjectAutomationNow",
  "generateProjectInsight", "runProjectLab", "deleteProjectLabThread", "createProjectLoop", "cancelProjectLoop",
  "resumeProjectLoop", "deleteProjectLoop", "respondToProjectLoopUiReview", "fetchProjectPrMrDiff",
  "analyzeProjectPrMrDiff", "postProjectPrMrReview", "submitProjectPrMrComments", "replyProjectPrMrReviewThread",
  "resolveProjectPrMrReviewThread", "updateProjectForgeRequest", "mergeProjectForgeRequest", "updateRunForgeRequest",
  "mergeRunForgeRequest", "commitRun", "suggestCommitMessage", "createRunLocalBranch", "suggestRunBranchName",
  "publishRunBranch", "createRunPullRequest", "suggestRunPullRequestDraft", "suggestRunPullRequestDescription",
  "checkoutProjectBranch", "fetchProjectBranches", "createProjectBranch", "renameProjectBranch", "deleteProjectBranch",
  "pullProjectBranch", "pushProjectBranch", "convertProjectToGit", "updateProjectBaseBranch", "addProject",
  "reorderProjects", "addProviderAccount", "addModel", "deleteProject", "deleteProviderAccount", "deleteModel",
  "setAppSetting", "saveNetworkProxySettings", "saveProjectForgeAuthToken", "deleteProjectForgeAuthToken",
  "saveProjectForgePrMonitorSettings", "runTerminalStart", "runTerminalWrite", "runTerminalResize", "runTerminalKill",
]);

export const REMOTE_MUTATION_SCOPES = new Map<RemoteApiMethod, readonly RemoteAccessScope[]>([
  ...[
    "createRun", "continueRun", "followUpRun", "cancelRunShell", "cancelRun", "resumeRunFromCheckpoint",
    "recoverInterruptedRun", "undoRunToLastPrompt", "deleteRun", "setRunListVisibility", "addBookmark", "removeBookmark",
    "removeBookmarkById", "addRunNote", "updateRunNote", "deleteRunNote", "pauseOrchestration", "resumeOrchestration",
    "cancelOrchestration", "finishOrchestration", "sendOrchestrationTaskMessage", "retryOrchestrationTask",
  ].map((method) => [method as RemoteApiMethod, ["run:operate"] as const] as const),
  ...["respondToShellApproval", "respondToRunUserInput"]
    .map((method) => [method as RemoteApiMethod, ["approval:respond"] as const] as const),
  ...["createChat", "createRunChat", "followUpChat", "cancelChat", "deleteChat", "addChatBookmark", "removeChatBookmark", "removeChatBookmarkById"]
    .map((method) => [method as RemoteApiMethod, ["chat:operate"] as const] as const),
  ...[
    "commitRun", "suggestCommitMessage", "createRunLocalBranch", "suggestRunBranchName", "publishRunBranch",
    "createRunPullRequest", "suggestRunPullRequestDraft", "suggestRunPullRequestDescription", "checkoutProjectBranch",
    "fetchProjectBranches", "createProjectBranch", "renameProjectBranch", "deleteProjectBranch", "pullProjectBranch",
    "pushProjectBranch", "convertProjectToGit", "updateProjectBaseBranch", "analyzeProjectPrMrDiff",
    "postProjectPrMrReview", "submitProjectPrMrComments", "replyProjectPrMrReviewThread", "resolveProjectPrMrReviewThread",
    "fetchProjectPrMrDiff", "updateProjectForgeRequest", "mergeProjectForgeRequest", "updateRunForgeRequest",
    "mergeRunForgeRequest",
  ].map((method) => [method as RemoteApiMethod, ["git:write"] as const] as const),
  ...[
    "addProject", "reorderProjects", "addProviderAccount", "addModel", "deleteProject", "deleteProviderAccount",
    "deleteModel", "setAppSetting", "saveNetworkProxySettings", "saveProjectForgeAuthToken",
    "deleteProjectForgeAuthToken", "saveProjectForgePrMonitorSettings", "createProjectTask", "updateProjectTask",
    "deleteProjectTask", "generateProjectTaskRunPrompt", "createProjectAutomation", "updateProjectAutomation",
    "deleteProjectAutomation", "runProjectAutomationNow", "generateProjectInsight", "runProjectLab",
    "deleteProjectLabThread", "createProjectLoop", "cancelProjectLoop", "resumeProjectLoop", "deleteProjectLoop",
    "respondToProjectLoopUiReview",
  ].map((method) => [method as RemoteApiMethod, ["admin"] as const] as const),
  ...["runTerminalStart", "runTerminalWrite", "runTerminalResize", "runTerminalKill"]
    .map((method) => [method as RemoteApiMethod, ["terminal:operate"] as const] as const),
  ["decideOrchestrationAdoption", ["run:operate", "git:write"]],
  ["refreshOrchestrationTeam", ["run:operate", "admin"]],
]);

export const listRemoteMutationMethodsMissingScopePolicy = (): RemoteApiMethod[] =>
  [...REMOTE_MUTATION_METHODS].filter((method) => !REMOTE_MUTATION_SCOPES.has(method));
