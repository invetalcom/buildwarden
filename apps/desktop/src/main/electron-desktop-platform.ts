import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  Notification,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import type { AppMenuSection, OpenPathInFileManagerResult } from "@buildwarden/shared";
import type {
  DesktopMenuOptions,
  DesktopPlatformServices,
  ExternalUrlOpenResult,
  ProjectForgeDesktopNotification,
} from "./desktop-platform-services";
import { logError, logInfo, logWarn } from "./logger";

export const isSafeExternalUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
};

export const isAppNavigationUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol === "file:") {
      return true;
    }
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    return Boolean(rendererUrl && url.origin === new URL(rendererUrl).origin);
  } catch {
    return false;
  }
};

const ideExecutableDialogFilters = (platform: NodeJS.Platform): { name: string; extensions: string[] }[] => {
  if (platform === "win32") {
    return [
      { name: "Executable", extensions: ["exe", "bat", "cmd"] },
      { name: "All files", extensions: ["*"] },
    ];
  }
  if (platform === "darwin") {
    return [
      { name: "Application", extensions: ["app"] },
      { name: "All files", extensions: ["*"] },
    ];
  }
  return [{ name: "All files", extensions: ["*"] }];
};

const escapeToastXmlText = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

type AppMenuDefinition = {
  id: AppMenuSection;
  label: string;
  submenu: MenuItemConstructorOptions[];
};

export class ElectronDesktopPlatformServices implements DesktopPlatformServices {
  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly focusMainWindow: () => void,
  ) {}

  async pickProjectDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: "Choose a project folder",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async pickIdeExecutable(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: "Select IDE executable",
      properties: ["openFile", "dontAddToRecent"],
      filters: ideExecutableDialogFilters(process.platform),
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async openPathInFileManager(dirPath: string): Promise<OpenPathInFileManagerResult> {
    const trimmed = dirPath?.trim() ?? "";
    if (!trimmed) {
      logWarn("Rejected empty file-manager open request.");
      return { ok: false, error: "Path is empty." };
    }
    try {
      if (!existsSync(trimmed)) {
        return { ok: false, error: "Path does not exist." };
      }
      if (!statSync(trimmed).isDirectory()) {
        return { ok: false, error: "Path is not a directory." };
      }
    } catch (error) {
      logError("Failed to inspect path before opening file manager.", { dirPath: trimmed, error });
      return { ok: false, error: error instanceof Error ? error.message : "Could not read path." };
    }
    const error = await shell.openPath(trimmed);
    if (error) {
      logWarn("shell.openPath returned an error.", { dirPath: trimmed, error });
      return { ok: false, error };
    }
    logInfo("Opened path in file manager.", { dirPath: trimmed });
    return { ok: true };
  }

  async openExternalUrl(url: string): Promise<ExternalUrlOpenResult> {
    if (typeof url !== "string" || !isSafeExternalUrl(url)) {
      logWarn("Blocked attempt to open unsupported external URL.", { url });
      return { ok: false, error: "Unsupported or invalid URL." };
    }
    try {
      await shell.openExternal(url);
      logInfo("Opened external URL.", { url });
      return { ok: true };
    } catch (error) {
      logError("Failed to open external URL.", { url, error });
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  launchIdeWithFolder(executablePath: string, folderPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform === "darwin" && executablePath.endsWith(".app")) {
        const child = spawn("/usr/bin/open", ["-a", executablePath, folderPath], { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.unref();
        resolve();
        return;
      }

      const child = spawn(executablePath, [folderPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", (error) => {
        reject(new Error(`Could not start the IDE executable. Check the path in Settings (${error.message}).`));
      });
      child.unref();
      resolve();
    });
  }

  openSystemTerminalAtPath(dirPath: string): ExternalUrlOpenResult {
    const trimmed = dirPath?.trim() ?? "";
    try {
      if (!trimmed || !existsSync(trimmed) || !statSync(trimmed).isDirectory()) {
        return { ok: false, error: "Invalid or missing directory." };
      }
      if (process.platform === "win32") {
        const configured = process.env.ComSpec;
        const commandProcessor = configured && isAbsolute(configured) && existsSync(configured)
          ? configured
          : "C:\\Windows\\System32\\cmd.exe";
        spawn(commandProcessor, ["/c", "start", "", commandProcessor, "/k"], {
          cwd: trimmed,
          detached: true,
          stdio: "ignore",
          windowsHide: false,
        }).unref();
      } else if (process.platform === "darwin") {
        spawn("/usr/bin/open", ["-a", "Terminal", "."], { cwd: trimmed, detached: true, stdio: "ignore" }).unref();
      } else {
        const executable = ["/usr/bin/x-terminal-emulator", "/bin/x-terminal-emulator"].find(existsSync);
        if (!executable) {
          return { ok: false, error: "No supported system terminal executable was found." };
        }
        spawn(executable, [], { cwd: trimmed, detached: true, stdio: "ignore" }).unref();
      }
      return { ok: true };
    } catch (error) {
      logError("Failed to open system terminal.", { dirPath: trimmed, error });
      return { ok: false, error: error instanceof Error ? error.message : "Could not open system terminal." };
    }
  }

  installApplicationMenu(options: DesktopMenuOptions): void {
    Menu.setApplicationMenu(this.buildApplicationMenu(options));
  }

  popupApplicationMenu(options: DesktopMenuOptions, sectionId: AppMenuSection, x: number, y: number): void {
    const window = this.getMainWindow();
    const section = this.buildMenuDefinitions(options).find((entry) => entry.id === sectionId);
    if (!window || !section) {
      return;
    }
    Menu.buildFromTemplate(section.submenu).popup({ window, x, y });
  }

  showShellApprovalNotification(event: import("@buildwarden/shared").RunEvent): void {
    const command = event.content.replace(/\s+/g, " ").trim();
    this.showNotification("Shell approval needed", command || "An agent run is waiting for a command decision.");
  }

  showRunUserInputNotification(event: import("@buildwarden/shared").RunEvent): void {
    const detail = event.content.replace(/\s+/g, " ").trim();
    this.showNotification("Agent feedback needed", detail || "An agent run is waiting for your input before it can continue.");
  }

  showProjectForgeRequestNotification(input: ProjectForgeDesktopNotification): void {
    if (!Notification.isSupported()) {
      return;
    }
    const { payload } = input;
    const title = `New ${payload.providerLabel}: ${payload.projectName}`;
    const byline = payload.author ? ` by ${payload.author}` : "";
    const body = `${payload.title}${byline}\n${payload.repoLabel}`;
    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      input.onOpen();
    };
    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(process.platform === "darwin"
        ? { actions: [{ type: "button" as const, text: "Open project and PR" }], closeButtonText: "Dismiss" }
        : {}),
      ...(process.platform === "win32"
        ? {
            toastXml: [
              "<toast>",
              '<visual><binding template="ToastGeneric">',
              `<text>${escapeToastXmlText(title)}</text>`,
              `<text>${escapeToastXmlText(body)}</text>`,
              "</binding></visual>",
              "<actions>",
              '<action content="Open project and PR" arguments="open" activationType="foreground"/>',
              "</actions>",
              "</toast>",
            ].join(""),
          }
        : {}),
    });
    notification.on("click", openOnce);
    notification.on("action", openOnce);
    notification.show();
  }

  async showErrorDialog(title: string, message: string, detail?: string): Promise<void> {
    await dialog.showMessageBox({ type: "error", title, message, detail, noLink: true });
  }

  private showNotification(title: string, rawBody: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    const body = rawBody.length > 140 ? `${rawBody.slice(0, 137)}...` : rawBody;
    const notification = new Notification({ title, body, silent: false });
    notification.on("click", this.focusMainWindow);
    notification.show();
  }

  private buildMenuDefinitions(options: DesktopMenuOptions): AppMenuDefinition[] {
    const send = options.onCommand;
    return [
      {
        id: "file",
        label: "File",
        submenu: [
          { label: "Home", click: () => send("go-home") },
          { label: "New Agent Run", accelerator: "CmdOrCtrl+T", click: () => send("new-agent-run") },
          { label: "New Chat", accelerator: "CmdOrCtrl+Shift+T", click: () => send("new-chat") },
          { type: "separator" },
          { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => send("open-settings") },
          { type: "separator" },
          process.platform === "darwin"
            ? ({ role: "close" } as const satisfies MenuItemConstructorOptions)
            : ({ role: "quit" } as const satisfies MenuItemConstructorOptions),
        ],
      },
      {
        id: "edit",
        label: "Edit",
        submenu: [
          { role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" },
          { role: "paste" }, { role: "selectAll" },
        ],
      },
      {
        id: "view",
        label: "View",
        submenu: [
          { label: "Dark", type: "radio", checked: options.theme === "dark", click: () => options.onThemeChange("dark") },
          { label: "Light", type: "radio", checked: options.theme === "light", click: () => options.onThemeChange("light") },
          { type: "separator" },
          {
            label: "Toggle appearance",
            accelerator: process.platform === "darwin" ? "Cmd+Shift+L" : "Ctrl+Shift+L",
            click: () => send("toggle-dark-mode"),
          },
          { type: "separator" }, { role: "reload" }, { role: "forceReload" }, { type: "separator" },
          { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
          { role: "togglefullscreen" }, { role: "toggleDevTools" },
        ],
      },
      {
        id: "window",
        label: "Window",
        submenu: [
          { role: "minimize" }, { role: "zoom" },
          ...(process.platform === "darwin"
            ? ([{ type: "separator" }, { role: "front" }] as const satisfies readonly MenuItemConstructorOptions[])
            : ([{ role: "close" }] as const satisfies readonly MenuItemConstructorOptions[])),
        ],
      },
      {
        id: "help",
        label: "Help",
        submenu: [
          { label: "Open Log Folder", click: () => void this.openPathInFileManager(options.logDirPath) },
          { label: "Email Support", click: () => void this.openExternalUrl("mailto:ai-support@r-kellner.de") },
          { type: "separator" },
          {
            label: "About BuildWarden",
            click: () => void dialog.showMessageBox({
              type: "info",
              title: "About BuildWarden",
              message: "BuildWarden",
              detail: `Version ${app.getVersion()}\nDesktop coding-agent workflows in Electron.`,
              buttons: ["OK"],
            }),
          },
        ],
      },
    ];
  }

  private buildApplicationMenu(options: DesktopMenuOptions): Menu {
    const template: MenuItemConstructorOptions[] = this.buildMenuDefinitions(options).map(({ label, submenu }) => ({
      label,
      submenu,
    }));
    if (process.platform === "darwin") {
      template.unshift({
        label: app.name,
        submenu: [
          { role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" },
          { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
        ],
      });
    }
    return Menu.buildFromTemplate(template);
  }
}
