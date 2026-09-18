import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface TextGenerationProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  windowsVerbatimArguments?: boolean;
}

/** Prompts travel through stdin, never through a Windows command shim. */
export const resolveTextGenerationProcessLaunch = (
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): Pick<TextGenerationProcessOptions, "command" | "args" | "windowsVerbatimArguments"> => {
  if (platform !== "win32" || (/[/\\]/.test(command) && !/\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }
  const quote = (value: string): string => {
    if (/[\r\n"&|<>^%!]/.test(value)) {
      throw new Error("Text generation command-shim arguments cannot contain Windows shell metacharacters.");
    }
    return `"${value}"`;
  };
  return {
    command: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/c", ["call", quote(command), ...args.map(quote)].join(" ")],
    windowsVerbatimArguments: true,
  };
};

const terminate = (child: ChildProcessWithoutNullStreams): void => {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killed = spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    if (!killed.error && killed.status === 0) return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      // Each utility process owns its group, including any CLI helper children.
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process may have exited between cancellation and group termination.
    }
  }
  child.kill("SIGKILL");
};

/** Bounded, non-interactive process execution shared by the CLI utility adapters. */
export const runTextGenerationProcess = async (options: TextGenerationProcessOptions): Promise<string> => {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = (error: Error) => {
      if (failure || settled) return;
      failure = error;
      terminate(child);
    };
    const abort = () => stop(new Error("Text generation cancelled."));
    const timeout = setTimeout(() => stop(new Error("Text generation timed out.")), options.timeoutMs ?? 180_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 8_000_000) {
        stop(new Error("Text generation exceeded the output limit."));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_000); });
    child.on("error", (error) => finish(failure ?? error));
    child.on("close", (code) => {
      finish(failure ?? (code === 0 ? undefined : new Error(stderr.trim() || `Text generation exited with code ${String(code)}.`)));
    });
    // A process can reject its arguments and close stdin before consuming the prompt.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    if (options.signal?.aborted) abort();
    else child.stdin.end(options.prompt);
  });
};
