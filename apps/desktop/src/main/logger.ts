import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

type LogLevel = "info" | "warn" | "error";

type LogMetadata = Record<string, unknown> | undefined;

const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES = 10;

let currentLogDirPath: string | null = null;
let currentLogFilePath: string | null = null;

const normalizeError = (value: unknown) => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  return value;
};

const normalizeMetadata = (metadata: LogMetadata) => {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, normalizeError(value)]),
  );
};

const safeJsonStringify = (value: unknown) => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }
    if (currentValue && typeof currentValue === "object") {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }
    return currentValue;
  });
};

const buildRotationTimestamp = (date: Date) => {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
  ].join("");
};

const rotateLogFileIfNeeded = () => {
  if (!currentLogDirPath || !currentLogFilePath) {
    return;
  }
  try {
    const currentSize = statSync(currentLogFilePath).size;
    if (currentSize < MAX_LOG_FILE_BYTES) {
      return;
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  const rotatedPath = join(currentLogDirPath, `main-${buildRotationTimestamp(new Date())}.log`);
  renameSync(currentLogFilePath, rotatedPath);

  const rotatedFiles = readdirSync(currentLogDirPath)
    .filter((name) => /^main-\d{8}-\d{6}-\d{3}\.log$/.test(name))
    .sort((left, right) => right.localeCompare(left));

  for (const staleFile of rotatedFiles.slice(MAX_ROTATED_LOG_FILES)) {
    rmSync(join(currentLogDirPath, staleFile), { force: true });
  }
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;

/** A stream whose reader went away: the terminal that started the app closed, or a pipe was cut. */
export const isBrokenPipeError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
};

/**
 * A console write that cannot reach its stream. EBADF counts here only, because the console of a
 * process without a terminal can have no valid descriptor; elsewhere it is a real error.
 */
const isUnwritableConsoleError = (error: unknown): boolean => isBrokenPipeError(error) || errorCode(error) === "EBADF";

let consoleOutputEnabled = true;
let consoleStreamsWatched = false;

/**
 * A failed console write is reported as an `error` event on the stream. Without a listener it becomes
 * an uncaught exception, whose handler logs it, which writes to the console again. The log file keeps
 * every line, so console output simply stops once the stream is gone.
 */
export const watchConsoleStreams = (streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr]): void => {
  if (consoleStreamsWatched) return;
  consoleStreamsWatched = true;
  for (const stream of streams) {
    stream.on("error", () => {
      consoleOutputEnabled = false;
    });
  }
};

const writeToConsole = (level: LogLevel, message: string, metadata: LogMetadata) => {
  if (!consoleOutputEnabled) return;
  watchConsoleStreams();
  let consoleTarget = console.info;
  if (level === "error") {
    consoleTarget = console.error;
  } else if (level === "warn") {
    consoleTarget = console.warn;
  }
  try {
    consoleTarget(`[buildwarden:${level}] ${message}`, metadata ?? "");
  } catch (error) {
    // Some streams throw synchronously instead of emitting an error event.
    if (isUnwritableConsoleError(error)) consoleOutputEnabled = false;
  }
};

const writeLogLine = (level: LogLevel, message: string, metadata?: LogMetadata) => {
  const line = safeJsonStringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(metadata ? { metadata: normalizeMetadata(metadata) } : {}),
  });
  // The file comes first, so a line is kept even when the console fails.
  if (currentLogFilePath) {
    try {
      rotateLogFileIfNeeded();
      appendFileSync(currentLogFilePath, `${line}
`, "utf8");
    } catch (error) {
      writeToConsole("error", "Failed to write log line", { error: normalizeError(error) });
    }
  }
  writeToConsole(level, message, metadata);
};

export const initializeAppLogger = (logDirPath: string) => {
  if (currentLogDirPath === logDirPath && currentLogFilePath) {
    return;
  }
  mkdirSync(logDirPath, { recursive: true });
  currentLogDirPath = logDirPath;
  currentLogFilePath = join(logDirPath, "main.log");
  writeLogLine("info", "Application logger initialized.", {
    logDirPath,
    logFilePath: currentLogFilePath,
  });
};

export const getAppLogDirPath = () => currentLogDirPath;


export const logInfo = (message: string, metadata?: LogMetadata) => {
  writeLogLine("info", message, metadata);
};

export const logWarn = (message: string, metadata?: LogMetadata) => {
  writeLogLine("warn", message, metadata);
};

export const logError = (message: string, metadata?: LogMetadata) => {
  writeLogLine("error", message, metadata);
};
