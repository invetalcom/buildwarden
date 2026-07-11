import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { ipcMain, type WebContents } from "electron";
import {
  IPC_CHANNELS,
  type RunTerminalResizeInput,
  type RunTerminalStartInput,
  type RunTerminalStartResult,
  type RunTerminalWriteInput,
} from "@buildwarden/shared";
import type { IPty } from "node-pty";
import { logError, logInfo, logWarn } from "./logger";

const require = createRequire(import.meta.url);

type PtySpawnFn = typeof import("node-pty").spawn;

let ptySpawn: PtySpawnFn | null = null;
try {
  const mod = require("node-pty") as { spawn: PtySpawnFn };
  ptySpawn = mod.spawn;
} catch {
  logWarn("node-pty is unavailable; embedded terminal support is disabled.");
  ptySpawn = null;
}

type RunTerminalSession = { proc: IPty; wc: WebContents; cwd: string };

const sessions = new Map<string, RunTerminalSession>();

/** Session id format must match the renderer (`RunWorktreeTerminal`). */
const runTerminalSessionIdForRun = (runId: string): string => `buildwarden-run-terminal:${runId}`;

export const killRunTerminalForRunId = (runId: string): void => {
  const sessionId = runTerminalSessionIdForRun(runId);
  const s = sessions.get(sessionId);
  if (!s) {
    return;
  }
  try {
    s.proc.kill();
  } catch {
    logWarn("Failed to kill run terminal while cleaning up a run.", { runId, sessionId });
    /* ignore */
  }
  sessions.delete(sessionId);
};

const isSafeTerminalCwd = (cwd: string): boolean => {
  if (!cwd || cwd.trim() === "" || cwd === "chat") {
    return false;
  }
  try {
    if (!existsSync(cwd)) {
      return false;
    }
    return lstatSync(cwd).isDirectory();
  } catch {
    logWarn("Failed to validate terminal cwd.", { cwd });
    return false;
  }
};

const defaultShell = (): { file: string; args: string[] } => {
  if (process.platform === "win32") {
    /** `cmd.exe /k` is more reliable in embedded ConPTY than PowerShell for some Windows builds. */
    const comspec = process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
    return { file: comspec, args: ["/k"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
};

export const disposeAllRunTerminals = (): void => {
  for (const [id, session] of sessions) {
    try {
      session.proc.kill();
    } catch {
      logWarn("Failed to kill a PTY during global terminal disposal.", { sessionId: id, cwd: session.cwd });
      /* ignore */
    }
    sessions.delete(id);
  }
};

const sendData = (wc: WebContents, sessionId: string, data: string) => {
  if (wc.isDestroyed()) {
    return;
  }
  wc.send(IPC_CHANNELS.runTerminalData, { sessionId, data });
};

const sendExit = (wc: WebContents, sessionId: string, exitCode: number) => {
  if (wc.isDestroyed()) {
    return;
  }
  wc.send(IPC_CHANNELS.runTerminalExit, { sessionId, exitCode });
};

const openSystemTerminalAtPathImpl = (dirPath: string): { ok: boolean; error?: string } => {
  if (!isSafeTerminalCwd(dirPath)) {
    return { ok: false, error: "Invalid or missing directory." };
  }
  try {
    if (process.platform === "win32") {
      const configuredCommandProcessor = process.env.ComSpec;
      const commandProcessor =
        configuredCommandProcessor && isAbsolute(configuredCommandProcessor) && existsSync(configuredCommandProcessor)
          ? configuredCommandProcessor
          : "C:\\Windows\\System32\\cmd.exe";
      spawn(commandProcessor, ["/c", "start", commandProcessor, "/k"], {
        cwd: dirPath,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("/usr/bin/open", ["-a", "Terminal", "."], { cwd: dirPath, detached: true, stdio: "ignore" }).unref();
    } else {
      const terminalExecutable = ["/usr/bin/x-terminal-emulator", "/bin/x-terminal-emulator"].find(existsSync);
      if (!terminalExecutable) {
        return { ok: false, error: "No supported system terminal executable was found." };
      }
      spawn(terminalExecutable, [], {
        cwd: dirPath,
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    return { ok: true };
  } catch (err) {
    logError("Failed to open system terminal.", { dirPath, error: err });
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Could not open system terminal.",
    };
  }
};

export const registerRunTerminalIpc = (): void => {
  ipcMain.handle(IPC_CHANNELS.openSystemTerminalAtPath, (_, dirPath: string) => openSystemTerminalAtPathImpl(dirPath));
  ipcMain.handle(IPC_CHANNELS.runTerminalStart, (event, input: RunTerminalStartInput): RunTerminalStartResult => {
    if (!ptySpawn) {
      return {
        ok: false,
        error:
          "Native terminal (node-pty) is not available. Allow its install script in pnpm (approve-builds) and rebuild, or reinstall dependencies.",
      };
    }

    const { sessionId, cwd } = input;
    if (!sessionId?.trim()) {
      return { ok: false, error: "Missing session id." };
    }
    const existing = sessions.get(sessionId);
    if (existing) {
      if (existing.cwd !== cwd) {
        try {
          existing.proc.kill();
        } catch {
          logWarn("Failed to recycle an existing terminal session before restart.", { sessionId, cwd });
          /* ignore */
        }
        sessions.delete(sessionId);
      } else {
        existing.wc = event.sender;
        return { ok: true, reused: true };
      }
    }
    if (!isSafeTerminalCwd(cwd)) {
      return { ok: false, error: "Worktree folder is not available for a terminal." };
    }

    const { file, args } = defaultShell();
    let proc: IPty;
    try {
      proc = ptySpawn(file, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
        encoding: "utf8",
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      });
    } catch (err) {
      logError("Failed to start PTY shell.", { sessionId, cwd, shellFile: file, shellArgs: args, error: err });
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to start shell.",
      };
    }

    const wc = event.sender;
    sessions.set(sessionId, { proc, wc, cwd });
    logInfo("Started embedded run terminal session.", { sessionId, cwd });

    proc.onData((data) => {
      const s = sessions.get(sessionId);
      if (!s) {
        return;
      }
      sendData(s.wc, sessionId, data);
    });

    proc.onExit(({ exitCode }) => {
      const s = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (s) {
        sendExit(s.wc, sessionId, typeof exitCode === "number" ? exitCode : -1);
      }
    });

    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.runTerminalWrite, (_event, input: RunTerminalWriteInput) => {
    const s = sessions.get(input.sessionId);
    if (s) {
      s.proc.write(input.data);
    }
  });

  ipcMain.handle(IPC_CHANNELS.runTerminalResize, (_event, input: RunTerminalResizeInput) => {
    const s = sessions.get(input.sessionId);
    if (s && input.cols > 0 && input.rows > 0) {
      s.proc.resize(input.cols, input.rows);
    }
  });

  ipcMain.handle(IPC_CHANNELS.runTerminalKill, (_event, sessionId: string) => {
    const s = sessions.get(sessionId);
    if (s) {
      try {
        s.proc.kill();
      } catch {
        logWarn("Failed to kill terminal session on explicit stop.", { sessionId });
        /* ignore */
      }
      sessions.delete(sessionId);
    }
  });
};
