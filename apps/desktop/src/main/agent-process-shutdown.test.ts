import { afterEach, describe, expect, it, vi } from "vitest";
import { agentProcessChain, terminateAgentProcesses, type ProcessListEntry } from "@buildwarden/agent-runtime";

const entry = (pid: number, ppid: number, name: string, commandLine: string | null = name): ProcessListEntry => ({ pid, ppid, name, commandLine });

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

    it("treats a refused probe as a survivor, so callers fall back to the whole tree", async () => {
      // EPERM means the process exists but may not be signalled; it is not proof that it exited.
      const kill = probeFails("EPERM");
      await expect(terminateAgentProcesses(50, { platform: "linux", list })).resolves.toBe(false);
      expect(kill).toHaveBeenCalledWith(50, "SIGKILL");
    });
  });
});
