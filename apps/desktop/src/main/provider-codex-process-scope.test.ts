import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnCodexProcess, terminateCodexProcess } from "../../../../packages/provider-codex-cli/src/process-scope";

const { spawn, execFile } = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, execFile }));
const actualProcess = process;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(platform: string) {
  const kill = vi.fn();
  vi.stubGlobal("process", { ...actualProcess, platform, kill });
  const child = { pid: 12345, killed: false, exitCode: null, signalCode: null, kill: vi.fn() } as unknown as ChildProcessWithoutNullStreams;
  spawn.mockReturnValue(child);
  return { child, kill };
}

describe("Codex process scope", () => {
  it("signals the owned POSIX group and escalates even after its leader exits", async () => {
    const { child, kill } = setup("linux");
    expect(spawnCodexProcess("codex", ["app-server"], { cwd: "/repo" })).toBe(child);
    expect(spawn).toHaveBeenCalledWith("codex", ["app-server"], expect.objectContaining({ detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
    const stopped = terminateCodexProcess(child);
    expect(terminateCodexProcess(child)).toBe(stopped);
    expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, "SIGTERM");
    Object.assign(child, { killed: true, exitCode: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(kill).toHaveBeenLastCalledWith(-12345, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("treats an already vanished group as cleaned up without targeting another PID", async () => {
    const { child, kill } = setup("linux");
    spawnCodexProcess("codex", [], {});
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await terminateCodexProcess(child);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never signals a process group that it did not create", async () => {
    const { child, kill } = setup("darwin");
    const stopped = terminateCodexProcess(child);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it.each([false, true])("bounds Windows tree cleanup and falls back on taskkill failure: %s", async (fails) => {
    const { child, kill } = setup("win32");
    spawnCodexProcess("codex", [], {});
    execFile.mockImplementation((_file, _args, _options, callback) => { callback(fails ? new Error("taskkill failed") : null); });
    await terminateCodexProcess(child);
    expect(execFile).toHaveBeenCalledWith(expect.stringMatching(/taskkill\.exe$/), ["/pid", "12345", "/T", "/F"], { windowsHide: true, timeout: 5_000 }, expect.any(Function));
    expect(spawn).toHaveBeenCalledWith("codex", [], expect.objectContaining({ detached: false }));
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(fails ? 1 : 0);
  });
});
