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
  type ModelInput,
  type NetworkProxySettingsInput,
  type ProjectInput,
  type ProviderAccountInput,
  type RunEvent,
  type RunFollowUpOptions,
  type RunInput,
  type RunTerminalDataPayload,
  type RunTerminalExitPayload,
  type ShellApprovalDecision,
  type ShellApprovalRespondOptions,
  type SupportedIdeKind,
} from "@easycode/shared";

const api: DesktopApi = {
  activateRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.activateRun, runId),
  addModel: (input: ModelInput) => ipcRenderer.invoke(IPC_CHANNELS.addModel, input),
  createProjectTask: (projectId: string, input) => ipcRenderer.invoke(IPC_CHANNELS.createProjectTask, projectId, input),
  deleteProjectTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteProjectTask, taskId),
  runProjectLab: (input) => ipcRenderer.invoke(IPC_CHANNELS.runProjectLab, input),
  startProjectLabImplementation: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.startProjectLabImplementation, threadId),
  deleteProjectLabThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteProjectLabThread, threadId),
  generateProjectTaskRunPrompt: (input) => ipcRenderer.invoke(IPC_CHANNELS.generateProjectTaskRunPrompt, input),
  generateProjectInsight: (input) => ipcRenderer.invoke(IPC_CHANNELS.generateProjectInsight, input),
  addProject: (input: ProjectInput) => ipcRenderer.invoke(IPC_CHANNELS.addProject, input),
  addProviderAccount: (input: ProviderAccountInput) => ipcRenderer.invoke(IPC_CHANNELS.addProviderAccount, input),
  cancelRunShell: (runId: string, toolCallId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelRunShell, runId, toolCallId),
  cancelRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelRun, runId),
  commitRun: (runId: string, message: string) => ipcRenderer.invoke(IPC_CHANNELS.commitRun, runId, message),
  suggestCommitMessage: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.suggestCommitMessage, runId),
  analyzeRunDiff: (runId: string, options) => ipcRenderer.invoke(IPC_CHANNELS.analyzeRunDiff, runId, options),
  fetchProjectPrMrDiff: (projectId: string, input) => ipcRenderer.invoke(IPC_CHANNELS.fetchProjectPrMrDiff, projectId, input),
  analyzeProjectPrMrDiff: (projectId: string, input) =>
    ipcRenderer.invoke(IPC_CHANNELS.analyzeProjectPrMrDiff, projectId, input),
  createRun: (input: RunInput) => ipcRenderer.invoke(IPC_CHANNELS.createRun, input),
  continueRun: (input: ContinueRunInput) => ipcRenderer.invoke(IPC_CHANNELS.continueRun, input),
  createRunPullRequest: (runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.createRunPullRequest, runId, targetBranch, title, sourceBranchName, description),
  suggestRunPullRequestDescription: (runId: string, targetBranch: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.suggestRunPullRequestDescription, runId, targetBranch, title),
  createRunLocalBranch: (runId: string, branchName: string) => ipcRenderer.invoke(IPC_CHANNELS.createRunLocalBranch, runId, branchName),
  getProjectBranches: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.getProjectBranches, projectId),
  getProjectCurrentBranch: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.getProjectCurrentBranch, projectId),
  checkoutProjectBranch: (projectId: string, branchName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.checkoutProjectBranch, projectId, branchName),
  followUpRun: (runId: string, prompt: string, options?: RunFollowUpOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.followUpRun, runId, prompt, options),
  publishRunBranch: (runId: string, branchName?: string) => ipcRenderer.invoke(IPC_CHANNELS.publishRunBranch, runId, branchName),
  deleteProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteProject, projectId),
  deleteProviderAccount: (providerAccountId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteProviderAccount, providerAccountId),
  deleteRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteRun, runId),
  deleteModel: (modelId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteModel, modelId),
  getRunDetail: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.getRunDetail, runId),
  setRunListVisibility: (runId: string, visibility) => ipcRenderer.invoke(IPC_CHANNELS.setRunListVisibility, runId, visibility),
  getRunWorktreeDiff: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.getRunWorktreeDiff, runId),
  resumeRunFromCheckpoint: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.resumeRunFromCheckpoint, runId),
  recoverInterruptedRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.recoverInterruptedRun, runId),
  undoRunToLastPrompt: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.undoRunToLastPrompt, runId),
  getRunPublishOptions: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.getRunPublishOptions, runId),
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  getNetworkProxySettings: () => ipcRenderer.invoke(IPC_CHANNELS.getNetworkProxySettings),
  reorderProjects: (projectIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.reorderProjects, projectIds),
  getAppPaths: () => ipcRenderer.invoke(IPC_CHANNELS.getAppPaths),
  getDetectedCodexInstallation: () => ipcRenderer.invoke(IPC_CHANNELS.getDetectedCodexInstallation),
  getDetectedClaudeInstallation: () => ipcRenderer.invoke(IPC_CHANNELS.getDetectedClaudeInstallation),
  pickProjectDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.pickProjectDirectory),
  openPathInFileManager: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.openPathInFileManager, path),
  openExternalUrl: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.openExternalUrl, url),
  reportRendererLog: (payload) => ipcRenderer.invoke(IPC_CHANNELS.reportRendererLog, payload),
  pickIdeExecutable: () => ipcRenderer.invoke(IPC_CHANNELS.pickIdeExecutable),
  openRunWorktreeInIde: (runId: string, ideKind: SupportedIdeKind) =>
    ipcRenderer.invoke(IPC_CHANNELS.openRunWorktreeInIde, runId, ideKind),
  addBookmark: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.addBookmark, runId),
  removeBookmark: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeBookmark, runId),
  removeBookmarkById: (bookmarkId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeBookmarkById, bookmarkId),
  isBookmarked: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.isBookmarked, runId),
  getBookmarksWithSteps: () => ipcRenderer.invoke(IPC_CHANNELS.getBookmarksWithSteps),
  addChatBookmark: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.addChatBookmark, chatId),
  removeChatBookmark: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeChatBookmark, chatId),
  removeChatBookmarkById: (bookmarkId: string) => ipcRenderer.invoke(IPC_CHANNELS.removeChatBookmarkById, bookmarkId),
  isChatBookmarked: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.isChatBookmarked, chatId),
  getChatBookmarksWithSteps: () => ipcRenderer.invoke(IPC_CHANNELS.getChatBookmarksWithSteps),
  resetDatabase: () => ipcRenderer.invoke(IPC_CHANNELS.resetDatabase),
  createChat: (input: ChatInput) => ipcRenderer.invoke(IPC_CHANNELS.createChat, input),
  getChatDetail: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.getChatDetail, chatId),
  followUpChat: (chatId: string, prompt: string, options?: FollowUpChatOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.followUpChat, chatId, prompt, options),
  listChats: () => ipcRenderer.invoke(IPC_CHANNELS.listChats),
  listChatsWithSteps: () => ipcRenderer.invoke(IPC_CHANNELS.listChatsWithSteps),
  deleteChat: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.deleteChat, chatId),
  cancelChat: (chatId: string) => ipcRenderer.invoke(IPC_CHANNELS.cancelChat, chatId),
  onChatEvent: (listener: (event: RunEvent & { chatId: string }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEvent & { chatId: string }) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.chatEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, wrapped);
  },
  runTerminalStart: (input) => ipcRenderer.invoke(IPC_CHANNELS.runTerminalStart, input),
  runTerminalWrite: (input) => ipcRenderer.invoke(IPC_CHANNELS.runTerminalWrite, input),
  runTerminalResize: (input) => ipcRenderer.invoke(IPC_CHANNELS.runTerminalResize, input),
  runTerminalKill: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.runTerminalKill, sessionId),
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
  openSystemTerminalAtPath: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openSystemTerminalAtPath, dirPath),
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
  showAppMenu: (section: AppMenuSection, x: number, y: number) => ipcRenderer.invoke(IPC_CHANNELS.showAppMenu, section, x, y),
  releaseRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.releaseRun, runId),
  respondToShellApproval: (runId: string, requestId: string, decision: ShellApprovalDecision, options?: ShellApprovalRespondOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.respondToShellApproval, runId, requestId, decision, options),
  refreshSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.refreshSnapshot),
  setAppSetting: (key: string, value: string) => ipcRenderer.invoke(IPC_CHANNELS.setAppSetting, key, value),
  saveNetworkProxySettings: (input: NetworkProxySettingsInput) => ipcRenderer.invoke(IPC_CHANNELS.saveNetworkProxySettings, input),
  onRunEvent: (listener: (event: RunEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: RunEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.runEvent, wrapped);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld("easycode", api);
