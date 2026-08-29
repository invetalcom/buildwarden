import { spawn } from "node:child_process";

const MAX_VERIFICATION_OUTPUT_CHARS = 24_000;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60_000;

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

const terminateProcessTree = (child: ReturnType<typeof spawn>) => {
  if (child.pid && process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through when a process group was already gone.
    }
  }
  child.kill();
};

export const runProjectVerificationCommand = async (
  cwd: string,
  command: string,
  timeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ProjectVerificationResult> => {
  const startedAt = Date.now();
  return await new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, CI: process.env.CI ?? "true" },
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
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const normalizedOutput = output.trim() || spawnError || "Command produced no output.";
      resolveResult({
        command,
        ok: !timedOut && !cancelled && spawnError === null && exitCode === 0,
        exitCode,
        output: timedOut
          ? `${normalizedOutput}\nTimed out after ${timeoutMs.toLocaleString()} ms.`
          : cancelled
            ? `${normalizedOutput}\nVerification cancelled.`
            : normalizedOutput,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    const cancel = () => {
      cancelled = true;
      terminateProcessTree(child);
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
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
    });
    child.on("close", finish);
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
