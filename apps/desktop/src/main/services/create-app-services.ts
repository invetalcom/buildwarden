import type { AppController } from "../app-controller";
import type { AppServiceContext } from "./app-service";
import type { AppServices } from "./app-services";
import { RunEventLog } from "./run-event-log";
import { ActiveWorkers } from "./active-workers";
import { WorkspaceGuard } from "./workspace-guard";
import { TurnStateStore } from "./turn-state-store";
import { AppStateService } from "./app-state-service";
import { SettingsService } from "./settings-service";

export const createAppServices = (context: AppServiceContext, controller: AppController): AppServices => {
  // Services look each other up through this object, so it is shared before it is complete.
  const services = {} as AppServices;
  return Object.assign(services, {
    controller,
    runEvents: new RunEventLog(context, services),
    activeWorkers: new ActiveWorkers(context, services),
    workspaceGuard: new WorkspaceGuard(context, services),
    turnState: new TurnStateStore(context, services),
    appState: new AppStateService(context, services),
    settings: new SettingsService(context, services),
  } satisfies AppServices);
};
