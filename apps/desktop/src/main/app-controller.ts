import { BuildWardenDatabase } from "@buildwarden/db";
import type {
  AppWarning,
  AssistProjectForgeIssueInput,
  ChatEvent,
  ChatInput,
  CommentProjectForgeIssueInput,
  ContinueRunInput,
  CreateProjectBranchInput,
  CreateProjectForgeIssueInput,
  CreateProjectLoopInput,
  DeleteProjectBranchInput,
  DesktopApi,
  FetchProjectPrMrDiffInput,
  FollowUpChatOptions,
  FollowUpDelivery,
  FollowUpQueueAction,
  GenerateProjectInsightInput,
  GetProjectForgeIssueDetailsInput,
  GetProjectForgeIssueImageInput,
  GetProjectForgeRequestDetailsInput,
  ListAvailableProviderModelsInput,
  ListComposerCommandsInput,
  ListProjectForgeIssuesInput,
  ListProjectForgeRequestsInput,
  ManageOwnedProcessesInput,
  MergeProjectBranchInput,
  MergeProjectForgeRequestInput,
  MergeRunForgeRequestInput,
  ModelInput,
  NetworkProxySettingsInput,
  OrchestrationAdoptionDecisionInput,
  OrchestrationChangedPayload,
  OrchestrationTaskMessageInput,
  OwnedProcessOwner,
  PostProjectPrMrReviewInput,
  ProjectActivityQueryInput,
  ProjectAutomationInput,
  ProjectForgePrMonitorConfig,
  ProjectForgePrMonitorSettingsInput,
  ProjectInput,
  ProjectLoopChangedPayload,
  ProjectLoopUiReviewDecisionInput,
  ProjectTaskInput,
  ProviderAccountInput,
  ProviderType,
  PullProjectBranchInput,
  PushProjectBranchInput,
  RebaseProjectBranchInput,
  RenameProjectBranchInput,
  RendererLogPayload,
  ReplyProjectPrMrReviewThreadInput,
  ResolveProjectPrMrReviewThreadInput,
  RunChatInput,
  RunDiffReviewOptions,
  RunEvent,
  RunFollowUpOptions,
  RunInput,
  RunListVisibility,
  RunProjectLabInput,
  RunForkInput,
  VisualReplyFrame,
  RunRewindInput,
  RunUserInputAnswers,
  RunWorkspaceFileInput,
  SecretStore,
  ShellApprovalDecision,
  ShellApprovalRespondOptions,
  SkillImportInput,
  StartPrWatchInput,
  SubmitProjectPrMrCommentsInput,
  SubscriptionLimitsInput,
  SubscriptionResetInput,
  SupportedIdeKind,
  UpdateProjectAutomationInput,
  UpdateProjectForgeIssueInput,
  UpdateProjectForgeRequestInput,
  UpdateProjectTaskInput,
  UpdateRunForgeRequestInput,
  UpdateRunNoteInput,
  UpdateRunOrganizationInput,
  UsageCostReportInput,
  UserAnchoredHistoryPageRequest,
} from "@buildwarden/shared";
import type { AppControllerDesktopServices } from "./desktop-platform-services";
import { HostEventBus } from "./host-events";
import type { HostTerminal } from "./host-terminal-service";
import { type AppControllerLifecycle, AppServiceContext } from "./services/app-service";
import type { AppServices } from "./services/app-services";
import { createAppServices } from "./services/create-app-services";

/** The app's API. Every method is implemented by one of the services in `services/`. */
export class AppController
  implements
    Omit<
      DesktopApi,
      | "getRemoteAccessStatus"
      | "getDesignBackgroundImage"
      | "setDesignBackgroundImage"
      | "listHostDirectories"
      | "createRemoteAccessPairing"
      | "listRemoteAccessSessions"
      | "revokeRemoteAccessSession"
      | "onRunEvent"
      | "ensureRunBrowser"
      | "getRunBrowserPreview"
      | "navigateRunBrowser"
      | "runBrowserAction"
      | "setRunBrowserViewport"
      | "setRunBrowserDesktopSurface"
      | "getRunBrowserElementCapture"
      | "sendRunBrowserInput"
      | "onRunBrowserEvent"
      | "runTerminalList"
      | "runTerminalStart"
      | "runTerminalWrite"
      | "runTerminalResize"
      | "runTerminalKill"
      | "onRunTerminalData"
      | "onRunTerminalExit"
      | "onAppMenuCommand"
      | "consumePendingDeepLink"
      | "onDeepLinkReceived"
      | "onAppSettingsChanged"
      | "onProviderCliUpdatesChanged"
      | "onOwnedProcessesChanged"
      | "onProjectForgeRequestOpen"
      | "onProjectForgeRequestNotification"
      | "onRunForgeRequestChanged"
      | "onProjectTaskChanged"
      | "onRunOrganizationChanged"
      | "onOrchestrationChanged"
      | "showAppMenu"
      | "openSystemTerminalAtPath"
      | "openExternalUrl"
      | "exportDataBackup"
      | "selectDataBackupForImport"
      | "importDataBackup"
    >
{
  private readonly services: AppServices;

  constructor(
    db: BuildWardenDatabase,
    secrets: SecretStore,
    logDirPath: string,
    desktop: AppControllerDesktopServices,
    terminal: Pick<HostTerminal, "killForRunId">,
    events: HostEventBus,
    lifecycle?: AppControllerLifecycle,
  ) {
    const context = new AppServiceContext(db, secrets, logDirPath, desktop, terminal, events, lifecycle);
    this.services = createAppServices(context);
  }

  // Persists run and chat timeline events and publishes them to connected clients.
  onChatEvent(listener: (event: ChatEvent) => void) { return this.services.runEvents.onChatEvent(listener); }
  onRunEvent(listener: (event: RunEvent) => void) { return this.services.runEvents.onRunEvent(listener); }
  onAppWarning(listener: (warning: AppWarning) => void) { return this.services.runEvents.onAppWarning(listener); }
  getAttachmentBlob(blobId: string) { return this.services.runEvents.getAttachmentBlob(blobId); }
  async getVisualReplyFrame(runId: string, stepId: string): Promise<VisualReplyFrame> { return { kind: "document", document: this.services.visualReplies.getVisualReplyDocument(runId, stepId) }; }
  /** For browser clients: a signed address on the host, because their own page policy blocks inline frame scripts. */
  async getVisualReplyFrameUrl(runId: string, stepId: string): Promise<VisualReplyFrame> { return { kind: "url", url: this.services.visualReplies.createFrameTicketPath(runId, stepId) }; }
  resolveVisualReplyFrameTicket(ticket: string) { return this.services.visualReplies.resolveFrameTicket(ticket); }
  getStepContent(kind: "run" | "chat", stepId: string) { return this.services.runEvents.getStepContent(kind, stepId); }
  getStepPreviewContent(kind: "run" | "chat", stepId: string) { return this.services.runEvents.getStepPreviewContent(kind, stepId); }

  // Tracks the live run and chat worker threads and stops them.
  stopAgentWorkers() { return this.services.activeWorkers.stopAgentWorkers(); }
  getActiveSessionCounts() { return this.services.activeWorkers.getActiveSessionCounts(); }

  // Builds the app snapshot and maintains the selected and ordered projects, runs and chats.
  getSnapshot() { return this.services.appState.getSnapshot(); }
  refreshSnapshot() { return this.services.appState.refreshSnapshot(); }
  selectProject(projectId: string) { return this.services.appState.selectProject(projectId); }
  reorderProjects(projectIds: string[]) { return this.services.appState.reorderProjects(projectIds); }

  // Reads and changes app settings.
  getNetworkProxySettings() { return this.services.settings.getNetworkProxySettings(); }
  saveNetworkProxySettings(input: NetworkProxySettingsInput) { return this.services.settings.saveNetworkProxySettings(input); }
  setAppSetting(key: string, value: string) { return this.services.settings.setAppSetting(key, value); }
  getTerminalSettings() { return this.services.settings.getTerminalSettings(); }

  // Lists, updates and reviews a project's pull and merge requests.
  fetchProjectPrMrDiff(projectId: string, input: FetchProjectPrMrDiffInput) { return this.services.forgeRequests.fetchProjectPrMrDiff(projectId, input); }
  getProjectForgeAuthStatus(projectId: string) { return this.services.forgeRequests.getProjectForgeAuthStatus(projectId); }
  saveProjectForgeAuthToken(projectId: string, token: string) { return this.services.forgeRequests.saveProjectForgeAuthToken(projectId, token); }
  deleteProjectForgeAuthToken(projectId: string) { return this.services.forgeRequests.deleteProjectForgeAuthToken(projectId); }
  getProjectForgePrMonitorSettings(projectId: string) { return this.services.forgeRequests.getProjectForgePrMonitorSettings(projectId); }
  saveProjectForgePrMonitorSettings(projectId: string, input: ProjectForgePrMonitorSettingsInput) {
    return this.services.forgeRequests.saveProjectForgePrMonitorSettings(projectId, input);
  }
  listProjectForgePrMonitorConfigs() { return this.services.forgeRequests.listProjectForgePrMonitorConfigs(); }
  listProjectForgeRequests(projectId: string, input?: ListProjectForgeRequestsInput) {
    return this.services.forgeRequests.listProjectForgeRequests(projectId, input);
  }
  getProjectForgeRequestDetails(projectId: string, input: GetProjectForgeRequestDetailsInput) {
    return this.services.forgeRequests.getProjectForgeRequestDetails(projectId, input);
  }
  getProjectForgeRequestStatus(projectId: string, input: GetProjectForgeRequestDetailsInput) {
    return this.services.forgeRequests.getProjectForgeRequestStatus(projectId, input);
  }
  updateProjectForgeRequest(projectId: string, input: UpdateProjectForgeRequestInput) {
    return this.services.forgeRequests.updateProjectForgeRequest(projectId, input);
  }
  mergeProjectForgeRequest(projectId: string, input: MergeProjectForgeRequestInput) {
    return this.services.forgeRequests.mergeProjectForgeRequest(projectId, input);
  }
  shouldRunProjectForgeBackgroundCheck(projectId: string, startup = false) {
    return this.services.forgeRequests.shouldRunProjectForgeBackgroundCheck(projectId, startup);
  }
  postProjectPrMrReview(projectId: string, input: PostProjectPrMrReviewInput) { return this.services.forgeRequests.postProjectPrMrReview(projectId, input); }
  submitProjectPrMrComments(projectId: string, input: SubmitProjectPrMrCommentsInput) {
    return this.services.forgeRequests.submitProjectPrMrComments(projectId, input);
  }
  replyProjectPrMrReviewThread(projectId: string, input: ReplyProjectPrMrReviewThreadInput) {
    return this.services.forgeRequests.replyProjectPrMrReviewThread(projectId, input);
  }
  resolveProjectPrMrReviewThread(projectId: string, input: ResolveProjectPrMrReviewThreadInput) {
    return this.services.forgeRequests.resolveProjectPrMrReviewThread(projectId, input);
  }

  // Finds and refreshes the pull or merge request that belongs to a run.
  startRunForgeDiscovery() { return this.services.runForge.startRunForgeDiscovery(); }
  stopRunForgeDiscovery() { return this.services.runForge.stopRunForgeDiscovery(); }
  getRunForgeRequestDetails(runId: string, options?: { refresh?: boolean }) { return this.services.runForge.getRunForgeRequestDetails(runId, options); }
  refreshRunForgeRequest(runId: string, options?: { automatic?: boolean; onOpen?: boolean }) {
    return this.services.runForge.refreshRunForgeRequest(runId, options);
  }
  getRunForgeRequestDiff(runId: string) { return this.services.runForge.getRunForgeRequestDiff(runId); }
  updateRunForgeRequest(runId: string, input: UpdateRunForgeRequestInput) { return this.services.runForge.updateRunForgeRequest(runId, input); }
  mergeRunForgeRequest(runId: string, input: MergeRunForgeRequestInput) { return this.services.runForge.mergeRunForgeRequest(runId, input); }
  onRunForgeRequestChanged(listener: (payload: import("@buildwarden/shared").RunForgeRequestChangedPayload) => void) {
    return this.services.runForge.onRunForgeRequestChanged(listener);
  }

  // Connects GitHub and GitLab issues with tasks, runs and automations.
  listProjectForgeIssues(projectId: string, input?: ListProjectForgeIssuesInput) {
    return this.services.forgeIssueActions.listProjectForgeIssues(projectId, input);
  }
  getProjectForgeIssueDetails(projectId: string, input: GetProjectForgeIssueDetailsInput) {
    return this.services.forgeIssueActions.getProjectForgeIssueDetails(projectId, input);
  }
  getProjectForgeIssueImage(projectId: string, input: GetProjectForgeIssueImageInput) {
    return this.services.forgeIssueActions.getProjectForgeIssueImage(projectId, input);
  }
  getProjectForgeIssueMetadata(projectId: string) { return this.services.forgeIssueActions.getProjectForgeIssueMetadata(projectId); }
  createProjectForgeIssue(projectId: string, input: CreateProjectForgeIssueInput) {
    return this.services.forgeIssueActions.createProjectForgeIssue(projectId, input);
  }
  updateProjectForgeIssue(projectId: string, input: UpdateProjectForgeIssueInput) {
    return this.services.forgeIssueActions.updateProjectForgeIssue(projectId, input);
  }
  commentProjectForgeIssue(projectId: string, input: CommentProjectForgeIssueInput) {
    return this.services.forgeIssueActions.commentProjectForgeIssue(projectId, input);
  }
  assistProjectForgeIssue(projectId: string, input: AssistProjectForgeIssueInput) {
    return this.services.forgeIssueActions.assistProjectForgeIssue(projectId, input);
  }
  collectProjectForgeIssueNotifications(config: ProjectForgePrMonitorConfig) {
    return this.services.forgeIssueActions.collectProjectForgeIssueNotifications(config);
  }

  // Reviews run diffs and pull or merge request diffs with a model.
  analyzeRunDiff(runId: string, options?: RunDiffReviewOptions) { return this.services.diffReview.analyzeRunDiff(runId, options); }
  analyzeProjectPrMrDiff(projectId: string, input: { prUrl: string; diff: string; modelId?: string }) {
    return this.services.diffReview.analyzeProjectPrMrDiff(projectId, input);
  }

  // Adds and removes projects and manages their Git branches.
  migrateProjectBaseBranches() { return this.services.projects.migrateProjectBaseBranches(); }
  getProjectBranches(projectId: string) { return this.services.projects.getProjectBranches(projectId); }
  getProjectCurrentBranch(projectId: string) { return this.services.projects.getProjectCurrentBranch(projectId); }
  getProjectBranchOverview(projectId: string) { return this.services.projects.getProjectBranchOverview(projectId); }
  checkProjectGitConversion(projectId: string) { return this.services.projects.checkProjectGitConversion(projectId); }
  convertProjectToGit(projectId: string) { return this.services.projects.convertProjectToGit(projectId); }
  updateProjectBaseBranch(projectId: string, branchName: string) { return this.services.projects.updateProjectBaseBranch(projectId, branchName); }
  checkProjectFolderGitStatus(repoPath: string) { return this.services.projects.checkProjectFolderGitStatus(repoPath); }
  getProjectBranchDeleteImpact(projectId: string, input: DeleteProjectBranchInput) {
    return this.services.projects.getProjectBranchDeleteImpact(projectId, input);
  }
  checkoutProjectBranch(projectId: string, branchName: string) { return this.services.projects.checkoutProjectBranch(projectId, branchName); }
  fetchProjectBranches(projectId: string) { return this.services.projects.fetchProjectBranches(projectId); }
  createProjectBranch(projectId: string, input: CreateProjectBranchInput) { return this.services.projects.createProjectBranch(projectId, input); }
  renameProjectBranch(projectId: string, input: RenameProjectBranchInput) { return this.services.projects.renameProjectBranch(projectId, input); }
  deleteProjectBranch(projectId: string, input: DeleteProjectBranchInput) { return this.services.projects.deleteProjectBranch(projectId, input); }
  pullProjectBranch(projectId: string, input?: PullProjectBranchInput) { return this.services.projects.pullProjectBranch(projectId, input); }
  pushProjectBranch(projectId: string, input: PushProjectBranchInput) { return this.services.projects.pushProjectBranch(projectId, input); }
  mergeProjectBranch(projectId: string, input: MergeProjectBranchInput) { return this.services.projects.mergeProjectBranch(projectId, input); }
  rebaseProjectBranch(projectId: string, input: RebaseProjectBranchInput) { return this.services.projects.rebaseProjectBranch(projectId, input); }
  abortProjectGitOperation(projectId: string) { return this.services.projects.abortProjectGitOperation(projectId); }
  deleteProjectRemoteBranch(projectId: string, input: DeleteProjectBranchInput) { return this.services.projects.deleteProjectRemoteBranch(projectId, input); }
  addProject(input: ProjectInput) { return this.services.projects.addProject(input); }
  deleteProject(projectId: string) { return this.services.projects.deleteProject(projectId); }
  pickProjectDirectory() { return this.services.projects.pickProjectDirectory(); }

  // Manages provider accounts, models and composer commands.
  addProviderAccount(input: ProviderAccountInput) { return this.services.providerAccounts.addProviderAccount(input); }
  setProviderApiKey(providerAccountId: string, apiKey: string) { return this.services.providerAccounts.setProviderApiKey(providerAccountId, apiKey); }
  addModel(input: ModelInput) { return this.services.providerAccounts.addModel(input); }
  listAvailableProviderModels(input: ListAvailableProviderModelsInput) { return this.services.providerAccounts.listAvailableProviderModels(input); }
  listComposerCommands(input: ListComposerCommandsInput) { return this.services.providerAccounts.listComposerCommands(input); }
  deleteProviderAccount(providerAccountId: string) { return this.services.providerAccounts.deleteProviderAccount(providerAccountId); }
  recheckProviderCapabilities(providerAccountId: string) { return this.services.providerAccounts.recheckProviderCapabilities(providerAccountId); }
  listAcpRegistryAgents() { return this.services.providerAccounts.listAcpRegistryAgents(); }
  deleteModel(modelId: string) { return this.services.providerAccounts.deleteModel(modelId); }
  getModelDeletionImpact(modelId: string) { return this.services.providerAccounts.getModelDeletionImpact(modelId); }

  // Knows the installed provider agents: adapters, versions, updates, limits and reported capabilities.
  startProviderCliUpdateChecks() { return this.services.providerRuntime.startProviderCliUpdateChecks(); }
  stopProviderCliUpdateChecks() { return this.services.providerRuntime.stopProviderCliUpdateChecks(); }
  getProviderCliUpdates() { return this.services.providerRuntime.getProviderCliUpdates(); }
  checkProviderCliUpdates() { return this.services.providerRuntime.checkProviderCliUpdates(); }
  runProviderCliUpdate(providerType: ProviderType) { return this.services.providerRuntime.runProviderCliUpdate(providerType); }
  getDetectedCodexInstallation() { return this.services.providerRuntime.getDetectedCodexInstallation(); }
  getDetectedClaudeInstallation() { return this.services.providerRuntime.getDetectedClaudeInstallation(); }
  getDetectedCursorInstallation() { return this.services.providerRuntime.getDetectedCursorInstallation(); }

  // Reports usage costs and subscription limits.
  getSubscriptionLimits(input: SubscriptionLimitsInput) { return this.services.usage.getSubscriptionLimits(input); }
  getSubscriptionLimitsAvailability() { return this.services.usage.getSubscriptionLimitsAvailability(); }
  useSubscriptionReset(input: SubscriptionResetInput) { return this.services.usage.useSubscriptionReset(input); }
  getUsageCostReport(input: UsageCostReportInput) { return this.services.usage.getUsageCostReport(input); }

  // Generates and renames run and chat titles.
  renameRunTitle(id: string, title: string) { return this.services.titles.renameRunTitle(id, title); }
  regenerateRunTitle(id: string) { return this.services.titles.regenerateRunTitle(id); }
  renameChatTitle(id: string, title: string) { return this.services.titles.renameChatTitle(id, title); }
  regenerateChatTitle(id: string) { return this.services.titles.regenerateChatTitle(id); }

  // Schedules and starts project automations.
  createProjectAutomation(projectId: string, input: ProjectAutomationInput) { return this.services.automations.createProjectAutomation(projectId, input); }
  getProjectAutomation(automationId: string) { return this.services.automations.getProjectAutomation(automationId); }
  updateProjectAutomation(automationId: string, input: UpdateProjectAutomationInput) {
    return this.services.automations.updateProjectAutomation(automationId, input);
  }
  deleteProjectAutomation(automationId: string) { return this.services.automations.deleteProjectAutomation(automationId); }
  runProjectAutomationNow(automationId: string) { return this.services.automations.runProjectAutomationNow(automationId); }
  getStartupAutomationCatchUp() { return this.services.automations.getStartupAutomationCatchUp(); }
  resolveStartupAutomationCatchUp(automationIds: string[]) { return this.services.automations.resolveStartupAutomationCatchUp(automationIds); }
  resolveStartupAutomationsUnattended(runAllMissed: boolean, retryDelayMs?: number) { return this.services.automations.resolveStartupAutomationsUnattended(runAllMissed, retryDelayMs); }
  startAutomationScheduler() { return this.services.automations.startAutomationScheduler(); }
  onAutomationStarted(listener: (payload: import("@buildwarden/shared").AutomationStartedNotificationPayload) => void) {
    return this.services.automations.onAutomationStarted(listener);
  }

  // Manages the project task board.
  createProjectTask(projectId: string, input: ProjectTaskInput) { return this.services.tasks.createProjectTask(projectId, input); }
  getProjectTask(taskId: string) { return this.services.tasks.getProjectTask(taskId); }
  updateProjectTask(taskId: string, input: UpdateProjectTaskInput) { return this.services.tasks.updateProjectTask(taskId, input); }
  syncProjectTaskPullRequestStatuses(projectId: string, automatic = false) {
    return this.services.tasks.syncProjectTaskPullRequestStatuses(projectId, automatic);
  }
  deleteProjectTask(taskId: string) { return this.services.tasks.deleteProjectTask(taskId); }
  generateProjectTaskRunPrompt(input: { projectId: string; title: string; notes: string; modelId: string }) {
    return this.services.tasks.generateProjectTaskRunPrompt(input);
  }

  // Manages bookmarks, sections, notes, layouts and the attention inbox.
  addBookmark(runId: string) { return this.services.organization.addBookmark(runId); }
  removeBookmark(runId: string) { return this.services.organization.removeBookmark(runId); }
  removeBookmarkById(bookmarkId: string) { return this.services.organization.removeBookmarkById(bookmarkId); }
  getBookmarksWithSteps() { return this.services.organization.getBookmarksWithSteps(); }
  addChatBookmark(chatId: string) { return this.services.organization.addChatBookmark(chatId); }
  removeChatBookmark(chatId: string) { return this.services.organization.removeChatBookmark(chatId); }
  removeChatBookmarkById(bookmarkId: string) { return this.services.organization.removeChatBookmarkById(bookmarkId); }
  isChatBookmarked(chatId: string) { return this.services.organization.isChatBookmarked(chatId); }
  getChatBookmarksWithSteps() { return this.services.organization.getChatBookmarksWithSteps(); }
  listBookmarkEntries() { return this.services.organization.listBookmarkEntries(); }
  getBookmarkWithSteps(bookmarkId: string) { return this.services.organization.getBookmarkWithSteps(bookmarkId); }
  searchBookmarks(query: string) { return this.services.organization.searchBookmarks(query); }
  isBookmarked(runId: string) { return this.services.organization.isBookmarked(runId); }
  getAttentionInbox() { return this.services.organization.getAttentionInbox(); }
  acknowledgeAttentionItem(itemId: string) { return this.services.organization.acknowledgeAttentionItem(itemId); }
  acknowledgeAttentionItems(itemIds: string[]) { return this.services.organization.acknowledgeAttentionItems(itemIds); }
  listRunWorkspaceLayouts() { return this.services.organization.listRunWorkspaceLayouts(); }
  setRunWorkspaceLayout(runId: unknown, layout: unknown) { return this.services.organization.setRunWorkspaceLayout(runId, layout); }
  searchRunUserInput(query: string) { return this.services.organization.searchRunUserInput(query); }
  addRunNote(runId: string, input: { content: string }) { return this.services.organization.addRunNote(runId, input); }
  updateRunNote(noteId: string, input: UpdateRunNoteInput) { return this.services.organization.updateRunNote(noteId, input); }
  deleteRunNote(noteId: string) { return this.services.organization.deleteRunNote(noteId); }
  startHistorySearchBackfill() { return this.services.organization.startHistorySearchBackfill(); }
  createRunSection(name: string, color?: string) { return this.services.organization.createRunSection(name, color); }
  setRunSectionColor(sectionId: string, color: string) { return this.services.organization.setRunSectionColor(sectionId, color); }
  renameRunSection(sectionId: string, name: string) { return this.services.organization.renameRunSection(sectionId, name); }
  deleteRunSection(sectionId: string) { return this.services.organization.deleteRunSection(sectionId); }
  reorderRunSections(sectionIds: string[]) { return this.services.organization.reorderRunSections(sectionIds); }
  updateRunOrganization(runId: string, input: UpdateRunOrganizationInput) { return this.services.organization.updateRunOrganization(runId, input); }
  setRunListVisibility(runId: string, visibility: RunListVisibility) { return this.services.organization.setRunListVisibility(runId, visibility); }

  // Verifies run revisions with the project's commands.
  setProjectRevisionVerificationPolicy(projectId: string, enabled: boolean) {
    return this.services.verification.setProjectRevisionVerificationPolicy(projectId, enabled);
  }
  getRunVerification(runId: string) { return this.services.verification.getRunVerification(runId); }
  verifyRunRevision(runId: string) { return this.services.verification.verifyRunRevision(runId); }
  cancelRunVerification(runId: string) { return this.services.verification.cancelRunVerification(runId); }
  stopRevisionVerifications() { return this.services.verification.stopRevisionVerifications(); }

  // Imports skills and selects them for runs and chats.
  importSkill(input: SkillImportInput) { return this.services.skills.importSkill(input); }
  removeImportedSkill(skillId: string) { return this.services.skills.removeImportedSkill(skillId); }
  getSessionSkills(kind: "run" | "chat", id: string) { return this.services.skills.getSessionSkills(kind, id); }
  setSessionSkills(kind: "run" | "chat", id: string, skillIds: string[] | null) { return this.services.skills.setSessionSkills(kind, id, skillIds); }
  listIntegratedSkills() { return this.services.skills.listIntegratedSkills(); }
  getIntegratedSkillContent(skillId: string) { return this.services.skills.getIntegratedSkillContent(skillId); }

  // Covers the app's data folder, database maintenance and opening folders outside the app.
  reportRendererLog(payload: RendererLogPayload) { return this.services.system.reportRendererLog(payload); }
  resetDatabase() { return this.services.system.resetDatabase(); }
  getDatabaseStorageInfo() { return this.services.system.getDatabaseStorageInfo(); }
  compactDatabase() { return this.services.system.compactDatabase(); }
  openPathInFileManager(dirPath: string) { return this.services.system.openPathInFileManager(dirPath); }
  getAppPaths() { return this.services.system.getAppPaths(); }
  pickIdeExecutable() { return this.services.system.pickIdeExecutable(); }
  openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind) { return this.services.system.openRunWorktreeInIde(runId, ideKind); }
  openFolderInIde(folderPath: string, ideKind: SupportedIdeKind) { return this.services.system.openFolderInIde(folderPath, ideKind); }

  // Lists and stops the processes that runs and chats started.
  getOwnedProcesses(owner: OwnedProcessOwner) { return this.services.processes.getOwnedProcesses(owner); }
  manageOwnedProcesses(input: ManageOwnedProcessesInput) { return this.services.processes.manageOwnedProcesses(input); }
  getOwnedProcessOutput(owner: OwnedProcessOwner, processId: string) { return this.services.processes.getOwnedProcessOutput(owner, processId); }

  // Reads run history, workspace files and diffs for the run page.
  getProjectCodeMap(projectId: string) { return this.services.runDetails.getProjectCodeMap(projectId); }
  getRunDetail(runId: string) { return this.services.runDetails.getRunDetail(runId); }
  getEarlierRunHistory(runId: string, request: UserAnchoredHistoryPageRequest) { return this.services.runDetails.getEarlierRunHistory(runId, request); }
  getRunWorkspaceFile(input: RunWorkspaceFileInput) { return this.services.runDetails.getRunWorkspaceFile(input); }
  getRunWorktreeDiff(runId: string) { return this.services.runDetails.getRunWorktreeDiff(runId); }
  getRunWorktreeDiffSummary(runId: string) { return this.services.runDetails.getRunWorktreeDiffSummary(runId); }

  // Creates, continues and deletes chats, including the chats that belong to a run.
  createChat(input: ChatInput) { return this.services.chats.createChat(input); }
  getChatDetail(chatId: string) { return this.services.chats.getChatDetail(chatId); }
  getEarlierChatHistory(chatId: string, request: UserAnchoredHistoryPageRequest) { return this.services.chats.getEarlierChatHistory(chatId, request); }
  getRunChat(runId: string) { return this.services.chats.getRunChat(runId); }
  createRunChat(runId: string, input: RunChatInput) { return this.services.chats.createRunChat(runId, input); }
  followUpChat(chatId: string, prompt: string, options?: FollowUpChatOptions, extraLogMetadata?: Record<string, unknown>) {
    return this.services.chats.followUpChat(chatId, prompt, options, extraLogMetadata);
  }
  listChats() { return this.services.chats.listChats(); }
  listChatsWithSteps() { return this.services.chats.listChatsWithSteps(); }
  searchChats(query: string) { return this.services.chats.searchChats(query); }
  deleteChat(chatId: string) { return this.services.chats.deleteChat(chatId); }
  cancelChat(chatId: string) { return this.services.chats.cancelChat(chatId); }

  // Runs a chat turn in a worker thread and records its output.
  respondToChatUserInput(chatId: string, requestId: string, answers: RunUserInputAnswers) {
    return this.services.chatWorkerHost.respondToChatUserInput(chatId, requestId, answers);
  }

  // Queues, steers and delivers follow-up messages.
  queueRunFollowUp(runId: string, prompt: string, options?: RunFollowUpOptions, delivery: FollowUpDelivery = "queue") {
    return this.services.followUps.queueRunFollowUp(runId, prompt, options, delivery);
  }
  updateRunFollowUpQueue(runId: string, action: FollowUpQueueAction) { return this.services.followUps.updateRunFollowUpQueue(runId, action); }
  queueChatFollowUp(chatId: string, prompt: string, options?: FollowUpChatOptions, delivery: FollowUpDelivery = "queue") {
    return this.services.followUps.queueChatFollowUp(chatId, prompt, options, delivery);
  }
  updateChatFollowUpQueue(chatId: string, action: FollowUpQueueAction) { return this.services.followUps.updateChatFollowUpQueue(chatId, action); }

  // Connects council validation rounds with runs, workspaces and workers.
  startCouncil(runId: string) { return this.services.council.startCouncil(runId); }
  getCouncilRounds(runId: string) { return this.services.council.getCouncilRounds(runId); }
  cancelCouncil(roundId: string) { return this.services.council.cancelCouncil(roundId); }
  applyCouncilFindings(roundId: string, groupIds: string[]) { return this.services.council.applyCouncilFindings(roundId, groupIds); }
  reconcileCouncilAfterRestart() { return this.services.council.reconcileCouncilAfterRestart(); }

  // Connects pull request watching with runs and their workspaces.
  getRunPrWatchCandidates(runId: string) { return this.services.prWatch.getRunPrWatchCandidates(runId); }
  setRunForgeLink(runId: string, prUrl: string | null) { return this.services.prWatch.setRunForgeLink(runId, prUrl); }
  startPrWatch(runId: string, input: StartPrWatchInput) { return this.services.prWatch.startPrWatch(runId, input); }
  stopPrWatch(runId: string) { return this.services.prWatch.stopPrWatch(runId); }
  resumePrWatch(runId: string) { return this.services.prWatch.resumePrWatch(runId); }
  getProjectPrWatchInstructions(projectId: string) { return this.services.prWatch.getProjectPrWatchInstructions(projectId); }
  saveProjectPrWatchInstructions(projectId: string, instructions: string) {
    return this.services.prWatch.saveProjectPrWatchInstructions(projectId, instructions);
  }

  // Runs Project Lab proposals and implementations.
  runProjectLab(input: RunProjectLabInput) { return this.services.projectLab.runProjectLab(input); }
  deleteProjectLabThread(threadId: string) { return this.services.projectLab.deleteProjectLabThread(threadId); }
  getProjectLabThreadDetail(threadId: string) { return this.services.projectLab.getProjectLabThreadDetail(threadId); }

  // Starts and controls project loops.
  onProjectLoopChanged(listener: (payload: ProjectLoopChangedPayload) => void) { return this.services.projectLoops.onProjectLoopChanged(listener); }
  resumeActiveProjectLoops() { return this.services.projectLoops.resumeActiveProjectLoops(); }
  createProjectLoop(input: CreateProjectLoopInput) { return this.services.projectLoops.createProjectLoop(input); }
  getProjectLoopDetail(loopId: string) { return this.services.projectLoops.getProjectLoopDetail(loopId); }
  cancelProjectLoop(loopId: string) { return this.services.projectLoops.cancelProjectLoop(loopId); }
  resumeProjectLoop(loopId: string) { return this.services.projectLoops.resumeProjectLoop(loopId); }
  deleteProjectLoop(loopId: string) { return this.services.projectLoops.deleteProjectLoop(loopId); }
  respondToProjectLoopUiReview(reviewId: string, input: ProjectLoopUiReviewDecisionInput) {
    return this.services.projectLoops.respondToProjectLoopUiReview(reviewId, input);
  }
  getProjectLoopUiReviewImage(reviewId: string) { return this.services.projectLoops.getProjectLoopUiReviewImage(reviewId); }
  getProjectLoopAvailability(projectId: string) { return this.services.projectLoops.getProjectLoopAvailability(projectId); }

  // Generates project insights and activity reports.
  getProjectInsights(projectId: string) { return this.services.projectInsights.getProjectInsights(projectId); }
  queryProjectActivity(input: ProjectActivityQueryInput) { return this.services.projectInsights.queryProjectActivity(input); }
  generateProjectInsight(input: GenerateProjectInsightInput) { return this.services.projectInsights.generateProjectInsight(input); }

  // Drafts and opens pull and merge requests for runs.
  getRunPublishOptions(runId: string) { return this.services.runPullRequests.getRunPublishOptions(runId); }
  createRunPullRequest(runId: string, targetBranch: string, title: string, sourceBranchName?: string, description?: string, commitMessage?: string) {
    return this.services.runPullRequests.createRunPullRequest(runId, targetBranch, title, sourceBranchName, description, commitMessage);
  }
  suggestRunPullRequestDraft(runId: string, targetBranch: string) { return this.services.runPullRequests.suggestRunPullRequestDraft(runId, targetBranch); }
  suggestRunPullRequestDescription(runId: string, targetBranch: string, title: string) {
    return this.services.runPullRequests.suggestRunPullRequestDescription(runId, targetBranch, title);
  }

  // Commits, publishes, checks out and releases run branches.
  activateRun(runId: string) { return this.services.runBranches.activateRun(runId); }
  commitRun(runId: string, message: string) { return this.services.runBranches.commitRun(runId, message); }
  suggestCommitMessage(runId: string) { return this.services.runBranches.suggestCommitMessage(runId); }
  publishRunBranch(runId: string, branchName?: string) { return this.services.runBranches.publishRunBranch(runId, branchName); }
  createRunLocalBranch(runId: string, branchName: string) { return this.services.runBranches.createRunLocalBranch(runId, branchName); }
  suggestRunBranchName(runId: string) { return this.services.runBranches.suggestRunBranchName(runId); }
  releaseRun(runId: string) { return this.services.runBranches.releaseRun(runId); }

  // Deletes runs, their workspaces and data that is past its retention.
  getRunDeletionImpact(runId: string) { return this.services.runDeletion.getRunDeletionImpact(runId); }
  getDataRetentionCleanupImpact(dayCount: number) { return this.services.runDeletion.getDataRetentionCleanupImpact(dayCount); }
  deleteDataRetentionCandidates(dayCount: number, cutoffAt: string) { return this.services.runDeletion.deleteDataRetentionCandidates(dayCount, cutoffAt); }
  deleteRun(runId: string, options: { preserveBranch?: boolean } = {}) { return this.services.runDeletion.deleteRun(runId, options); }

  // Resumes interrupted runs and rewinds runs to earlier prompts.
  reconcileOrphanedActiveSessions() { return this.services.runRecovery.reconcileOrphanedActiveSessions(); }
  resumeRunFromCheckpoint(runId: string) { return this.services.runRecovery.resumeRunFromCheckpoint(runId); }
  recoverInterruptedRun(runId: string) { return this.services.runRecovery.recoverInterruptedRun(runId); }
  getRunRewindHistory(runId: string) { return this.services.runRecovery.getRunRewindHistory(runId); }
  rewindRun(input: RunRewindInput) { return this.services.runRecovery.rewindRun(input); }
  forkRun(input: RunForkInput) { return this.services.runForks.forkRun(input); }
  undoRunToLastPrompt(runId: string) { return this.services.runRecovery.undoRunToLastPrompt(runId); }

  // Owns orchestration records, their settings and their overall status.
  onOrchestrationChanged(listener: (payload: OrchestrationChangedPayload) => void) { return this.services.orchestration.onOrchestrationChanged(listener); }
  getOrchestrationDetail(coordinatorRunId: string) { return this.services.orchestration.getOrchestrationDetail(coordinatorRunId); }
  getOrchestrationTaskDetail(taskId: string) { return this.services.orchestration.getOrchestrationTaskDetail(taskId); }
  pauseOrchestration(coordinatorRunId: string) { return this.services.orchestration.pauseOrchestration(coordinatorRunId); }
  resumeOrchestration(coordinatorRunId: string) { return this.services.orchestration.resumeOrchestration(coordinatorRunId); }
  cancelOrchestration(coordinatorRunId: string) { return this.services.orchestration.cancelOrchestration(coordinatorRunId); }
  finishOrchestration(coordinatorRunId: string) { return this.services.orchestration.finishOrchestration(coordinatorRunId); }
  refreshOrchestrationTeam(coordinatorRunId: string) { return this.services.orchestration.refreshOrchestrationTeam(coordinatorRunId); }

  // Accepts delegated tasks and starts, defers and retries their child runs.
  retryOrchestrationTask(taskId: string) { return this.services.orchestrationDispatch.retryOrchestrationTask(taskId); }

  // Delivers messages from coordinators and users to child runs.
  sendOrchestrationTaskMessage(input: OrchestrationTaskMessageInput) { return this.services.orchestrationMessages.sendOrchestrationTaskMessage(input); }

  // Previews and applies the changes of isolated child workspaces.
  getOrchestrationAdoptionPreview(taskId: string) { return this.services.orchestrationAdoption.getOrchestrationAdoptionPreview(taskId); }
  decideOrchestrationAdoption(input: OrchestrationAdoptionDecisionInput) { return this.services.orchestrationAdoption.decideOrchestrationAdoption(input); }

  // Reconciles orchestrations after a restart and deletes them completely.
  reconcileOrchestrationsAfterRestart() { return this.services.orchestrationRecovery.reconcileOrchestrationsAfterRestart(); }

  // Creates and continues runs and prepares their workspaces.
  createRun(input: RunInput) { return this.services.runLifecycle.createRun(input); }
  continueRun(input: ContinueRunInput) { return this.services.runLifecycle.continueRun(input); }

  // Starts follow-up turns on existing runs and cancels active ones.
  followUpRun(runId: string, prompt: string, options?: RunFollowUpOptions, extraLogMetadata?: Record<string, unknown>) {
    return this.services.runTurns.followUpRun(runId, prompt, options, extraLogMetadata);
  }
  cancelRun(runId: string) { return this.services.runTurns.cancelRun(runId); }

  // Handles approval and question requests of run workers.
  cancelRunShell(runId: string, toolCallId: string) { return this.services.runInteractions.cancelRunShell(runId, toolCallId); }
  respondToShellApproval(runId: string, requestId: string, requestedDecision: ShellApprovalDecision, options?: ShellApprovalRespondOptions) {
    return this.services.runInteractions.respondToShellApproval(runId, requestId, requestedDecision, options);
  }
  respondToRunUserInput(runId: string, requestId: string, answers: RunUserInputAnswers, answeredBy: "user" | "coordinator" = "user") {
    return this.services.runInteractions.respondToRunUserInput(runId, requestId, answers, answeredBy);
  }
}
