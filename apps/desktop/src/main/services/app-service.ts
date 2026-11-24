import { BuildWardenDatabase } from "@buildwarden/db";
import { GitService } from "@buildwarden/git-service";
import type { ProviderCliUpdateStatus, RunToolResult, SecretStore, ThemeToolName } from "@buildwarden/shared";
import type { AppControllerDesktopServices } from "../desktop-platform-services";
import { HostEventBus } from "../host-events";
import type { HostTerminal } from "../host-terminal-service";
import { logError, logWarn } from "../logger";
import type { AppServices } from "./app-services";

export type AppControllerLifecycle = {
  onAgentActivityChanged?: (active: boolean) => void;
  isAppVisible?: () => boolean;
  onRunDeleted?: (runId: string) => void;
  executeBrowserTool?: (runId: string, callId: string, args: Record<string, unknown>) => Promise<RunToolResult>;
  /** Reads or changes the app's own design on behalf of an agent. */
  executeThemeTool?: (callId: string, toolName: ThemeToolName, args: Record<string, unknown>) => RunToolResult;
  onRunBrowserActive?: (runId: string, active: boolean) => void;
  onProviderCliUpdateAvailable?: (status: ProviderCliUpdateStatus) => void;
};

/** Everything the services share: storage, secrets, Git, desktop access and event delivery. */
export class AppServiceContext {
  readonly gitService = new GitService();

  constructor(
    readonly db: BuildWardenDatabase,
    readonly secrets: SecretStore,
    readonly logDirPath: string,
    readonly desktop: AppControllerDesktopServices,
    readonly terminal: Pick<HostTerminal, "killForRunId">,
    readonly events: HostEventBus,
    readonly lifecycle: AppControllerLifecycle = {},
  ) {}

  logControllerError(message: string, error: unknown, metadata?: Record<string, unknown>) {
    logError(message, {
      ...(metadata ?? {}),
      error,
    });
  }

  logControllerWarn(message: string, metadata?: Record<string, unknown>) {
    logWarn(message, metadata);
  }
}

/**
 * Base of the services behind `AppController`. The type argument names the sibling services a
 * service may call. They are looked up when used, so services may depend on each other; do not call
 * them from a constructor or field initializer.
 */
export abstract class AppService<Dependencies extends keyof AppServices = never> {
  constructor(
    protected readonly context: AppServiceContext,
    protected readonly services: Pick<AppServices, Dependencies>,
  ) {}

  protected get db() { return this.context.db; }
  protected get secrets() { return this.context.secrets; }
  protected get logDirPath() { return this.context.logDirPath; }
  protected get desktop() { return this.context.desktop; }
  protected get terminal() { return this.context.terminal; }
  protected get events() { return this.context.events; }
  protected get lifecycle() { return this.context.lifecycle; }
  protected get gitService() { return this.context.gitService; }

  protected logControllerError(message: string, error: unknown, metadata?: Record<string, unknown>): void {
    this.context.logControllerError(message, error, metadata);
  }

  protected logControllerWarn(message: string, metadata?: Record<string, unknown>): void {
    this.context.logControllerWarn(message, metadata);
  }
}
