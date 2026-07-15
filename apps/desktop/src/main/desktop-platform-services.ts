import type {
  AppMenuCommand,
  AppMenuSection,
  OpenPathInFileManagerResult,
  ProjectForgeRequestNotificationPayload,
  RunEvent,
  UiTheme,
} from "@buildwarden/shared";

export interface ExternalUrlOpenResult {
  ok: boolean;
  error?: string;
}

export interface DesktopMenuOptions {
  logDirPath: string;
  theme: UiTheme;
  onCommand: (command: AppMenuCommand) => void;
  onThemeChange: (theme: UiTheme) => void;
}

export interface ProjectForgeDesktopNotification {
  payload: ProjectForgeRequestNotificationPayload;
  onOpen: () => void;
}

/** Electron-only capabilities used by the otherwise transport-neutral host. */
export interface DesktopPlatformServices {
  pickProjectDirectory(): Promise<string | null>;
  pickIdeExecutable(): Promise<string | null>;
  openPathInFileManager(dirPath: string): Promise<OpenPathInFileManagerResult>;
  openExternalUrl(url: string): Promise<ExternalUrlOpenResult>;
  launchIdeWithFolder(executablePath: string, folderPath: string): Promise<void>;
  openSystemTerminalAtPath(dirPath: string): ExternalUrlOpenResult;
  installApplicationMenu(options: DesktopMenuOptions): void;
  popupApplicationMenu(options: DesktopMenuOptions, section: AppMenuSection, x: number, y: number): void;
  showShellApprovalNotification(event: RunEvent): void;
  showRunUserInputNotification(event: RunEvent): void;
  showProjectForgeRequestNotification(input: ProjectForgeDesktopNotification): void;
  showErrorDialog(title: string, message: string, detail?: string): Promise<void>;
}

export type AppControllerDesktopServices = Pick<
  DesktopPlatformServices,
  "pickProjectDirectory" | "pickIdeExecutable" | "openPathInFileManager" | "openExternalUrl" | "launchIdeWithFolder"
>;
