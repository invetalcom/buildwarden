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
    expect(kill).toHaveBeenCalledWith(-12345, 0);
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

  it("finishes early when a probe confirms that the whole group exited", async () => {
    const { child, kill } = setup("linux");
    spawnCodexProcess("codex", [], {});
    kill.mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const stopped = terminateCodexProcess(child);
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    expect(kill.mock.calls).toEqual([[-12345, "SIGTERM"], [-12345, 0]]);
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("still escalates after probe errors other than ESRCH", async () => {
    const { child, kill } = setup("linux");
    spawnCodexProcess("codex", [], {});
    kill.mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    const stopped = terminateCodexProcess(child);
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalledWith(-12345, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(kill).toHaveBeenLastCalledWith(-12345, "SIGKILL");
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

  it("ends only Codex itself after a finished turn, so commands it started keep running", async () => {
    const { child, kill } = setup("win32");
    spawnCodexProcess("codex", ["app-server"], {});
    const processes = [
      { i: 12345, p: 1, n: "cmd.exe", c: "cmd.exe /d /s /c \"codex app-server\"" },
      { i: 200, p: 12345, n: "node.exe", c: "node C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js app-server" },
      { i: 300, p: 200, n: "codex-x86_64-pc-windows-msvc.exe", c: null },
      { i: 400, p: 300, n: "powershell.exe", c: "powershell.exe -NoProfile -Command \"pnpm dev\"" },
      { i: 500, p: 400, n: "node.exe", c: "node vite.js" },
    ];
    execFile.mockImplementation((file: string, _args, _options, callback) => {
      callback(null, /powershell\.exe$/i.test(file) ? JSON.stringify(processes) : "");
    });
    // After taskkill, the agent chain is gone.
    kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await terminateCodexProcess(child, "agent");
    const taskkills = execFile.mock.calls.filter(([file]) => /taskkill\.exe$/i.test(String(file)));
    expect(taskkills.map((call) => call[1])).toEqual([["/F", "/PID", "12345", "/PID", "200", "/PID", "300"]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to ending the whole tree when the agent survives taskkill", async () => {
    const { child, kill } = setup("win32");
    spawnCodexProcess("codex", [], {});
    execFile.mockImplementation((file: string, _args, _options, callback) => {
      if (/powershell\.exe$/i.test(file)) callback(null, JSON.stringify([{ i: 12345, p: 1, n: "codex.exe", c: null }]));
      else callback(Object.assign(new Error("Access is denied."), { code: 1 }), "");
    });
    // The agent is still alive after the targeted taskkill failed.
    kill.mockImplementation(() => true);
    await terminateCodexProcess(child, "agent");
    expect(execFile).toHaveBeenLastCalledWith(expect.stringMatching(/taskkill\.exe$/), ["/pid", "12345", "/T", "/F"], { windowsHide: true, timeout: 5_000 }, expect.any(Function));
  });

  it("falls back to ending the whole tree when the process list is unavailable", async () => {
    const { child } = setup("win32");
    spawnCodexProcess("codex", [], {});
    execFile.mockImplementation((file: string, _args, _options, callback) => {
      callback(/powershell\.exe$/i.test(file) ? new Error("no powershell") : null, "");
    });
    await terminateCodexProcess(child, "agent");
    expect(execFile).toHaveBeenLastCalledWith(expect.stringMatching(/taskkill\.exe$/), ["/pid", "12345", "/T", "/F"], { windowsHide: true, timeout: 5_000 }, expect.any(Function));
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
