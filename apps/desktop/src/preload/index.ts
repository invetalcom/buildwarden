import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type AppWarning,
  type AppMenuCommand,
  type AppMenuSection,
  type ChatInput,
  type ContinueRunInput,
  type DesktopApi,
  type FollowUpChatOptions,
  type ListAvailableProviderModelsInput,
  type ModelInput,
  type NetworkProxySettingsInput,
  type ProjectForgePrMonitorSettingsInput,
  type ProjectForgeRequestNotificationPayload,
  type ProjectForgeRequestOpenPayload,
  type ProjectInput,
  type ProjectLoopChangedPayload,
  type ProjectLoopUiReviewDecisionInput,
  type ProjectTaskChangedPayload,
  type ProviderAccountInput,
  type RunChatInput,
  type RunEvent,
  type RunFollowUpOptions,
  type RunInput,
  type RunUserInputAnswers,
  type RunTerminalDataPayload,
  type RunTerminalExitPayload,
  type ShellApprovalDecision,
  type ShellApprovalRespondOptions,
  type SupportedIdeKind,
} from "@buildwarden/shared";

/**
 * The main window is created before the controller finishes initializing, so a
 * very early renderer call can race IPC handler registration. Retry briefly
 * when the handler for a channel does not exist yet; all other errors rethrow.
 */
// Matches the Promise<any> contract of ipcRenderer.invoke.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = async (channel: string, ...args: unknown[]): Promise<any> => {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      return await ipcRenderer.invoke(channel, ...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("No handler registered") || Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
};

const api: DesktopApi = {
  activateRun: (runId: string) => invoke(IPC_CHANNELS.activateRun, runId),
  addModel: (input: ModelInput) => invoke(IPC_CHANNELS.addModel, input),
  listAvailableProviderModels: (input: ListAvailableProviderModelsInput) =>
    invoke(IPC_CHANNELS.listAvailableProviderModels, input),
  createProjectTask: (projectId: string, input) => invoke(IPC_CHANNELS.createProjectTask, projectId, input),
  updateProjectTask: (taskId: string, input) => invoke(IPC_CHANNELS.updateProjectTask, taskId, input),
  deleteProjectTask: (taskId: string) => invoke(IPC_CHANNELS.deleteProjectTask, taskId),
  onProjectTaskChanged: (listener: (payload: ProjectTaskChangedPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectTaskChangedPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.projectTaskChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectTaskChanged, wrapped);
  },
  runProjectLab: (input) => invoke(IPC_CHANNELS.runProjectLab, input),
  deleteProjectLabThread: (threadId: string) => invoke(IPC_CHANNELS.deleteProjectLabThread, threadId),
  createProjectLoop: (input) => invoke(IPC_CHANNELS.createProjectLoop, input),
  getProjectLoopDetail: (loopId: string) => invoke(IPC_CHANNELS.getProjectLoopDetail, loopId),
  cancelProjectLoop: (loopId: string) => invoke(IPC_CHANNELS.cancelProjectLoop, loopId),
  resumeProjectLoop: (loopId: string) => invoke(IPC_CHANNELS.resumeProjectLoop, loopId),
  deleteProjectLoop: (loopId: string) => invoke(IPC_CHANNELS.deleteProjectLoop, loopId),
  respondToProjectLoopUiReview: (reviewId: string, input: ProjectLoopUiReviewDecisionInput) =>
    invoke(IPC_CHANNELS.respondToProjectLoopUiReview, reviewId, input),
  getProjectLoopUiReviewImage: (reviewId: string) => invoke(IPC_CHANNELS.getProjectLoopUiReviewImage, reviewId),
  getProjectLoopAvailability: (projectId: string) => invoke(IPC_CHANNELS.getProjectLoopAvailability, projectId),
  onProjectLoopChanged: (listener: (payload: ProjectLoopChangedPayload) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectLoopChangedPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.projectLoopChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectLoopChanged, wrapped);
  },
  generateProjectTaskRunPrompt: (input) => invoke(IPC_CHANNELS.generateProjectTaskRunPrompt, input),
  generateProjectInsight: (input) => invoke(IPC_CHANNELS.generateProjectInsight, input),
  addProject: (input: ProjectInput) => invoke(IPC_CHANNELS.addProject, input),
  addProviderAccount: (input: ProviderAccountInput) => invoke(IPC_CHANNELS.addProviderAccount, input),
  listComposerCommands: (input) => invoke(IPC_CHANNELS.listComposerCommands, input),
  cancelRunShell: (runId: string, toolCallId: string) => invoke(IPC_CHANNELS.cancelRunShell, runId, toolCallId),
  cancelRun: (runId: string) => invoke(IPC_CHANNELS.cancelRun, runId),
  commitRun: (runId: string, message: string) => invoke(IPC_CHANNELS.commitRun, runId, message),
  suggestCommitMessage: (runId: string) => invoke(IPC_CHANNELS.suggestCommitMessage, runId),
  analyzeRunDiff: (runId: string, options) => invoke(IPC_CHANNELS.analyzeRunDiff, runId, options),
  fetchProjectPrMrDiff: (projectId: string, input) => invoke(IPC_CHANNELS.fetchProjectPrMrDiff, projectId, input),
  analyzeProjectPrMrDiff: (projectId: string, input) =>
    invoke(IPC_CHANNELS.analyzeProjectPrMrDiff, projectId, input),
  getProjectForgeAuthStatus: (projectId: string) => invoke(IPC_CHANNELS.getProjectForgeAuthStatus, projectId),
  saveProjectForgeAuthToken: (projectId: string, token: string) =>
    invoke(IPC_CHANNELS.saveProjectForgeAuthToken, projectId, token),
  deleteProjectForgeAuthToken: (projectId: string) => invoke(IPC_CHANNELS.deleteProjectForgeAuthToken, projectId),
  getProjectForgePrMonitorSettings: (projectId: string) => invoke(IPC_CHANNELS.getProjectForgePrMonitorSettings, projectId),
  saveProjectForgePrMonitorSettings: (projectId: string, input: ProjectForgePrMonitorSettingsInput) =>
    invoke(IPC_CHANNELS.saveProjectForgePrMonitorSettings, projectId, input),
  listProjectForgeRequests: (projectId: string, input) =>
    invoke(IPC_CHANNELS.listProjectForgeRequests, projectId, input),
  getProjectForgeRequestDetails: (projectId: string, input) =>
    invoke(IPC_CHANNELS.getProjectForgeRequestDetails, projectId, input),
  postProjectPrMrReview: (projectId: string, input) => invoke(IPC_CHANNELS.postProjectPrMrReview, projectId, input),
  submitProjectPrMrComments: (projectId: string, input) => invoke(IPC_CHANNELS.submitProjectPrMrComments, projectId, input),
  replyProjectPrMrReviewThread: (projectId: string, input) =>
    invoke(IPC_CHANNELS.replyProjectPrMrReviewThread, projectId, input),
  resolveProjectPrMrReviewThread: (projectId: string, input) =>
    invoke(IPC_CHANNELS.resolveProjectPrMrReviewThread, projectId, input),
  createRun: (input: RunInput) => invoke(IPC_CHANNELS.createRun, input),
  continueRun: (input: ContinueRunInput) => invoke(IPC_CHANNELS.continueRun, input),
  createRunPullRequest: (runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string) =>
    invoke(IPC_CHANNELS.createRunPullRequest, runId, targetBranch, title, sourceBranchName, description),
  suggestRunPullRequestDescription: (runId: string, targetBranch: string, title: string) =>
    invoke(IPC_CHANNELS.suggestRunPullRequestDescription, runId, targetBranch, title),
  createRunLocalBranch: (runId: string, branchName: string) => invoke(IPC_CHANNELS.createRunLocalBranch, runId, branchName),
  getProjectBranches: (projectId: string) => invoke(IPC_CHANNELS.getProjectBranches, projectId),
  getProjectCurrentBranch: (projectId: string) => invoke(IPC_CHANNELS.getProjectCurrentBranch, projectId),
  getProjectBranchOverview: (projectId: string) => invoke(IPC_CHANNELS.getProjectBranchOverview, projectId),
  checkProjectGitConversion: (projectId: string) => invoke(IPC_CHANNELS.checkProjectGitConversion, projectId),
  convertProjectToGit: (projectId: string) => invoke(IPC_CHANNELS.convertProjectToGit, projectId),
  checkProjectFolderGitStatus: (repoPath: string) => invoke(IPC_CHANNELS.checkProjectFolderGitStatus, repoPath),
  checkoutProjectBranch: (projectId: string, branchName: string) =>
    invoke(IPC_CHANNELS.checkoutProjectBranch, projectId, branchName),
  fetchProjectBranches: (projectId: string) => invoke(IPC_CHANNELS.fetchProjectBranches, projectId),
  createProjectBranch: (projectId: string, input) => invoke(IPC_CHANNELS.createProjectBranch, projectId, input),
  renameProjectBranch: (projectId: string, input) => invoke(IPC_CHANNELS.renameProjectBranch, projectId, input),
  getProjectBranchDeleteImpact: (projectId: string, input) =>
    invoke(IPC_CHANNELS.getProjectBranchDeleteImpact, projectId, input),
  deleteProjectBranch: (projectId: string, input) => invoke(IPC_CHANNELS.deleteProjectBranch, projectId, input),
  pullProjectBranch: (projectId: string) => invoke(IPC_CHANNELS.pullProjectBranch, projectId),
  pushProjectBranch: (projectId: string, input) => invoke(IPC_CHANNELS.pushProjectBranch, projectId, input),
  followUpRun: (runId: string, prompt: string, options?: RunFollowUpOptions) =>
    invoke(IPC_CHANNELS.followUpRun, runId, prompt, options),
  publishRunBranch: (runId: string, branchName?: string) => invoke(IPC_CHANNELS.publishRunBranch, runId, branchName),
  deleteProject: (projectId: string) => invoke(IPC_CHANNELS.deleteProject, projectId),
  deleteProviderAccount: (providerAccountId: string) =>
    invoke(IPC_CHANNELS.deleteProviderAccount, providerAccountId),
  deleteRun: (runId: string) => invoke(IPC_CHANNELS.deleteRun, runId),
  deleteModel: (modelId: string) => invoke(IPC_CHANNELS.deleteModel, modelId),
  getRunDetail: (runId: string) => invoke(IPC_CHANNELS.getRunDetail, runId),
  addRunNote: (runId: string, input) => invoke(IPC_CHANNELS.addRunNote, runId, input),
  updateRunNote: (noteId: string, input) => invoke(IPC_CHANNELS.updateRunNote, noteId, input),
  deleteRunNote: (noteId: string) => invoke(IPC_CHANNELS.deleteRunNote, noteId),
  setRunListVisibility: (runId: string, visibility) => invoke(IPC_CHANNELS.setRunListVisibility, runId, visibility),
  getRunWorkspaceFile: (input) => invoke(IPC_CHANNELS.getRunWorkspaceFile, input),
  getRunWorktreeDiff: (runId: string) => invoke(IPC_CHANNELS.getRunWorktreeDiff, runId),
  resumeRunFromCheckpoint: (runId: string) => invoke(IPC_CHANNELS.resumeRunFromCheckpoint, runId),
  recoverInterruptedRun: (runId: string) => invoke(IPC_CHANNELS.recoverInterruptedRun, runId),
  undoRunToLastPrompt: (runId: string) => invoke(IPC_CHANNELS.undoRunToLastPrompt, runId),
  getRunPublishOptions: (runId: string) => invoke(IPC_CHANNELS.getRunPublishOptions, runId),
  getSnapshot: () => invoke(IPC_CHANNELS.getSnapshot),
  getNetworkProxySettings: () => invoke(IPC_CHANNELS.getNetworkProxySettings),
  selectProject: (projectId: string) => invoke(IPC_CHANNELS.selectProject, projectId),
  reorderProjects: (projectIds: string[]) => invoke(IPC_CHANNELS.reorderProjects, projectIds),
  getAppPaths: () => invoke(IPC_CHANNELS.getAppPaths),
  getDetectedCodexInstallation: () => invoke(IPC_CHANNELS.getDetectedCodexInstallation),
  getDetectedClaudeInstallation: () => invoke(IPC_CHANNELS.getDetectedClaudeInstallation),
  getDetectedCursorInstallation: () => invoke(IPC_CHANNELS.getDetectedCursorInstallation),
  listIntegratedSkills: () => invoke(IPC_CHANNELS.listIntegratedSkills),
  getIntegratedSkillContent: (skillId: string) => invoke(IPC_CHANNELS.getIntegratedSkillContent, skillId),
  pickProjectDirectory: () => invoke(IPC_CHANNELS.pickProjectDirectory),
  openPathInFileManager: (path: string) => invoke(IPC_CHANNELS.openPathInFileManager, path),
  openExternalUrl: (url: string) => invoke(IPC_CHANNELS.openExternalUrl, url),
  reportRendererLog: (payload) => invoke(IPC_CHANNELS.reportRendererLog, payload),
  pickIdeExecutable: () => invoke(IPC_CHANNELS.pickIdeExecutable),
  openRunWorktreeInIde: (runId: string, ideKind: SupportedIdeKind) =>
    invoke(IPC_CHANNELS.openRunWorktreeInIde, runId, ideKind),
  openFolderInIde: (folderPath: string, ideKind: SupportedIdeKind) =>
    invoke(IPC_CHANNELS.openFolderInIde, folderPath, ideKind),
  addBookmark: (runId: string) => invoke(IPC_CHANNELS.addBookmark, runId),
  removeBookmark: (runId: string) => invoke(IPC_CHANNELS.removeBookmark, runId),
  removeBookmarkById: (bookmarkId: string) => invoke(IPC_CHANNELS.removeBookmarkById, bookmarkId),
  isBookmarked: (runId: string) => invoke(IPC_CHANNELS.isBookmarked, runId),
  getBookmarksWithSteps: () => invoke(IPC_CHANNELS.getBookmarksWithSteps),
  addChatBookmark: (chatId: string) => invoke(IPC_CHANNELS.addChatBookmark, chatId),
  removeChatBookmark: (chatId: string) => invoke(IPC_CHANNELS.removeChatBookmark, chatId),
  removeChatBookmarkById: (bookmarkId: string) => invoke(IPC_CHANNELS.removeChatBookmarkById, bookmarkId),
  isChatBookmarked: (chatId: string) => invoke(IPC_CHANNELS.isChatBookmarked, chatId),
  getChatBookmarksWithSteps: () => invoke(IPC_CHANNELS.getChatBookmarksWithSteps),
  resetDatabase: () => invoke(IPC_CHANNELS.resetDatabase),
  createChat: (input: ChatInput) => invoke(IPC_CHANNELS.createChat, input),
  createRunChat: (runId: string, input: RunChatInput) => invoke(IPC_CHANNELS.createRunChat, runId, input),
  getRunChat: (runId: string) => invoke(IPC_CHANNELS.getRunChat, runId),
  getChatDetail: (chatId: string) => invoke(IPC_CHANNELS.getChatDetail, chatId),
  followUpChat: (chatId: string, prompt: string, options?: FollowUpChatOptions) =>
    invoke(IPC_CHANNELS.followUpChat, chatId, prompt, options),
  listChats: () => invoke(IPC_CHANNELS.listChats),
  listChatsWithSteps: () => invoke(IPC_CHANNELS.listChatsWithSteps),
  deleteChat: (chatId: string) => invoke(IPC_CHANNELS.deleteChat, chatId),
  cancelChat: (chatId: string) => invoke(IPC_CHANNELS.cancelChat, chatId),
  onChatEvent: (listener: (event: RunEvent & { chatId: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEvent & { chatId: string }) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.chatEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, wrapped);
  },
  runTerminalStart: (input) => invoke(IPC_CHANNELS.runTerminalStart, input),
  runTerminalWrite: (input) => invoke(IPC_CHANNELS.runTerminalWrite, input),
  runTerminalResize: (input) => invoke(IPC_CHANNELS.runTerminalResize, input),
  runTerminalKill: (sessionId: string) => invoke(IPC_CHANNELS.runTerminalKill, sessionId),
  onRunTerminalData: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunTerminalDataPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.runTerminalData, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runTerminalData, wrapped);
  },
  onRunTerminalExit: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunTerminalExitPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.runTerminalExit, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runTerminalExit, wrapped);
  },
  openSystemTerminalAtPath: (dirPath: string) => invoke(IPC_CHANNELS.openSystemTerminalAtPath, dirPath),
  onAppMenuCommand: (listener: (command: AppMenuCommand) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AppMenuCommand) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.appMenuCommand, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appMenuCommand, wrapped);
  },
  onAppWarning: (listener: (warning: AppWarning) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: AppWarning) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.appWarning, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appWarning, wrapped);
  },
  onAppSettingsChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on(IPC_CHANNELS.appSettingsChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.appSettingsChanged, wrapped);
  },
  onProjectForgeRequestOpen: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectForgeRequestOpenPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.projectForgeRequestOpen, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectForgeRequestOpen, wrapped);
  },
  onProjectForgeRequestNotification: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: ProjectForgeRequestNotificationPayload) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.projectForgeRequestNotification, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.projectForgeRequestNotification, wrapped);
  },
  showAppMenu: (section: AppMenuSection, x: number, y: number) => invoke(IPC_CHANNELS.showAppMenu, section, x, y),
  releaseRun: (runId: string) => invoke(IPC_CHANNELS.releaseRun, runId),
  respondToShellApproval: (runId: string, requestId: string, decision: ShellApprovalDecision, options?: ShellApprovalRespondOptions) =>
    invoke(IPC_CHANNELS.respondToShellApproval, runId, requestId, decision, options),
  respondToRunUserInput: (runId: string, requestId: string, answers: RunUserInputAnswers) =>
    invoke(IPC_CHANNELS.respondToRunUserInput, runId, requestId, answers),
  refreshSnapshot: () => invoke(IPC_CHANNELS.refreshSnapshot),
  setAppSetting: (key: string, value: string) => invoke(IPC_CHANNELS.setAppSetting, key, value),
  saveNetworkProxySettings: (input: NetworkProxySettingsInput) => invoke(IPC_CHANNELS.saveNetworkProxySettings, input),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.runEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld("buildwarden", api);
