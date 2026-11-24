import type { AppController } from "../app-controller";
import type { RunEventLog } from "./run-event-log";
import type { ActiveWorkers } from "./active-workers";
import type { WorkspaceGuard } from "./workspace-guard";
import type { TurnStateStore } from "./turn-state-store";
import type { AppStateService } from "./app-state-service";
import type { SettingsService } from "./settings-service";

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
}
