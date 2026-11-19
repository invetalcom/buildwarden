import { spawn } from "node:child_process";
import { markAgentProcess } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { reportWorkerSpawnedProcesses, type WorkerProcessSpawnedMessage } from "./worker-process-reporting";

describe("reportWorkerSpawnedProcesses", () => {
  it("reports each spawned process with its PID, and marks agent processes", async () => {
    const messages: WorkerProcessSpawnedMessage[] = [];
    reportWorkerSpawnedProcesses((message) => messages.push(message));

    const run = (agent: boolean) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 50)"], { stdio: "ignore" });
      if (agent) markAgentProcess(child);
      child.once("error", reject);
      child.once("exit", () => resolve(child.pid ?? -1));
    });
    const commandPid = await run(false);
    const agentPid = await run(true);

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "process-spawned", pid: commandPid, role: "command", commandLine: expect.stringContaining("-e") }),
      expect.objectContaining({ type: "process-spawned", pid: agentPid, role: "agent" }),
    ]));
  });
});
