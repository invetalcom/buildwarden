import type { BrowserWindow } from "electron";
import { IPC_CHANNELS } from "@buildwarden/shared";
import type { HostEventBus, HostEventMap } from "./host-events";

const IPC_EVENT_CHANNELS = {
  run: IPC_CHANNELS.runEvent,
  chat: IPC_CHANNELS.chatEvent,
  warning: IPC_CHANNELS.appWarning,
  loop: IPC_CHANNELS.projectLoopChanged,
  task: IPC_CHANNELS.projectTaskChanged,
  forgeRequestOpen: IPC_CHANNELS.projectForgeRequestOpen,
  forgeRequestNotification: IPC_CHANNELS.projectForgeRequestNotification,
  appMenuCommand: IPC_CHANNELS.appMenuCommand,
  appSettingsChanged: IPC_CHANNELS.appSettingsChanged,
} as const satisfies Record<keyof HostEventMap, string>;

/** Makes Electron IPC a subscriber rather than the owner of host events. */
export const registerHostEventIpc = (events: HostEventBus, getWindow: () => BrowserWindow | null): (() => void) => {
  const disposers = (Object.keys(IPC_EVENT_CHANNELS) as (keyof HostEventMap)[]).map((type) =>
    events.subscribe(type, (payload) => {
      const webContents = getWindow()?.webContents;
      if (!webContents || webContents.isDestroyed()) {
        return;
      }
      if (payload === undefined) {
        webContents.send(IPC_EVENT_CHANNELS[type]);
      } else {
        webContents.send(IPC_EVENT_CHANNELS[type], payload);
      }
    }),
  );
  return () => disposers.forEach((dispose) => dispose());
};
