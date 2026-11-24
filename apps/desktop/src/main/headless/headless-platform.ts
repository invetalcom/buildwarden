import type { AutomationStartedNotificationPayload, OpenPathInFileManagerResult, ProviderCliUpdateStatus, RunEvent } from "@buildwarden/shared";
import type { DesktopPlatformServices, ExternalUrlOpenResult, ProjectForgeDesktopNotification } from "../desktop-platform-services";
import { logError, logInfo } from "../logger";

const UNAVAILABLE = "This is not available on a headless BuildWarden host.";

/** Desktop integration for a host without a desktop. What would be a notification becomes a log line. */
export class HeadlessPlatformServices implements DesktopPlatformServices {
  async pickProjectDirectory(): Promise<string | null> {
    return null;
  }

  async pickIdeExecutable(): Promise<string | null> {
    return null;
  }

  async openPathInFileManager(): Promise<OpenPathInFileManagerResult> {
    return { ok: false, error: UNAVAILABLE };
  }

  async openExternalUrl(): Promise<ExternalUrlOpenResult> {
    return { ok: false, error: UNAVAILABLE };
  }

  async launchIdeWithFolder(): Promise<void> {
    throw new Error(UNAVAILABLE);
  }

  openSystemTerminalAtPath(): ExternalUrlOpenResult {
    return { ok: false, error: UNAVAILABLE };
  }

  installApplicationMenu(): void {
    // There is no menu bar.
  }

  popupApplicationMenu(): void {
    // There is no menu bar.
  }

  showShellApprovalNotification(event: RunEvent): void {
    logInfo("A run is waiting for a command decision.", { runId: event.runId });
  }

  showRunUserInputNotification(event: RunEvent): void {
    logInfo("A run is waiting for input.", { runId: event.runId });
  }

  showAutomationStartedNotification(payload: AutomationStartedNotificationPayload): void {
    logInfo("Automation started.", { automationName: payload.automationName, projectName: payload.projectName });
  }

  showProviderCliUpdateNotification(status: ProviderCliUpdateStatus): void {
    logInfo("A provider CLI update is available.", { provider: status.label, latestVersion: status.latestVersion });
  }

  showProjectForgeRequestNotification({ payload }: ProjectForgeDesktopNotification): void {
    logInfo("Git hosting activity.", { projectName: payload.projectName, title: payload.title, url: payload.prUrl });
  }

  async showErrorDialog(title: string, message: string, detail?: string): Promise<void> {
    logError(`${title}: ${message}`, detail ? { detail } : undefined);
  }
}
