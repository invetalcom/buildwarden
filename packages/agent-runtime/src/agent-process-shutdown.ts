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
  /**
   * When the process started, as `ps` prints it (POSIX only). With the PID it identifies the
   * process, so a later signal never reaches a process that reused a PID from an earlier list.
   */
  startedAt?: string | null;
}

const LIST_TIMEOUT_MS = 10_000;
const POSIX_GRACE_MS = 1_000;
/** taskkill /F requests termination and returns; the processes finish exiting afterwards. */
const WINDOWS_EXIT_WAIT_MS = 1_000;

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

/** Parses `ps -A -o pid=,ppid=,lstart=,args=` run with `LC_ALL=C` (lstart: `Thu Nov  9 07:22:45 2026`). */
export const parsePosixProcessList = (text: string): ProcessListEntry[] =>
  text.split(/\r?\n/).flatMap((line): ProcessListEntry[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    const commandLine = (match[4] ?? "").trim();
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      name: (commandLine.split(/\s+/)[0] ?? "").split("/").pop() ?? "",
      commandLine: commandLine || null,
      startedAt: match[3]!.replace(/\s+/g, " "),
    }];
  });

const run = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout) => {
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
    // LC_ALL=C keeps lstart in the fixed English format the parser reads.
    const output = await run("ps", ["-A", "-o", "pid=,ppid=,lstart=,args="], { ...process.env, LC_ALL: "C" });
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

const waitForExit = async (pids: number[], ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(mayBeAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/**
 * The escalation after the SIGTERM grace period. A PID can be reused while that period runs, so
 * only processes that a fresh list still shows with the start time from `listed` receive SIGKILL;
 * a process that took over an ended one's PID is never signalled. Resolves whether none of them is
 * left. When identity cannot be checked (no fresh list, or no start time), nothing is signalled and
 * the shutdown is reported unfinished, so the caller falls back to its own child handle.
 */
const killSurvivors = async (
  pids: number[],
  listed: ProcessListEntry[],
  list: () => Promise<ProcessListEntry[] | null>,
): Promise<boolean> => {
  const startedAt = new Map(listed.map((entry) => [entry.pid, entry.startedAt ?? null]));
  const sameProcesses = async (candidates: number[]): Promise<number[] | null> => {
    if (candidates.length === 0) return [];
    if (candidates.some((pid) => !startedAt.get(pid))) return null;
    const current = await list();
    if (!current) return null;
    const now = new Map(current.map((entry) => [entry.pid, entry.startedAt ?? null]));
    // A listed PID without a start time cannot be told apart from a replacement; it must not
    // count as gone either, or a survivor would be reported as ended.
    if (candidates.some((pid) => now.has(pid) && !now.get(pid))) return null;
    return candidates.filter((pid) => now.get(pid) === startedAt.get(pid));
  };
  const survivors = await sameProcesses(pids.filter(mayBeAlive));
  if (!survivors) return false;
  for (const pid of survivors) signal(pid, "SIGKILL");
  // Killed processes linger until their parent reaps them.
  await waitForExit(survivors, 500);
  const left = await sameProcesses(survivors.filter(mayBeAlive));
  return left !== null && left.length === 0;
};

/**
 * Ends a process and everything below it on Linux and macOS, where killing a child that does not
 * lead its own process group leaves its descendants running. The tree is read before any signal,
 * since a parent's exit hands its children to init. Resolves false when the process list was
 * unavailable (only the root received SIGTERM) or a process may have survived; the caller then
 * falls back to its own handle on the root.
 */
export const terminatePosixProcessTree = async (
  rootPid: number,
  options: {
    list?: () => Promise<ProcessListEntry[] | null>;
    /**
     * A list read before anything in the tree was signalled. Once a process exits, init adopts its
     * children, so the current list no longer links them to the root; this one still does. Only
     * those still running with the same start time are included.
     */
    earlier?: ProcessListEntry[] | null;
  } = {},
): Promise<boolean> => {
  const list = options.list ?? (() => listProcesses());
  const processes = await list();
  if (!processes) {
    signal(rootPid, "SIGTERM");
    await waitForExit([rootPid], POSIX_GRACE_MS);
    return false;
  }
  let pids = processTree(rootPid, processes);
  if (options.earlier) {
    const startedBefore = new Map(options.earlier.map((entry) => [entry.pid, entry.startedAt ?? null]));
    const startedNow = new Map(processes.map((entry) => [entry.pid, entry.startedAt ?? null]));
    const unchanged = (pid: number) => {
      const started = startedBefore.get(pid);
      return Boolean(started) && startedNow.get(pid) === started;
    };
    // The root may have exited since, and its PID gone to an unrelated process; then neither it nor
    // its current children are selected, only the verified former descendants below.
    if (!unchanged(rootPid)) pids = [];
    for (const pid of processTree(rootPid, options.earlier)) {
      if (pid === rootPid || pids.includes(pid) || !unchanged(pid)) continue;
      for (const descendant of processTree(pid, processes)) if (!pids.includes(descendant)) pids.push(descendant);
    }
  }
  for (const pid of pids) signal(pid, "SIGTERM");
  await waitForExit(pids, POSIX_GRACE_MS);
  return killSurvivors(pids, processes, list);
};

/**
 * Ends only the agent's own processes (see {@link agentProcessChain}), leaving commands it started
 * running. Resolves false when the process list was unavailable, so the caller can fall back to
 * ending the whole tree rather than leave the agent running.
 */
export const terminateAgentProcesses = async (
  rootPid: number,
  options: {
    platform?: NodeJS.Platform;
    list?: () => Promise<ProcessListEntry[] | null>;
    /** Runs taskkill on Windows; replaceable in tests. */
    runTaskkill?: (file: string, args: string[]) => Promise<unknown>;
  } = {},
): Promise<boolean> => {
  const platform = options.platform ?? process.platform;
  const list = options.list ?? (() => listProcesses(platform));
  const processes = await list();
  if (!processes) return false;
  const pids = agentProcessChain(rootPid, processes);
  // A survivor (taskkill could not start, timed out, or was refused) sends the caller to its
  // whole-tree fallback rather than leave the agent running.
  if (platform !== "win32") {
    for (const pid of pids) signal(pid, "SIGTERM");
    await waitForExit(pids, POSIX_GRACE_MS);
    return killSurvivors(pids, processes, list);
  }
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  // No /T: the commands the agent started outlive it. taskkill's exit code also reports PIDs
  // that had already exited, so success is judged by what is still running afterwards.
  await (options.runTaskkill ?? run)(taskkill, ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])]);
  // Judged too early, a process still exiting would count as a survivor and send the caller to
  // the whole-tree fallback, ending the commands this scope keeps running.
  await waitForExit(pids, WINDOWS_EXIT_WAIT_MS);
  return !pids.some(mayBeAlive);
};
