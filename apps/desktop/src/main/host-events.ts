import type {
  AppMenuCommand,
  AppWarning,
  ProjectForgeRequestNotificationPayload,
  ProjectForgeRequestOpenPayload,
  ProjectLoopChangedPayload,
  ProjectTaskChangedPayload,
  RunEvent,
} from "@buildwarden/shared";

export interface HostEventMap {
  run: RunEvent;
  chat: RunEvent & { chatId: string };
  warning: AppWarning;
  loop: ProjectLoopChangedPayload;
  task: ProjectTaskChangedPayload;
  forgeRequestOpen: ProjectForgeRequestOpenPayload;
  forgeRequestNotification: ProjectForgeRequestNotificationPayload;
  appMenuCommand: AppMenuCommand;
  appSettingsChanged: undefined;
}

type HostEventListener<K extends keyof HostEventMap> = (payload: HostEventMap[K]) => void;

/**
 * Process-local event fan-out shared by every host transport. Electron IPC is
 * the only subscriber today; the loopback WebSocket server can subscribe to
 * the same events without changing controller or worker code.
 */
export class HostEventBus {
  private readonly listeners = new Map<keyof HostEventMap, Set<(payload: never) => void>>();

  publish<K extends keyof HostEventMap>(type: K, payload: HostEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload as never);
    }
  }

  subscribe<K extends keyof HostEventMap>(type: K, listener: HostEventListener<K>): () => void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (payload: never) => void);
    return () => {
      listeners?.delete(listener as (payload: never) => void);
      if (listeners?.size === 0) {
        this.listeners.delete(type);
      }
    };
  }
}
