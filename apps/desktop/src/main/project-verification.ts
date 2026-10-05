import { spawn } from "node:child_process";

const MAX_VERIFICATION_OUTPUT_CHARS = 24_000;
const VERIFICATION_FORCE_KILL_GRACE_MS = 250;
const VERIFICATION_SHUTDOWN_TIMEOUT_MS = 2_000;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 3 * 60_000;

export interface ProjectVerificationResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

const appendOutputTail = (current: string, chunk: string): string => {
  const next = current + chunk;
  return next.length <= MAX_VERIFICATION_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_VERIFICATION_OUTPUT_CHARS);
};

const terminateProcessTree = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM") => {
  const killChild = () => {
    try { child.kill(signal); } catch { /* The completion watchdog handles failed termination. */ }
  };
  if (child.pid && process.platform === "win32") {
    // Do not target a PID that may have been reused after the shell exited.
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        try { killer.kill(); } catch { /* Best-effort cleanup. */ }
      }, VERIFICATION_SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      killer.once("error", () => { clearTimeout(timer); killChild(); });
      killer.once("close", (code) => { clearTimeout(timer); if (code !== 0) killChild(); });
      killer.unref();
    } catch { killChild(); }
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through when a process group was already gone.
    }
  }
  killChild();
};

export const runProjectVerificationCommand = async (
  cwd: string,
  command: string,
  timeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProjectVerificationResult> => {
  if (signal?.aborted) return { command, ok: false, exitCode: null, output: "Verification cancelled.", durationMs: 0, timedOut: false };
  const startedAt = Date.now();
  return await new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, CI: "true" },
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let exitUnconfirmed = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", cancel);
      const normalizedOutput = output.trim() || spawnError || "Command produced no output.";
      let finalOutput = normalizedOutput;
      if (spawnError && output.trim()) finalOutput += `\n${spawnError}`;
      if (timedOut) finalOutput += `\nTimed out after ${timeoutMs.toLocaleString()} ms. Verification commands must run once and exit; disable watch/interactive mode in the test runner.`;
      else if (cancelled) finalOutput = `${normalizedOutput}\nVerification cancelled.`;
      if (exitUnconfirmed) finalOutput += "\nProcess shutdown could not be confirmed. BuildWarden stopped waiting; a detached or unresponsive child may need manual cleanup.";
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolveResult({
        command,
        ok: !timedOut && !cancelled && !exitUnconfirmed && spawnError === null && exitCode === 0,
        exitCode,
        output: finalOutput,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };
    const requestTermination = () => {
      if (shutdownTimer || settled) return;
      // A killed shell is not guaranteed to emit close: descendants can retain its pipes.
      // Bound completion independently of process-tree cleanup and stream closure.
      shutdownTimer = setTimeout(() => {
        exitUnconfirmed = true;
        finish(null);
      }, VERIFICATION_SHUTDOWN_TIMEOUT_MS);
      terminateProcessTree(child);
      forceKillTimer ??= setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
      }, VERIFICATION_FORCE_KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    const cancel = () => {
      cancelled = true;
      requestTermination();
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output = appendOutputTail(output, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      output = appendOutputTail(output, chunk);
    });
    child.on("error", (error) => {
      spawnError = error.message;
      requestTermination();
    });
    child.once("exit", () => {
      if (settled) return;
      drainTimer = setTimeout(() => {
        spawnError ??= "Command exited but its output streams stayed open. A child process may still be running.";
        requestTermination();
      }, VERIFICATION_SHUTDOWN_TIMEOUT_MS);
    });
    child.on("close", finish);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
};

export const runProjectVerificationCommands = async (
  cwd: string,
  commands: string[],
  timeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProjectVerificationResult[]> => {
  const results: ProjectVerificationResult[] = [];
  for (const command of commands) {
    const result = await runProjectVerificationCommand(cwd, command, timeoutMs, signal);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
};
