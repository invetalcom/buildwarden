import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APP_SETTING_KEYS,
  type AppLogDirectorySizeInfo,
  type AppPathsInfo,
  type DatabaseCompactResult,
  type DatabaseStorageInfo,
  IDE_KIND_LABELS,
  type OpenPathInFileManagerResult,
  parseIdePathConfig,
  type RendererLogPayload,
  type SupportedIdeKind,
} from "@buildwarden/shared";
import { AppService } from "./app-service";

const measureDirectoryEntry = (currentDir: string, entry: Dirent, pendingDirs: string[]): { bytes: number; files: number; unreadable: number } => {
  if (entry.isSymbolicLink()) return { bytes: 0, files: 0, unreadable: 0 };
  const entryPath = join(currentDir, entry.name);
  if (entry.isDirectory()) {
    pendingDirs.push(entryPath);
    return { bytes: 0, files: 0, unreadable: 0 };
  }
  if (!entry.isFile()) return { bytes: 0, files: 0, unreadable: 0 };
  try {
    return { bytes: lstatSync(entryPath).size, files: 1, unreadable: 0 };
  } catch {
    return { bytes: 0, files: 0, unreadable: 1 };
  }
};

/** Covers the app's data folder, database maintenance and opening folders outside the app. */
export class SystemService extends AppService<"activeWorkers"> {
  reportRendererLog(payload: RendererLogPayload): Promise<void> {
    const metadata = {
      source: payload.source,
      stack: payload.stack,
      ...(payload.metadata ? { rendererMetadata: payload.metadata } : {}),
    };
    if (payload.level === "warn") {
      this.logControllerWarn(payload.message, metadata);
    } else {
      this.logControllerError(payload.message, undefined, metadata);
    }
    return Promise.resolve();
  }

  async resetDatabase(): Promise<void> {
    await this.db.resetAndReinit();
  }

  getDatabaseStorageInfo(): Promise<DatabaseStorageInfo> {
    return Promise.resolve(this.db.getStorageInfo());
  }

  /**
   * VACUUM holds the write lock and runs on the main thread, so agent events would stall behind it
   * (or hit the busy timeout from another connection). Only compact while no agent is working.
   */
  compactDatabase(): Promise<DatabaseCompactResult> {
    if (this.services.activeWorkers.runWorkers.size > 0 || this.services.activeWorkers.chatWorkers.size > 0) {
      return Promise.reject(new Error("Wait for active runs and chats to finish before reclaiming database space."));
    }
    return Promise.resolve(this.db.compact());
  }

  async openPathInFileManager(dirPath: string): Promise<OpenPathInFileManagerResult> {
    return this.desktop.openPathInFileManager(dirPath);
  }

  async getAppPaths(): Promise<AppPathsInfo> {
    mkdirSync(this.logDirPath, { recursive: true });
    return {
      logDirPath: this.logDirPath,
      logDirectorySize: this.calculateDirectorySize(this.logDirPath),
    };
  }

  private calculateDirectorySize(dirPath: string): AppLogDirectorySizeInfo {
    let totalBytes = 0;
    let fileCount = 0;
    let unreadableEntryCount = 0;
    const pendingDirs = [dirPath];

    while (pendingDirs.length > 0) {
      const currentDir = pendingDirs.pop();
      if (!currentDir) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        unreadableEntryCount += 1;
        continue;
      }

      for (const entry of entries) {
        const measured = measureDirectoryEntry(currentDir, entry, pendingDirs);
        totalBytes += measured.bytes;
        fileCount += measured.files;
        unreadableEntryCount += measured.unreadable;
      }
    }

    return { totalBytes, fileCount, unreadableEntryCount };
  }

  async pickIdeExecutable(): Promise<string | null> {
    return this.desktop.pickIdeExecutable();
  }

  async openRunWorktreeInIde(runId: string, ideKind: SupportedIdeKind): Promise<void> {
    const run = this.db.getRun(runId);
    const folderPath = run.worktreePath?.trim() ?? "";
    if (!folderPath) {
      throw new Error("This run has no workspace path.");
    }
    await this.openFolderInIde(folderPath, ideKind);
  }

  async openFolderInIde(folderPath: string, ideKind: SupportedIdeKind): Promise<void> {
    const trimmedPath = folderPath.trim();
    if (!trimmedPath) {
      throw new Error("No folder path was provided.");
    }
    try {
      if (!existsSync(trimmedPath) || !statSync(trimmedPath).isDirectory()) {
        throw new Error("The folder is not available on disk.");
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Could not access the folder.");
    }

    const settings = this.db.getSettings();
    const raw = settings[APP_SETTING_KEYS.idePaths];
    const config = parseIdePathConfig(typeof raw === "string" ? raw : undefined);
    const exe = config[ideKind]?.trim();
    if (!exe) {
      throw new Error(`${IDE_KIND_LABELS[ideKind]} is not configured. Add its path in Settings > User Settings.`);
    }

    await this.desktop.launchIdeWithFolder(exe, trimmedPath);
  }
}
