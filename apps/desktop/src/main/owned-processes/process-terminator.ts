import { execFile } from "node:child_process";
import { join } from "node:path";

export interface ProcessTerminator {
  /**
   * Asks the processes to end. Returns false when the request could not be delivered, so the
   * caller does not wait for a graceful exit that cannot happen (Windows console processes).
   */
  requestExit(pids: number[]): Promise<boolean>;
  /** Ends the processes immediately. */
  forceExit(pids: number[]): Promise<void>;
  isAlive(pid: number): boolean;
}

const taskkillPath = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

const taskkill = (args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(taskkillPath(), args, { windowsHide: true, timeout: 15_000 }, (error) => resolve(!error));
  });

const pidArgs = (pids: number[]) => pids.flatMap((pid) => ["/PID", String(pid)]);

const signal = (pid: number, name: NodeJS.Signals): boolean => {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
};

export const createPlatformProcessTerminator = (platform: NodeJS.Platform = process.platform): ProcessTerminator => ({
  async requestExit(pids) {
    if (pids.length === 0) return true;
    if (platform === "win32") {
      // Without /F, taskkill posts WM_CLOSE. Console programs (most dev servers) ignore it and the
      // command fails, which tells the caller to escalate right away.
      return taskkill(pidArgs(pids));
    }
    return pids.map((pid) => signal(pid, "SIGTERM")).some(Boolean);
  },
  async forceExit(pids) {
    if (pids.length === 0) return;
    if (platform === "win32") {
      // /T also ends children that the snapshot has not seen yet.
      await taskkill(["/F", "/T", ...pidArgs(pids)]);
      return;
    }
    for (const pid of pids) signal(pid, "SIGKILL");
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process exists but belongs to someone else.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
});
