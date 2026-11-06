import { existsSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  RunTerminalResizeInput,
  RunTerminalListResult,
  RunTerminalSummary,
  RunTerminalStartInput,
  RunTerminalStartResult,
  RunTerminalWriteInput,
} from "@buildwarden/shared";
import type { IPty } from "node-pty";
import { isMissingShell, terminalShellCandidates, terminalShells } from "./terminal-shells";
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
  generation?: number;
  data: string;
  sequence?: number;
}

export interface HostTerminalExitEvent {
  sessionId: string;
  generation?: number;
  exitCode: number;
}

export interface HostTerminal {
  start(input: RunTerminalStartInput): RunTerminalStartResult;
  list(runId: string): RunTerminalListResult;
  write(input: RunTerminalWriteInput): void;
  resize(input: RunTerminalResizeInput): void;
  kill(sessionId: string): void;
  killForRunId(runId: string): void;
  disposeAll(): void;
  onData(listener: (event: HostTerminalDataEvent) => void): () => void;
  onExit(listener: (event: HostTerminalExitEvent) => void): () => void;
}

type HostTerminalSession = { proc: IPty; cwd: string; subscriptions: Array<{ dispose(): void }> };

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

type TerminalRecord = RunTerminalSummary & { cwd: string; scrollback: string; sequence: number };
const MAX_SCROLLBACK = 256 * 1024;

export const terminalRunId = (input: RunTerminalStartInput): string => {
  const prefix = "buildwarden-run-terminal:";
  const embedded = input.sessionId.startsWith(prefix) ? input.sessionId.slice(prefix.length).split(":")[0]! : "";
  if (input.runId && embedded !== input.runId) throw new Error("Terminal does not belong to this run.");
  return input.runId ?? embedded;
};

export class HostTerminalService implements HostTerminal {
  private nextGeneration = 0;
  private readonly records = new Map<string, TerminalRecord>();
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
    let runId: string;
    try { runId = terminalRunId(input); } catch (error) {
      return { ok: false, error: String(error) };
    }
    const record = this.records.get(sessionId);
    if (record && record.runId !== runId) return { ok: false, error: "Terminal owner changed." };
    if (record && record.cwd === cwd && !input.restart) {
      return { ok: true, generation: record.generation, reused: true, scrollback: record.scrollback, sequence: record.sequence,
        status: record.status, shellFile: record.shellFile };
    }
    if (!isSafeTerminalCwd(cwd)) {
      return { ok: false, error: "Workspace folder is not available for a terminal." };
    }
    if (!record && this.list(runId).sessions.length >= 16) return { ok: false, error: "Close a terminal before opening more than 16 terminals in one run." };
    const shell = input.shell ?? record?.shell ?? "auto";
    let candidates: ReturnType<typeof terminalShellCandidates>;
    try { candidates = terminalShellCandidates(shell); } catch (error) {
      return { ok: false, error: String(error) };
    }
    let proc: IPty | undefined;
    let shellFile = "";
    for (const { file, args } of candidates) {
      try {
        proc = this.ptySpawn(file, args, {
          name: "xterm-256color", cols: 80, rows: 24, cwd,
          env: process.env as Record<string, string>, encoding: "utf8",
          ...(process.platform === "win32" ? { useConpty: true } : {}),
        });
        shellFile = file;
        break;
      } catch (error) {
        if (shell === "auto" && isMissingShell(error)) continue;
        logError("Failed to start PTY shell.", { sessionId, cwd, shellFile: file, error });
        return { ok: false, error: error instanceof Error ? error.message : "Failed to start shell." };
      }
    }
    if (!proc) return { ok: false, error: "No supported shell could be started. Select an installed shell." };
    // Preserve the live process and its scrollback if every replacement candidate fails.
    this.kill(sessionId);
    const current: TerminalRecord = { generation: ++this.nextGeneration, sessionId, runId, cwd, shell, shellFile, status: "running", scrollback: "", sequence: 0 };
    this.records.set(sessionId, current);
    const session: HostTerminalSession = { proc, cwd, subscriptions: [] };
    this.sessions.set(sessionId, session);
    logInfo("Started embedded run terminal session.", { sessionId, cwd });
    this.trackSubscription(sessionId, session, proc.onData((data) => {
      if (this.sessions.get(sessionId) !== session) {
        return;
      }
      current.scrollback = (current.scrollback + data).slice(-MAX_SCROLLBACK);
      current.sequence++;
      for (const listener of this.dataListeners) {
        if (this.sessions.get(sessionId) !== session) break;
        listener({ sessionId, generation: current.generation, data, sequence: current.sequence });
      }
    }));
    this.trackSubscription(sessionId, session, proc.onExit(({ exitCode }) => {
      if (this.sessions.get(sessionId) !== session) {
        return;
      }
      this.sessions.delete(sessionId);
      current.status = "exited";
      this.disposeSubscriptions(session);
      for (const listener of this.exitListeners) {
        listener({ sessionId, generation: current.generation, exitCode: typeof exitCode === "number" ? exitCode : -1 });
      }
    }));
    return { ok: true, generation: current.generation, shellFile, status: current.status, sequence: current.sequence, scrollback: current.scrollback };
  }

  list(runId: string): RunTerminalListResult {
    return { shells: terminalShells(), sessions: [...this.records.values()].filter((record) => record.runId === runId)
      .map(({ generation, sessionId, runId: owner, shell, shellFile, status }) => ({ generation, sessionId, runId: owner, shell, shellFile, status })) };
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
    this.records.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    // Detach ownership before kill(), which can synchronously invoke onExit.
    this.sessions.delete(sessionId);
    this.disposeSubscriptions(session);
    try {
      session.proc.kill();
    } catch {
      logWarn("Failed to kill terminal session.", { sessionId, cwd: session.cwd });
    }
  }

  private trackSubscription(sessionId: string, session: HostTerminalSession, subscription: { dispose(): void }): void {
    // A process may exit while onExit is being registered.
    if (this.sessions.get(sessionId) === session) session.subscriptions.push(subscription);
    else subscription.dispose();
  }

  private disposeSubscriptions(session: HostTerminalSession): void {
    for (const subscription of session.subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        logWarn("Failed to dispose terminal event subscription.", { cwd: session.cwd });
      }
    }
  }

  killForRunId(runId: string): void {
    for (const record of [...this.records.values()]) {
      if (record.runId === runId) this.kill(record.sessionId);
    }
    this.kill(runTerminalSessionIdForRun(runId));
  }

  disposeAll(): void {
    for (const sessionId of [...this.records.keys()]) {
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
