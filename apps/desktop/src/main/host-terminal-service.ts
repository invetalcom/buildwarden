import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  RunTerminalResizeInput,
  RunTerminalStartInput,
  RunTerminalStartResult,
  RunTerminalWriteInput,
} from "@buildwarden/shared";
import type { IPty } from "node-pty";
import { logError, logInfo, logWarn } from "./logger";

const require = createRequire(import.meta.url);
type PtySpawn = typeof import("node-pty").spawn;

const loadPtySpawn = (): PtySpawn | null => {
  try {
    return (require("node-pty") as { spawn: PtySpawn }).spawn;
  } catch {
    logWarn("node-pty is unavailable; embedded terminal support is disabled.");
    return null;
  }
};

export interface HostTerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface HostTerminalExitEvent {
  sessionId: string;
  exitCode: number;
}

export interface HostTerminal {
  start(input: RunTerminalStartInput): RunTerminalStartResult;
  write(input: RunTerminalWriteInput): void;
  resize(input: RunTerminalResizeInput): void;
  kill(sessionId: string): void;
  killForRunId(runId: string): void;
  disposeAll(): void;
  onData(listener: (event: HostTerminalDataEvent) => void): () => void;
  onExit(listener: (event: HostTerminalExitEvent) => void): () => void;
}

type HostTerminalSession = { proc: IPty; cwd: string };

const runTerminalSessionIdForRun = (runId: string): string => `buildwarden-run-terminal:${runId}`;

const isSafeTerminalCwd = (cwd: string): boolean => {
  if (!cwd || cwd.trim() === "" || cwd === "chat") {
    return false;
  }
  try {
    return existsSync(cwd) && lstatSync(cwd).isDirectory();
  } catch {
    logWarn("Failed to validate terminal cwd.", { cwd });
    return false;
  }
};

const defaultShell = (): { file: string; args: string[] } => {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;
    return { file: comspec, args: ["/k"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
};

export class HostTerminalService implements HostTerminal {
  private readonly sessions = new Map<string, HostTerminalSession>();
  private readonly dataListeners = new Set<(event: HostTerminalDataEvent) => void>();
  private readonly exitListeners = new Set<(event: HostTerminalExitEvent) => void>();

  constructor(private readonly ptySpawn: PtySpawn | null = loadPtySpawn()) {}

  start(input: RunTerminalStartInput): RunTerminalStartResult {
    if (!this.ptySpawn) {
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
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.cwd === cwd) {
        return { ok: true, reused: true };
      }
      this.kill(sessionId);
    }
    if (!isSafeTerminalCwd(cwd)) {
      return { ok: false, error: "Worktree folder is not available for a terminal." };
    }

    const { file, args } = defaultShell();
    let proc: IPty;
    try {
      proc = this.ptySpawn(file, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: process.env as Record<string, string>,
        encoding: "utf8",
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      });
    } catch (error) {
      logError("Failed to start PTY shell.", { sessionId, cwd, shellFile: file, shellArgs: args, error });
      return { ok: false, error: error instanceof Error ? error.message : "Failed to start shell." };
    }

    this.sessions.set(sessionId, { proc, cwd });
    logInfo("Started embedded run terminal session.", { sessionId, cwd });
    proc.onData((data) => {
      if (!this.sessions.has(sessionId)) {
        return;
      }
      for (const listener of this.dataListeners) {
        listener({ sessionId, data });
      }
    });
    proc.onExit(({ exitCode }) => {
      if (!this.sessions.delete(sessionId)) {
        return;
      }
      for (const listener of this.exitListeners) {
        listener({ sessionId, exitCode: typeof exitCode === "number" ? exitCode : -1 });
      }
    });
    return { ok: true };
  }

  write(input: RunTerminalWriteInput): void {
    this.sessions.get(input.sessionId)?.proc.write(input.data);
  }

  resize(input: RunTerminalResizeInput): void {
    if (input.cols > 0 && input.rows > 0) {
      this.sessions.get(input.sessionId)?.proc.resize(input.cols, input.rows);
    }
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    try {
      session.proc.kill();
    } catch {
      logWarn("Failed to kill terminal session.", { sessionId, cwd: session.cwd });
    }
    this.sessions.delete(sessionId);
  }

  killForRunId(runId: string): void {
    this.kill(runTerminalSessionIdForRun(runId));
  }

  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.kill(sessionId);
    }
  }

  onData(listener: (event: HostTerminalDataEvent) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: HostTerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}
