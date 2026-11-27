import type { AppServiceContext } from "./app-service";
import type { AppServices } from "./app-services";
import { RunEventLog } from "./run-event-log";
import { RunEndedNotifier } from "./run-ended-notifier";
import { ActiveWorkers } from "./active-workers";
import { WorkspaceGuard } from "./workspace-guard";
import { TurnStateStore } from "./turn-state-store";
import { AppStateService } from "./app-state-service";
import { SettingsService } from "./settings-service";
import { ForgeRequestService } from "./forge-request-service";
import { RunForgeService } from "./run-forge-service";
import { ForgeIssueActions } from "./forge-issue-actions";
import { DiffReviewService } from "./diff-review-service";
import { ProjectService } from "./project-service";
import { ProviderAccountService } from "./provider-account-service";
import { ProviderRuntimeService } from "./provider-runtime-service";
import { UsageService } from "./usage-service";
import { ModelTextService } from "./model-text-service";
import { TitleService } from "./title-service";
import { AutomationService } from "./automation-service";
import { ProjectTaskService } from "./project-task-service";
import { OrganizationService } from "./organization-service";
import { VerificationService } from "./verification-service";
import { SessionSkillService } from "./session-skill-service";
import { SystemService } from "./system-service";
import { OwnedProcessService } from "./owned-process-service";
import { RunDetailService } from "./run-detail-service";
import { ChatService } from "./chat-service";
import { ChatWorkerHost } from "./chat-worker-host";
import { FollowUpQueueService } from "./follow-up-queue-service";
import { CouncilRunService } from "./council-run-service";
import { RunPrWatchService } from "./run-pr-watch-service";
import { ProjectLabService } from "./project-lab-service";
import { ProjectLabPrompts } from "./project-lab-prompts";
import { ProjectLoopService } from "./project-loop-service";
import { ProjectInsightService } from "./project-insight-service";
import { RunPullRequestService } from "./run-pull-request-service";
import { RunBranchService } from "./run-branch-service";
import { RunDeletionService } from "./run-deletion-service";
import { RunRecoveryService } from "./run-recovery-service";
import { RunForkService } from "./run-fork-service";
import { AcpSessionService } from "./acp-session-service";
import { VisualReplyService } from "./visual-reply-service";
import { OrchestrationService } from "./orchestration-service";
import { OrchestrationDispatchService } from "./orchestration-dispatch-service";
import { OrchestrationResultService } from "./orchestration-result-service";
import { OrchestrationCoordinatorService } from "./orchestration-coordinator-service";
import { OrchestrationToolService } from "./orchestration-tool-service";
import { OrchestrationMessageService } from "./orchestration-message-service";
import { OrchestrationAdoptionService } from "./orchestration-adoption-service";
import { OrchestrationRecoveryService } from "./orchestration-recovery-service";
import { RunLifecycleService } from "./run-lifecycle-service";
import { RunTurnService } from "./run-turn-service";
import { RunWorkerHost } from "./run-worker-host";
import { RunWorkerOutput } from "./run-worker-output";
import { RunInteractionService } from "./run-interaction-service";

export const createAppServices = (context: AppServiceContext): AppServices => {
  // Services look each other up through this object, so it is shared before it is complete.
  const services = {} as AppServices;
  Object.assign(services, {
    runEvents: new RunEventLog(context, services),
    runEnded: new RunEndedNotifier(context, services),
    activeWorkers: new ActiveWorkers(context, services),
    workspaceGuard: new WorkspaceGuard(context, services),
    turnState: new TurnStateStore(context, services),
    appState: new AppStateService(context, services),
    settings: new SettingsService(context, services),
    forgeRequests: new ForgeRequestService(context, services),
    runForge: new RunForgeService(context, services),
    forgeIssueActions: new ForgeIssueActions(context, services),
    diffReview: new DiffReviewService(context, services),
    projects: new ProjectService(context, services),
    providerAccounts: new ProviderAccountService(context, services),
    providerRuntime: new ProviderRuntimeService(context, services),
    usage: new UsageService(context, services),
    modelText: new ModelTextService(context, services),
    titles: new TitleService(context, services),
    automations: new AutomationService(context, services),
    tasks: new ProjectTaskService(context, services),
    organization: new OrganizationService(context, services),
    verification: new VerificationService(context, services),
    skills: new SessionSkillService(context, services),
    system: new SystemService(context, services),
    processes: new OwnedProcessService(context, services),
    runDetails: new RunDetailService(context, services),
    chats: new ChatService(context, services),
    chatWorkerHost: new ChatWorkerHost(context, services),
    followUps: new FollowUpQueueService(context, services),
    council: new CouncilRunService(context, services),
    prWatch: new RunPrWatchService(context, services),
    projectLab: new ProjectLabService(context, services),
    projectLabPrompts: new ProjectLabPrompts(context, services),
    projectLoops: new ProjectLoopService(context, services),
    projectInsights: new ProjectInsightService(context, services),
    runPullRequests: new RunPullRequestService(context, services),
    runBranches: new RunBranchService(context, services),
    runDeletion: new RunDeletionService(context, services),
    runRecovery: new RunRecoveryService(context, services),
    runForks: new RunForkService(context, services),
    acpSessions: new AcpSessionService(context, services),
    visualReplies: new VisualReplyService(context, services),
    orchestration: new OrchestrationService(context, services),
    orchestrationDispatch: new OrchestrationDispatchService(context, services),
    orchestrationResults: new OrchestrationResultService(context, services),
    orchestrationCoordinator: new OrchestrationCoordinatorService(context, services),
    orchestrationTools: new OrchestrationToolService(context, services),
    orchestrationMessages: new OrchestrationMessageService(context, services),
    orchestrationAdoption: new OrchestrationAdoptionService(context, services),
    orchestrationRecovery: new OrchestrationRecoveryService(context, services),
    runLifecycle: new RunLifecycleService(context, services),
    runTurns: new RunTurnService(context, services),
    runWorkerHost: new RunWorkerHost(context, services),
    runWorkerOutput: new RunWorkerOutput(context, services),
    runInteractions: new RunInteractionService(context, services),
  } satisfies AppServices);
  // Results are settled before validation and PR watches may start the next turn.
  services.runEnded.setListeners([
    ["runForge", services.runForge],
    ["projectLab", services.projectLab],
    ["projectLoops", services.projectLoops],
    ["orchestrationResults", services.orchestrationResults],
    ["orchestrationCoordinator", services.orchestrationCoordinator],
    ["council", services.council],
    ["prWatch", services.prWatch],
  ]);
  return services;
};
