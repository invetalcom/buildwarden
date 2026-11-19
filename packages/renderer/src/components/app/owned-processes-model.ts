import type { OwnedProcessRecord } from "@buildwarden/shared";
import type { BadgeProps } from "../ui/badge";

export interface ProcessTreeRow {
  process: OwnedProcessRecord;
  depth: number;
  /** Visible descendants below this row (used for "stop with N children" hints). */
  descendantCount: number;
}

export interface ProcessTreeOptions {
  showExited: boolean;
  showAgents: boolean;
  query: string;
}

const matchesQuery = (process: OwnedProcessRecord, query: string): boolean => {
  if (!query) return true;
  const haystack = `${process.name} ${process.commandLine ?? ""} ${String(process.pid)} ${process.ports.join(" ")}`.toLowerCase();
  return haystack.includes(query);
};

/**
 * Flattens processes into an indented tree. Hidden processes (agents, exited ones, or ones that do
 * not match the filter) hand their visible children to their nearest visible ancestor.
 */
export const buildProcessTree = (processes: OwnedProcessRecord[], options: ProcessTreeOptions): ProcessTreeRow[] => {
  const query = options.query.trim().toLowerCase();
  const byId = new Map(processes.map((process) => [process.processId, process]));
  const isVisible = (process: OwnedProcessRecord) =>
    (options.showAgents || process.role !== "agent") &&
    (options.showExited || process.status !== "exited") &&
    matchesQuery(process, query);
  const visibleParent = (process: OwnedProcessRecord): string | null => {
    let parentId = process.parentProcessId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return null;
      if (isVisible(parent)) return parent.processId;
      parentId = parent.parentProcessId;
    }
    return null;
  };
  const children = new Map<string | null, OwnedProcessRecord[]>();
  for (const process of processes) {
    if (!isVisible(process)) continue;
    const parent = visibleParent(process);
    const list = children.get(parent) ?? [];
    list.push(process);
    children.set(parent, list);
  }
  const order = (left: OwnedProcessRecord, right: OwnedProcessRecord) => {
    // Running first, then newest first so a just-started server is easy to find.
    const leftExited = left.status === "exited" ? 1 : 0;
    const rightExited = right.status === "exited" ? 1 : 0;
    if (leftExited !== rightExited) return leftExited - rightExited;
    return Date.parse(right.startedAt) - Date.parse(left.startedAt);
  };
  const rows: ProcessTreeRow[] = [];
  const visit = (parentId: string | null, depth: number): number => {
    let count = 0;
    for (const process of [...(children.get(parentId) ?? [])].sort(order)) {
      const row: ProcessTreeRow = { process, depth, descendantCount: 0 };
      rows.push(row);
      row.descendantCount = visit(process.processId, depth + 1);
      count += 1 + row.descendantCount;
    }
    return count;
  };
  visit(null, 0);
  return rows;
};

export interface ProcessSummary {
  running: number;
  exited: number;
  agents: number;
  ports: number[];
}

export const summarizeProcesses = (processes: OwnedProcessRecord[]): ProcessSummary => {
  const tasks = processes.filter((process) => process.role !== "agent");
  const running = tasks.filter((process) => process.status !== "exited");
  return {
    running: running.length,
    exited: tasks.length - running.length,
    agents: processes.filter((process) => process.role === "agent" && process.status !== "exited").length,
    ports: [...new Set(running.flatMap((process) => process.ports))].sort((left, right) => left - right),
  };
};

export const formatProcessMemory = (bytes: number | null): string => {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${String(Math.max(0, Math.round(bytes / 1024)))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const formatProcessCpu = (percent: number | null): string => {
  if (percent === null || !Number.isFinite(percent)) return "—";
  if (percent > 0 && percent < 0.1) return "<0.1%";
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
};

/** "12s", "4m 05s", "2h 14m", "3d 2h". */
export const formatProcessDuration = (startedAt: string, endedAt: string | null, now: number): string => {
  const end = endedAt ? Date.parse(endedAt) : now;
  const seconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ${String(minutes % 60)}m`;
  return `${String(Math.floor(hours / 24))}d ${String(hours % 24)}h`;
};

export interface ProcessStatusPresentation {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
}

export const processStatusPresentation = (process: OwnedProcessRecord): ProcessStatusPresentation => {
  if (process.status === "running") return { label: "Running", tone: "running" };
  if (process.status === "stopping") return { label: "Stopping", tone: "queued" };
  if (process.endReason === "killed") return { label: "Killed", tone: "failed" };
  if (process.endReason === "stopped") return { label: "Stopped", tone: "cancelled" };
  if (process.exitCode !== null && process.exitCode !== 0) return { label: `Exited ${String(process.exitCode)}`, tone: "failed" };
  return { label: process.exitCode === 0 ? "Exited 0" : "Exited", tone: "completed" };
};

/**
 * The part of a command line worth reading: drops the executable path and wrappers such as
 * `cmd /c` or `powershell -Command` so `pnpm dev` stays visible in a narrow row.
 */
export const describeProcessCommand = (process: OwnedProcessRecord): string => {
  const commandLine = process.commandLine?.trim();
  if (!commandLine) return process.name;
  let rest = commandLine.replace(/^"[^"]*"\s*|^\S+\s*/, "");
  rest = rest.replace(/^(\/d\s+)?(\/s\s+)?\/c\s+/i, "");
  rest = rest.replace(/^(-NoLogo\s+|-NoProfile\s+|-NonInteractive\s+|-ExecutionPolicy\s+\S+\s+)*(-Command|-c)\s+/i, "");
  rest = rest.replace(/^-l?c\s+/, "");
  rest = rest.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  return rest || process.name;
};

export const localhostUrl = (port: number): string => `http://localhost:${String(port)}`;

/** Explains processes linked by workspace evidence rather than through their parent chain. */
export const WORKSPACE_ATTRIBUTION_HINT =
  "Its parent exited before BuildWarden saw it; matched because it started during the agent's turn and runs in this workspace.";

export const PROCESS_ROLE_LABELS: Record<OwnedProcessRecord["role"], string> = {
  agent: "Agent",
  command: "Command",
  restarted: "Restarted",
};
