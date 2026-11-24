import type { AppController } from "../app-controller";
import type { RunEventLog } from "./run-event-log";
import type { ActiveWorkers } from "./active-workers";
import type { WorkspaceGuard } from "./workspace-guard";
import type { TurnStateStore } from "./turn-state-store";
import type { AppStateService } from "./app-state-service";
import type { SettingsService } from "./settings-service";
import type { ForgeRequestService } from "./forge-request-service";
import type { RunForgeService } from "./run-forge-service";
import type { ForgeIssueActions } from "./forge-issue-actions";
import type { DiffReviewService } from "./diff-review-service";
import type { ProjectService } from "./project-service";
import type { ProviderAccountService } from "./provider-account-service";
import type { ProviderRuntimeService } from "./provider-runtime-service";
import type { UsageService } from "./usage-service";
import type { ModelTextService } from "./model-text-service";
import type { TitleService } from "./title-service";
import type { AutomationService } from "./automation-service";
import type { ProjectTaskService } from "./project-task-service";
import type { OrganizationService } from "./organization-service";
import type { VerificationService } from "./verification-service";
import type { SessionSkillService } from "./session-skill-service";
import type { SystemService } from "./system-service";
import type { OwnedProcessService } from "./owned-process-service";
import type { RunDetailService } from "./run-detail-service";

/** The services behind `AppController`, by the name other services use for them. */
export interface AppServices {
  /** What has not been moved to a service yet. */
  controller: AppController;
  runEvents: RunEventLog;
  activeWorkers: ActiveWorkers;
  workspaceGuard: WorkspaceGuard;
  turnState: TurnStateStore;
  appState: AppStateService;
  settings: SettingsService;
  forgeRequests: ForgeRequestService;
  runForge: RunForgeService;
  forgeIssueActions: ForgeIssueActions;
  diffReview: DiffReviewService;
  projects: ProjectService;
  providerAccounts: ProviderAccountService;
  providerRuntime: ProviderRuntimeService;
  usage: UsageService;
  modelText: ModelTextService;
  titles: TitleService;
  automations: AutomationService;
  tasks: ProjectTaskService;
  organization: OrganizationService;
  verification: VerificationService;
  skills: SessionSkillService;
  system: SystemService;
  processes: OwnedProcessService;
  runDetails: RunDetailService;
}
