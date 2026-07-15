import { ipcMain, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  type RunTerminalResizeInput,
  type RunTerminalStartInput,
  type RunTerminalStartResult,
  type RunTerminalWriteInput,
} from "@buildwarden/shared";
import type { DesktopPlatformServices } from "./desktop-platform-services";
import type { HostTerminal } from "./host-terminal-service";

/**
 * Thin Electron transport adapter. PTY ownership and event fan-out live in
 * HostTerminal so another subscriber (for example WebSocket) can use the same
 * host session without importing Electron.
 */
export const registerRunTerminalIpc = (
  terminal: HostTerminal,
  desktop: Pick<DesktopPlatformServices, "openSystemTerminalAtPath">,
): (() => void) => {
  const owners = new Map<string, WebContents>();
  const onDataDispose = terminal.onData(({ sessionId, data }) => {
    const owner = owners.get(sessionId);
    if (owner && !owner.isDestroyed()) {
      owner.send(IPC_CHANNELS.runTerminalData, { sessionId, data });
    }
  });
  const onExitDispose = terminal.onExit(({ sessionId, exitCode }) => {
    const owner = owners.get(sessionId);
    owners.delete(sessionId);
    if (owner && !owner.isDestroyed()) {
      owner.send(IPC_CHANNELS.runTerminalExit, { sessionId, exitCode });
    }
  });

  ipcMain.handle(IPC_CHANNELS.openSystemTerminalAtPath, (_, dirPath: string) => desktop.openSystemTerminalAtPath(dirPath));
  ipcMain.handle(IPC_CHANNELS.runTerminalStart, (event, input: RunTerminalStartInput): RunTerminalStartResult => {
    const result = terminal.start(input);
    if (result.ok) {
      owners.set(input.sessionId, event.sender);
    }
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.runTerminalWrite, (_event, input: RunTerminalWriteInput) => terminal.write(input));
  ipcMain.handle(IPC_CHANNELS.runTerminalResize, (_event, input: RunTerminalResizeInput) => terminal.resize(input));
  ipcMain.handle(IPC_CHANNELS.runTerminalKill, (_event, sessionId: string) => {
    owners.delete(sessionId);
    terminal.kill(sessionId);
  });

  return () => {
    onDataDispose();
    onExitDispose();
    owners.clear();
  };
};
