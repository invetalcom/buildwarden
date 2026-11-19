import { execFile } from "node:child_process";
import { join } from "node:path";
import { isLauncherProcessName, looksLikeAgentProcess } from "@buildwarden/shared";

/**
 * - `agent`: end only the agent CLI (and the shells that launched it). Commands it started, such as
 *   a dev server, keep running; the process panel lists them. Used when a turn finishes.
 * - `tree`: end everything the agent started. Used when a turn is cancelled.
 */
export type AgentShutdownScope = "agent" | "tree";

export interface ProcessListEntry {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string | null;
}

const LIST_TIMEOUT_MS = 10_000;
const POSIX_GRACE_MS = 1_000;

const WINDOWS_LIST_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | " +
  "ForEach-Object { [pscustomobject]@{ i = [int]$_.ProcessId; p = [int]$_.ParentProcessId; n = [string]$_.Name; c = $_.CommandLine } } | " +
  "ConvertTo-Json -Compress";

export const parseWindowsProcessList = (json: string): ProcessListEntry[] => {
  const parsed = JSON.parse(json) as unknown;
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return rows.flatMap((row): ProcessListEntry[] => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    if (typeof value.i !== "number" || typeof value.p !== "number") return [];
    return [{ pid: value.i, ppid: value.p, name: typeof value.n === "string" ? value.n : "", commandLine: typeof value.c === "string" ? value.c : null }];
  });
};

/** Parses `ps -A -o pid=,ppid=,args=`. */
export const parsePosixProcessList = (text: string): ProcessListEntry[] =>
  text.split(/\r?\n/).flatMap((line): ProcessListEntry[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const commandLine = (match[3] ?? "").trim();
    return [{ pid: Number(match[1]), ppid: Number(match[2]), name: (commandLine.split(/\s+/)[0] ?? "").split("/").pop() ?? "", commandLine: commandLine || null }];
  });

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });

/** One-shot process list; null when it could not be read. */
export const listProcesses = async (platform: NodeJS.Platform = process.platform): Promise<ProcessListEntry[] | null> => {
  try {
    if (platform === "win32") {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const output = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST_SCRIPT]);
      return output ? parseWindowsProcessList(output) : null;
    }
    const output = await run("ps", ["-A", "-o", "pid=,ppid=,args="]);
    return output ? parsePosixProcessList(output) : null;
  } catch {
    return null;
  }
};

/**
 * The agent's own processes inside its tree: the root, whatever launcher shells started (an npm
 * `.cmd` shim runs the agent under cmd.exe), and nested agent executables (Codex's native binary
 * below its Node wrapper). Shells the agent runs commands in, and their children, are not part of it.
 */
export const agentProcessChain = (rootPid: number, processes: ProcessListEntry[]): number[] => {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = new Map<number, ProcessListEntry[]>();
  for (const entry of processes) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const root = byPid.get(rootPid);
  if (!root) return [rootPid];
  const chain: number[] = [];
  const visit = (entry: ProcessListEntry, launchedByLaunchers: boolean) => {
    if (chain.includes(entry.pid)) return;
    chain.push(entry.pid);
    const launcher = launchedByLaunchers && isLauncherProcessName(entry.name);
    for (const child of children.get(entry.pid) ?? []) {
      if (launcher || looksLikeAgentProcess(child)) visit(child, launcher);
    }
  };
  visit(root, true);
  return chain;
};

const signal = (pid: number, name: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether a process may still be running. Only ESRCH proves it is gone; EPERM (and any other
 * error) leaves it possibly alive, so a shutdown is never reported done on a guess.
 */
export const mayBeAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
};

/** The root and every process below it in the list. */
export const processTree = (rootPid: number, processes: ProcessListEntry[]): number[] => {
  const children = new Map<number, number[]>();
  for (const entry of processes) {
    if (entry.pid === entry.ppid) continue;
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const tree: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (tree.includes(pid)) continue;
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
};

/**
 * Ends a process and everything below it on Linux and macOS, where killing a child that does not
 * lead its own process group leaves its descendants running. The tree is read before any signal,
 * since a parent's exit hands its children to init. Resolves false when the process list was
 * unavailable (only the root was signalled) or a process survived SIGKILL.
 */
export const terminatePosixProcessTree = async (
  rootPid: number,
  options: { list?: () => Promise<ProcessListEntry[] | null> } = {},
): Promise<boolean> => {
  const processes = await (options.list ?? (() => listProcesses()))();
  const pids = processes ? processTree(rootPid, processes) : [rootPid];
  const waitForExit = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && pids.some(mayBeAlive)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  for (const pid of pids) signal(pid, "SIGTERM");
  await waitForExit(POSIX_GRACE_MS);
  for (const pid of pids) if (mayBeAlive(pid)) signal(pid, "SIGKILL");
  // Killed processes linger until their parent reaps them.
  await waitForExit(500);
  return processes !== null && !pids.some(mayBeAlive);
};

/**
 * Ends only the agent's own processes (see {@link agentProcessChain}), leaving commands it started
 * running. Resolves false when the process list was unavailable, so the caller can fall back to
 * ending the whole tree rather than leave the agent running.
 */
export const terminateAgentProcesses = async (
  rootPid: number,
  options: { platform?: NodeJS.Platform; list?: () => Promise<ProcessListEntry[] | null> } = {},
): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  const processes = await (options.list ?? (() => listProcesses(platform)))();
  if (!processes) return false;
  const pids = agentProcessChain(rootPid, processes);
  if (platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    // No /T: the commands the agent started outlive it. taskkill's exit code also reports PIDs
    // that had already exited, so success is judged by what is still running afterwards.
    await run(taskkill, ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])]);
  } else {
    for (const pid of pids) signal(pid, "SIGTERM");
    const deadline = Date.now() + POSIX_GRACE_MS;
    while (Date.now() < deadline && pids.some(mayBeAlive)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const pid of pids) if (mayBeAlive(pid)) signal(pid, "SIGKILL");
  }
  // A survivor (taskkill could not start, timed out, or was refused) sends the caller to its
  // whole-tree fallback rather than leave the agent running.
  return !pids.some(mayBeAlive);
};
