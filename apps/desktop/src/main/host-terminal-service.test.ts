import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import type { TerminalShell } from "@buildwarden/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostTerminalService } from "./host-terminal-service";

const tempDirs: string[] = [];

function createPty() {
  let publishData: (data: string) => void = () => undefined;
  let publishExit: (event: { exitCode: number }) => void = () => undefined;
  const disposeData = vi.fn();
  const disposeExit = vi.fn();
  const proc = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((listener: typeof publishData) => { publishData = listener; return { dispose: disposeData }; }),
    onExit: vi.fn((listener: typeof publishExit) => { publishExit = listener; return { dispose: disposeExit }; }),
  };
  return {
    proc, pty: proc as unknown as IPty, disposeData, disposeExit,
    // Retain callbacks even after disposal to simulate already queued native events.
    data: (data: string) => publishData(data), exit: (exitCode: number) => publishExit({ exitCode }),
  };
}

function createCwd() {
  const cwd = mkdtempSync(join(tmpdir(), "buildwarden-terminal-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("HostTerminalService", () => {
  it("reads the saved default for new terminals while preserving existing and explicit shell choices", () => {
    const preferred = process.platform === "win32" ? "pwsh" : "zsh";
    const readDefault = vi.fn<() => TerminalShell>(() => preferred);
    const terminal = new HostTerminalService(vi.fn(() => createPty().pty), readDefault);
    const cwd = createCwd();
    const input = { sessionId: "buildwarden-run-terminal:a", cwd };
    expect(terminal.start(input).ok).toBe(true);
    expect(terminal.list("a")).toMatchObject({ defaultShell: preferred, sessions: [{ shell: preferred }] });
    expect(terminal.start({ ...input, sessionId: "buildwarden-run-terminal:a:explicit", shell: "auto" }).ok).toBe(true);
    expect(terminal.list("a").sessions[1]?.shell).toBe("auto");
    readDefault.mockReturnValue("auto");
    expect(terminal.start({ ...input, restart: true }).ok).toBe(true);
    expect(terminal.list("a").sessions.find((session) => session.sessionId === input.sessionId)?.shell).toBe(preferred);
    terminal.disposeAll();
  });

  it.each(["restart", "cwd-change"])("preserves the live terminal when a %s spawn fails", (mode) => {
    const original = createPty();
    const spawn = vi.fn().mockReturnValueOnce(original.pty).mockImplementation(() => { throw new Error("spawn ENOENT"); });
    const terminal = new HostTerminalService(spawn);
    const input = { sessionId: "buildwarden-run-terminal:a:one", cwd: createCwd() };
    terminal.start(input);
    original.data("retained output");
    const before = terminal.list("a");
    const result = terminal.start({ ...input, cwd: mode === "cwd-change" ? createCwd() : input.cwd,
      restart: mode === "restart", shell: process.platform === "win32" ? "pwsh" : "bash" });
    expect(result.ok).toBe(false);
    expect(original.proc.kill).not.toHaveBeenCalled();
    expect(original.disposeData).not.toHaveBeenCalled();
    expect(terminal.list("a")).toEqual(before);
    expect(terminal.start(input)).toMatchObject({ ok: true, reused: true, scrollback: "retained output", sequence: 1 });
    terminal.write({ sessionId: input.sessionId, data: "still alive" });
    expect(original.proc.write).toHaveBeenCalledWith("still alive");
    terminal.disposeAll();
  });

  it("lists and cleans up all terminals for exactly one owner", () => {
    const processes = [createPty(), createPty(), createPty()];
    const spawn = vi.fn();
    processes.forEach((process) => spawn.mockReturnValueOnce(process.pty));
    const service = new HostTerminalService(spawn);
    const cwd = createCwd();
    for (const sessionId of ["buildwarden-run-terminal:a:one", "buildwarden-run-terminal:a:preview", "buildwarden-run-terminal:ab:one"]) {
      expect(service.start({ sessionId, cwd }).ok).toBe(true);
    }
    expect(service.list("a").sessions).toHaveLength(2);
    service.killForRunId("a");
    expect(service.list("a").sessions).toHaveLength(0);
    expect(processes[0]!.proc.kill).toHaveBeenCalledOnce();
    expect(processes[1]!.proc.kill).toHaveBeenCalledOnce();
    expect(processes[2]!.proc.kill).not.toHaveBeenCalled();
    expect(service.start({ sessionId: "buildwarden-run-terminal:ab:one", cwd, runId: "a" }).ok).toBe(false);
  });

  it("retains bounded output and an exited tab until explicitly restarted or closed", () => {
    const first = createPty();
    const second = createPty();
    const spawn = vi.fn().mockReturnValueOnce(first.pty).mockReturnValueOnce(second.pty);
    const service = new HostTerminalService(spawn);
    const input = { sessionId: "buildwarden-run-terminal:a:one", cwd: createCwd() };
    service.start(input);
    first.data("x".repeat(300_000));
    first.data("tail");
    first.exit(0);
    const attached = service.start(input);
    expect(attached.status).toBe("exited");
    expect(attached.scrollback?.length).toBe(256 * 1024);
    expect(attached.scrollback?.endsWith("tail")).toBe(true);
    expect(attached.sequence).toBe(2);
    expect(spawn).toHaveBeenCalledOnce();
    const restarted = service.start({ ...input, restart: true });
    expect(restarted.status).toBe("running");
    expect(restarted.generation).toBeGreaterThan(attached.generation!);
    expect(service.list("a").sessions[0]?.generation).toBe(restarted.generation);
    expect(service.start(input).generation).toBe(restarted.generation);
    expect(spawn).toHaveBeenCalledTimes(2);
    service.kill(input.sessionId);
    expect(service.list("a").sessions).toEqual([]);
  });

  it.each(["replace", "kill-and-restart"])("ignores stale callbacks after %s", (mode) => {
    const first = createPty();
    const second = createPty();
    const spawn = vi.fn().mockReturnValueOnce(first.pty).mockReturnValueOnce(second.pty);
    const terminal = new HostTerminalService(spawn);
    const onData = vi.fn();
    const onExit = vi.fn();
    terminal.onData(onData);
    terminal.onExit(onExit);
    const cwd = createCwd();
    terminal.start({ sessionId: "session", cwd });
    if (mode === "kill-and-restart") terminal.kill("session");
    const replacementCwd = mode === "replace" ? createCwd() : cwd;
    terminal.start({ sessionId: "session", cwd: replacementCwd });

    first.data("stale");
    first.exit(1);
    second.data("current");
    terminal.write({ sessionId: "session", data: "pwd\r" });
    terminal.resize({ sessionId: "session", cols: 90, rows: 30 });
    expect(terminal.start({ sessionId: "session", cwd: replacementCwd })).toMatchObject({ ok: true, reused: true });
    expect(first.proc.kill).toHaveBeenCalledOnce();
    expect(first.disposeData).toHaveBeenCalledOnce();
    expect(first.disposeExit).toHaveBeenCalledOnce();
    expect(onData).toHaveBeenCalledExactlyOnceWith({ sessionId: "session", generation: 2, data: "current", sequence: 1 });
    expect(onExit).not.toHaveBeenCalled();
    expect(second.proc.write).toHaveBeenCalledWith("pwd\r");
    expect(second.proc.resize).toHaveBeenCalledWith(90, 30);
    second.exit(0);
    second.exit(1);
    second.data("late");
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ sessionId: "session", generation: 2, exitCode: 0 });
    expect(onData).toHaveBeenCalledOnce();
    expect(second.disposeData).toHaveBeenCalledOnce();
    expect(second.disposeExit).toHaveBeenCalledOnce();
    terminal.disposeAll();
    expect(second.proc.kill).not.toHaveBeenCalled();
  });

  it("detaches ownership before a synchronous exit during kill", () => {
    const first = createPty();
    const second = createPty();
    const terminal = new HostTerminalService(vi.fn().mockReturnValueOnce(first.pty).mockReturnValueOnce(second.pty));
    const onExit = vi.fn();
    terminal.onExit(onExit);
    const cwd = createCwd();
    terminal.start({ sessionId: "session", cwd });
    first.proc.kill.mockImplementation(() => {
      first.exit(1);
      terminal.start({ sessionId: "session", cwd });
    });
    terminal.kill("session");
    terminal.write({ sessionId: "session", data: "current" });
    expect(onExit).not.toHaveBeenCalled();
    expect(second.proc.write).toHaveBeenCalledWith("current");
    terminal.disposeAll();
    expect(second.proc.kill).toHaveBeenCalledOnce();
  });

  it("disposes subscriptions if the process exits during registration", () => {
    const process = createPty();
    process.proc.onExit.mockImplementation((listener) => {
      listener({ exitCode: 2 });
      return { dispose: process.disposeExit };
    });
    const terminal = new HostTerminalService(vi.fn(() => process.pty));
    const onExit = vi.fn();
    terminal.onExit(onExit);
    terminal.start({ sessionId: "session", cwd: createCwd() });
    expect(onExit).toHaveBeenCalledExactlyOnceWith({ sessionId: "session", generation: 1, exitCode: 2 });
    expect(process.disposeData).toHaveBeenCalledOnce();
    expect(process.disposeExit).toHaveBeenCalledOnce();
    terminal.write({ sessionId: "session", data: "late" });
    expect(process.proc.write).not.toHaveBeenCalled();
  });

  it("owns PTYs and publishes data and exit events without an Electron dependency", () => {
    const cwd = mkdtempSync(join(tmpdir(), "buildwarden-terminal-"));
    tempDirs.push(cwd);
    let publishData: (data: string) => void = () => undefined;
    let publishExit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
    const proc = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        publishData = listener;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
        publishExit = listener;
        return { dispose: vi.fn() };
      }),
    } as unknown as IPty;
    const spawnPty = vi.fn(() => proc);
    const terminal = new HostTerminalService(spawnPty);
    const dataSubscriber = vi.fn();
    const exitSubscriber = vi.fn();
    terminal.onData(dataSubscriber);
    terminal.onExit(exitSubscriber);

    expect(terminal.start({ sessionId: "buildwarden-run-terminal:run-1", cwd })).toMatchObject({ ok: true });
    terminal.write({ sessionId: "buildwarden-run-terminal:run-1", data: "pwd\r" });
    terminal.resize({ sessionId: "buildwarden-run-terminal:run-1", cols: 120, rows: 40 });
    publishData("output");
    publishExit({ exitCode: 0 });

    expect(proc.write).toHaveBeenCalledWith("pwd\r");
    expect(proc.resize).toHaveBeenCalledWith(120, 40);
    expect(dataSubscriber).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", generation: 1, data: "output", sequence: 1 });
    expect(exitSubscriber).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", generation: 1, exitCode: 0 });
  });

  it("kills the terminal session associated with a deleted run", () => {
    const cwd = mkdtempSync(join(tmpdir(), "buildwarden-terminal-"));
    tempDirs.push(cwd);
    const proc = {
      kill: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as IPty;
    const terminal = new HostTerminalService(vi.fn(() => proc));
    terminal.start({ sessionId: "buildwarden-run-terminal:run-2", cwd });

    terminal.killForRunId("run-2");

    expect(proc.kill).toHaveBeenCalledOnce();
  });
});
