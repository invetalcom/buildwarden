import type { AppController } from "./app-controller";

type StartupController = Pick<
  AppController,
  | "migrateProjectBaseBranches"
  | "reconcileOrphanedActiveSessions"
  | "reconcileOrchestrationsAfterRestart"
  | "startHistorySearchBackfill"
  | "reconcileCouncilAfterRestart"
  | "resumeActiveProjectLoops"
>;

type StartupLog = (message: string, metadata: Record<string, unknown>) => void;

/**
 * Brings state left by the previous session up to date. Each step runs on its own, so one that
 * fails does not skip the others. Orchestrations, council rounds and loops read run statuses, so
 * they wait for interrupted runs to be marked terminal: resuming a loop before that could leave its
 * runner waiting forever on a "running" iteration run that has no worker.
 */
export const reconcileStartupState = async (controller: StartupController, logError: StartupLog): Promise<void> => {
  const step = async (failure: string, action: () => Promise<void> | void): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      logError(failure, { error });
      return false;
    }
  };

  await step("Failed to migrate project base branches during startup.", () => controller.migrateProjectBaseBranches());
  const runsReconciled = await step(
    "Failed to reconcile interrupted runs and chats during startup; orchestrations, council rounds and active loops were not resumed.",
    () => controller.reconcileOrphanedActiveSessions(),
  );
  if (runsReconciled) {
    await step("Failed to reconcile orchestrations during startup.", () => controller.reconcileOrchestrationsAfterRestart());
  }
  await step("Failed to start the history search backfill during startup.", () => controller.startHistorySearchBackfill());
  if (!runsReconciled) return;
  await step("Failed to reconcile council rounds during startup.", () => controller.reconcileCouncilAfterRestart());
  await step("Failed to resume active loops during startup.", () => controller.resumeActiveProjectLoops());
};
