import type { BrowserWindow, IpcMain, WebContents } from "electron";
import { IPC_CHANNELS, StreamedStepEventEncoder } from "@buildwarden/shared";
import type { HostEventBus, HostEventMap } from "./host-events";

const IPC_EVENT_CHANNELS = {
  runOrganization: IPC_CHANNELS.runOrganizationChanged,
  run: IPC_CHANNELS.runEvent,
  chat: IPC_CHANNELS.chatEvent,
  warning: IPC_CHANNELS.appWarning,
  automationStarted: IPC_CHANNELS.automationStarted,
  loop: IPC_CHANNELS.projectLoopChanged,
  task: IPC_CHANNELS.projectTaskChanged,
  orchestration: IPC_CHANNELS.orchestrationChanged,
  forge: IPC_CHANNELS.runForgeRequestChanged,
  forgeRequestOpen: IPC_CHANNELS.projectForgeRequestOpen,
  forgeRequestNotification: IPC_CHANNELS.projectForgeRequestNotification,
  appMenuCommand: IPC_CHANNELS.appMenuCommand,
  appSettingsChanged: IPC_CHANNELS.appSettingsChanged,
  providerCliUpdates: IPC_CHANNELS.providerCliUpdatesChanged,
  ownedProcesses: IPC_CHANNELS.ownedProcessesChanged,
} as const satisfies Record<keyof HostEventMap, string>;

export type StreamedStepKind = "run" | "chat";

export interface HostEventIpcOptions {
  ipcMain: Pick<IpcMain, "on" | "removeListener">;
  /** Current persisted text of a step, for a preload that cannot apply a delta. */
  resolveStepContent: (kind: StreamedStepKind, stepId: string) => string | null;
}

/**
 * Makes Electron IPC a subscriber rather than the owner of host events.
 * Run and chat step events cross IPC in the compact streamed-step encoding; the
 * preload decodes them, so renderer listeners still receive whole events.
 */
export const registerHostEventIpc = (
  events: HostEventBus,
  getWindow: () => BrowserWindow | null,
  options: HostEventIpcOptions,
): (() => void) => {
  const encoders: Record<StreamedStepKind, StreamedStepEventEncoder> = {
    run: new StreamedStepEventEncoder(),
    chat: new StreamedStepEventEncoder(),
  };
  const resetEncoders = () => Object.values(encoders).forEach((encoder) => encoder.reset());
  // A new renderer document starts with an empty decoder.
  let trackedWebContents: WebContents | null = null;
  const track = (webContents: WebContents) => {
    if (trackedWebContents === webContents) return;
    trackedWebContents = webContents;
    resetEncoders();
    webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) resetEncoders();
    });
    webContents.on("render-process-gone", resetEncoders);
  };

  const disposers = (Object.keys(IPC_EVENT_CHANNELS) as (keyof HostEventMap)[]).map((type) =>
    events.subscribe(type, (payload) => {
      const webContents = getWindow()?.webContents;
      if (!webContents || webContents.isDestroyed()) {
        return;
      }
      if (payload === undefined) {
        webContents.send(IPC_EVENT_CHANNELS[type]);
      } else if (type === "run" || type === "chat") {
        track(webContents);
        webContents.send(IPC_EVENT_CHANNELS[type], encoders[type].encode(payload as HostEventMap[typeof type]));
      } else {
        webContents.send(IPC_EVENT_CHANNELS[type], payload);
      }
    }),
  );

  const resolveStreamedStepContent = (event: Electron.IpcMainEvent, kind: unknown, stepId: unknown) => {
    if ((kind !== "run" && kind !== "chat") || typeof stepId !== "string") {
      event.returnValue = null;
      return;
    }
    // Later updates of this step are sent whole until the decoder holds its text again.
    encoders[kind].forget(stepId);
    try {
      event.returnValue = options.resolveStepContent(kind, stepId);
    } catch {
      event.returnValue = null;
    }
  };
  options.ipcMain.on(IPC_CHANNELS.resolveStreamedStepContent, resolveStreamedStepContent);

  return () => {
    disposers.forEach((dispose) => dispose());
    options.ipcMain.removeListener(IPC_CHANNELS.resolveStreamedStepContent, resolveStreamedStepContent);
  };
};
