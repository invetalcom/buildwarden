import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { join } from "node:path";

const ownedProcessGroups = new WeakSet<ChildProcessWithoutNullStreams>();
const terminations = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>();
const TERMINATION_GRACE_MS = 1_000;

export function spawnCodexProcess(command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  if (process.platform !== "win32") ownedProcessGroups.add(child);
  return child;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try { child.kill(signal); } catch { /* Already exited or failed to spawn. */ }
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) {
    if (!child.killed) signalChild(child, "SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5_000 }, (error) => {
          if (error) signalChild(child, "SIGKILL");
          resolve();
        });
    });
    return;
  }
  if (ownedProcessGroups.has(child)) {
    try {
      if (!signalGroup(child.pid, "SIGTERM")) return;
      // Do not cancel escalation on the leader's exit: descendants may still
      // own the group, including helpers that ignore SIGTERM.
      const deadline = Date.now() + TERMINATION_GRACE_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())));
        try {
          if (!signalGroup(child.pid, 0)) return;
        } catch {
          // Permission and other probe errors do not prove that the group exited.
        }
      }
      signalGroup(child.pid, "SIGKILL");
      return;
    } catch {
      // Never signal the host's group when the process was not launched by us.
    }
  }
  signalChild(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS));
  if (child.exitCode === null && child.signalCode === null) signalChild(child, "SIGKILL");
}

export function terminateCodexProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const existing = terminations.get(child);
  if (existing) return existing;
  const pending = terminate(child);
  terminations.set(child, pending);
  return pending;
}
