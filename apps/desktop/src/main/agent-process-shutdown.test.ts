import { afterEach, describe, expect, it, vi } from "vitest";
import { agentProcessChain, parsePosixProcessList, processTree, terminateAgentProcesses, terminatePosixProcessTree, type ProcessListEntry } from "@buildwarden/agent-runtime";

const STARTED = "Thu Nov 19 07:00:00 2026";
const entry = (pid: number, ppid: number, name: string, commandLine: string | null = name, startedAt: string | null = STARTED): ProcessListEntry => ({ pid, ppid, name, commandLine, startedAt });

describe("agentProcessChain", () => {
  it("includes launcher shells and the agent, but not the commands the agent runs", () => {
    // Cursor via an npm shim: cmd.exe → powershell.exe → node (agent) → bash (command) → npm → ng serve.
    const processes = [
      entry(10, 1, "cmd.exe", "cmd.exe /d /s /c cursor-agent acp"),
      entry(11, 10, "powershell.exe", "powershell -File C:\\Users\\dev\\AppData\\Local\\cursor-agent\\cursor-agent.ps1 acp"),
      entry(12, 11, "node.exe", "node C:\\Users\\dev\\AppData\\Local\\cursor-agent\\versions\\1\\index.js acp"),
      entry(13, 12, "bash.exe", "bash.exe -c \"npm start\""),
      entry(14, 13, "node.exe", "node npm-cli.js start"),
      entry(15, 14, "node.exe", "node ng.js serve"),
      entry(99, 1, "explorer.exe"),
    ];
    expect(agentProcessChain(10, processes)).toEqual([10, 11, 12]);
  });

  it("keeps only the agent when it was started directly", () => {
    const processes = [
      entry(20, 1, "claude.exe"),
      entry(21, 20, "bash.exe", "bash -c 'pnpm dev'"),
      entry(22, 21, "node", "node vite.js"),
    ];
    expect(agentProcessChain(20, processes)).toEqual([20]);
  });

  it("falls back to the root alone when the root is not listed", () => {
    expect(agentProcessChain(30, [entry(31, 30, "node")])).toEqual([30]);
  });

  it("reports an unavailable process list so callers can end the whole tree", async () => {
    await expect(terminateAgentProcesses(40, { platform: "win32", list: async () => null })).resolves.toBe(false);
  });

  describe("liveness after the signals", () => {
    afterEach(() => vi.restoreAllMocks());
    const list = async () => [entry(50, 1, "node", "node agent.js")];
    const probeFails = (code: string) => vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error(code), { code });
      return true;
    });

    it("reports success once the agent is gone", async () => {
      probeFails("ESRCH");
      await expect(terminateAgentProcesses(50, { platform: "linux", list })).resolves.toBe(true);
    });

    it("waits for processes taskkill ended to finish exiting on Windows", async () => {
      // taskkill returns before the process is gone; the first probes still see it.
      let probes = 0;
      vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === 0 && ++probes > 2) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      });
      const runTaskkill = vi.fn(async () => "");
      await expect(terminateAgentProcesses(50, { platform: "win32", list, runTaskkill })).resolves.toBe(true);
      expect(runTaskkill).toHaveBeenCalledOnce();
    });

    it("treats a refused probe as a survivor, so callers fall back to the whole tree", async () => {
      // EPERM means the process exists but may not be signalled; it is not proof that it exited.
      const kill = probeFails("EPERM");
      await expect(terminateAgentProcesses(50, { platform: "linux", list })).resolves.toBe(false);
      expect(kill).toHaveBeenCalledWith(50, "SIGKILL");
    });
  });
});

describe("terminatePosixProcessTree", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the root and all its descendants", () => {
    expect(processTree(10, [entry(10, 1, "cursor-agent"), entry(11, 10, "sh"), entry(12, 11, "node"), entry(20, 1, "other")])).toEqual([10, 11, 12]);
  });

  it("signals the agent's descendants too, read before the agent exits", async () => {
    const alive = new Set([10, 11, 12]);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        return true;
      }
      alive.delete(pid);
      return true;
    });
    const list = async () => [entry(10, 1, "cursor-agent"), entry(11, 10, "sh"), entry(12, 11, "node"), entry(20, 1, "other")];
    await expect(terminatePosixProcessTree(10, { list })).resolves.toBe(true);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid)).toEqual([10, 11, 12]);
  });

  it("still signals the root without a process list, and reports the failure", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    await expect(terminatePosixProcessTree(10, { list: async () => null })).resolves.toBe(false);
    expect(kill).toHaveBeenCalledWith(10, "SIGTERM");
  });

  it("escalates only processes that kept their identity through the grace period", async () => {
    // 11 ends on SIGTERM and a new process takes its PID; 12 ignores SIGTERM.
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && pid === 10) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    let lists = 0;
    const list = async () => lists++ === 0
      ? [entry(10, 1, "cursor-agent"), entry(11, 10, "sh"), entry(12, 11, "node")]
      : [entry(11, 1, "unrelated", "unrelated", "Thu Nov 19 07:00:01 2026"), ...(lists > 2 ? [] : [entry(12, 1, "node")])];
    await expect(terminatePosixProcessTree(10, { list })).resolves.toBe(true);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid)).toEqual([12]);
  });

  it("sends no SIGKILL when identity cannot be rechecked, and reports the failure", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let lists = 0;
    const list = async () => lists++ === 0 ? [entry(10, 1, "cursor-agent")] : null;
    await expect(terminatePosixProcessTree(10, { list })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalledWith(10, "SIGKILL");
  });

  it("reports failure, and sends no SIGKILL, when the fresh list has no start time for a survivor", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let lists = 0;
    const list = async () => lists++ === 0 ? [entry(10, 1, "cursor-agent")] : [entry(10, 1, "cursor-agent", "cursor-agent", null)];
    await expect(terminatePosixProcessTree(10, { list })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalledWith(10, "SIGKILL");
  });

  it("reads each process's start time from ps", () => {
    expect(parsePosixProcessList("  10     1 Thu Nov  9 07:22:45 2026 /usr/bin/node agent.js --acp\n  11    10 Thu Nov  9 07:22:46 2026\n")).toEqual([
      { pid: 10, ppid: 1, name: "node", commandLine: "/usr/bin/node agent.js --acp", startedAt: "Thu Nov 9 07:22:45 2026" },
      { pid: 11, ppid: 10, name: "", commandLine: null, startedAt: "Thu Nov 9 07:22:46 2026" },
    ]);
  });
});
