import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostTerminalService } from "./host-terminal-service";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("HostTerminalService", () => {
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

    expect(terminal.start({ sessionId: "buildwarden-run-terminal:run-1", cwd })).toEqual({ ok: true });
    terminal.write({ sessionId: "buildwarden-run-terminal:run-1", data: "pwd\r" });
    terminal.resize({ sessionId: "buildwarden-run-terminal:run-1", cols: 120, rows: 40 });
    publishData("output");
    publishExit({ exitCode: 0 });

    expect(proc.write).toHaveBeenCalledWith("pwd\r");
    expect(proc.resize).toHaveBeenCalledWith(120, 40);
    expect(dataSubscriber).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", data: "output" });
    expect(exitSubscriber).toHaveBeenCalledWith({ sessionId: "buildwarden-run-terminal:run-1", exitCode: 0 });
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
