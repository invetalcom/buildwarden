import type { OwnedProcessRecord } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import {
  buildProcessTree,
  describeProcessCommand,
  formatProcessCpu,
  formatProcessDuration,
  formatProcessMemory,
  processStatusPresentation,
  summarizeProcesses,
} from "./owned-processes-model";

const processRecord =(overrides: Partial<OwnedProcessRecord> & Pick<OwnedProcessRecord, "processId">): OwnedProcessRecord => ({
  pid: Number(overrides.processId.replace(/\D/g, "")) || 1,
  parentProcessId: null,
  owner: { kind: "run", id: "run-1" },
  role: "command",
  attribution: "tree",
  name: "node.exe",
  commandLine: "node.exe",
  cwd: "C:\\repo",
  startedAt: "2026-11-18T10:00:00.000Z",
  endedAt: null,
  status: "running",
  endReason: null,
  exitCode: null,
  cpuPercent: 1.5,
  memoryBytes: 50 * 1024 * 1024,
  ports: [],
  restartOfProcessId: null,
  restartable: true,
  hasOutput: false,
  ...overrides,
});

const agent = processRecord({ processId: "a1", role: "agent", name: "claude.exe" });
const shell = processRecord({ processId: "s2", parentProcessId: "a1", name: "bash.exe", commandLine: "bash.exe -c \"pnpm dev\"" });
const server = processRecord({ processId: "n3", parentProcessId: "s2", name: "node.exe", ports: [5173], startedAt: "2026-11-18T10:00:05.000Z" });
const finished = processRecord({ processId: "g4", parentProcessId: "a1", name: "git.exe", status: "exited", endReason: "exited", exitCode: null, endedAt: "2026-11-18T10:00:02.000Z" });

describe("buildProcessTree", () => {
  it("hides the agent and promotes its children while keeping nesting below them", () => {
    const rows = buildProcessTree([agent, shell, server, finished], { showExited: false, showAgents: false, query: "" });
    expect(rows.map((row) => [row.process.processId, row.depth, row.descendantCount])).toEqual([["s2", 0, 1], ["n3", 1, 0]]);
  });

  it("shows agents and exited processes on request, running ones first", () => {
    const rows = buildProcessTree([agent, shell, server, finished], { showExited: true, showAgents: true, query: "" });
    expect(rows.map((row) => [row.process.processId, row.depth])).toEqual([["a1", 0], ["s2", 1], ["n3", 2], ["g4", 1]]);
  });

  it("filters by command, PID, or port and attaches matches to their nearest visible ancestor", () => {
    expect(buildProcessTree([agent, shell, server], { showExited: false, showAgents: false, query: "5173" }).map((row) => [row.process.processId, row.depth]))
      .toEqual([["n3", 0]]);
    expect(buildProcessTree([agent, shell, server], { showExited: false, showAgents: false, query: "PNPM" }).map((row) => row.process.processId))
      .toEqual(["s2"]);
  });
});

describe("process presentation", () => {
  it("summarizes running and exited commands and their ports", () => {
    expect(summarizeProcesses([agent, shell, server, finished])).toEqual({ running: 2, exited: 1, agents: 1, ports: [5173] });
  });

  it.each([
    [processRecord({ processId: "x1" }), "Running"],
    [processRecord({ processId: "x2", status: "stopping" }), "Stopping"],
    [processRecord({ processId: "x3", status: "exited", endReason: "killed" }), "Killed"],
    [processRecord({ processId: "x4", status: "exited", endReason: "stopped" }), "Stopped"],
    [processRecord({ processId: "x5", status: "exited", endReason: "exited", exitCode: 2 }), "Exited 2"],
    [processRecord({ processId: "x6", status: "exited", endReason: "exited", exitCode: 0 }), "Exited 0"],
    [processRecord({ processId: "x7", status: "exited", endReason: "exited" }), "Exited"],
  ])("labels status %#", (record, label) => {
    expect(processStatusPresentation(record).label).toBe(label);
  });

  it("shows the meaningful part of wrapped command lines", () => {
    expect(describeProcessCommand(processRecord({ processId: "c1", commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" vite.js --port 5173" }))).toBe("vite.js --port 5173");
    expect(describeProcessCommand(processRecord({ processId: "c2", commandLine: "powershell.exe -NoProfile -Command \"pnpm dev\"" }))).toBe("pnpm dev");
    expect(describeProcessCommand(processRecord({ processId: "c3", commandLine: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c \"npm run watch\"" }))).toBe("npm run watch");
    expect(describeProcessCommand(processRecord({ processId: "c4", commandLine: "/bin/bash -c 'pnpm test --watch'" }))).toBe("pnpm test --watch");
    expect(describeProcessCommand(processRecord({ processId: "c5", name: "svc.exe", commandLine: null }))).toBe("svc.exe");
  });

  it("formats memory, CPU, and durations compactly", () => {
    expect(formatProcessMemory(512 * 1024)).toBe("512 KB");
    expect(formatProcessMemory(5.5 * 1024 * 1024)).toBe("5.5 MB");
    expect(formatProcessMemory(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatProcessMemory(null)).toBe("—");
    expect(formatProcessCpu(0.04)).toBe("<0.1%");
    expect(formatProcessCpu(3.21)).toBe("3.2%");
    expect(formatProcessCpu(42.6)).toBe("43%");
    const start = "2026-11-18T10:00:00.000Z";
    expect(formatProcessDuration(start, null, Date.parse("2026-11-18T10:00:12.000Z"))).toBe("12s");
    expect(formatProcessDuration(start, "2026-11-18T10:04:05.000Z", 0)).toBe("4m 05s");
    expect(formatProcessDuration(start, null, Date.parse("2026-11-18T12:14:00.000Z"))).toBe("2h 14m");
    expect(formatProcessDuration(start, null, Date.parse("2026-11-21T12:00:00.000Z"))).toBe("3d 2h");
  });
});
