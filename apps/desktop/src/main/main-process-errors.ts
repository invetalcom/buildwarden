import type { AppWarning } from "@buildwarden/shared";
import { isBrokenPipeError } from "./logger";

export interface MainProcessErrorHandlerOptions {
  logError: (message: string, metadata: Record<string, unknown>) => void;
  /**
   * Tells connected clients about an error the app keeps running after. Remote clients with read
   * access receive it too, so it carries no message or stack of the host's error.
   */
  publishWarning: (warning: AppWarning) => void;
  /** Shows the error and resolves once the user dismissed it. */
  showFatalError: (title: string, message: string, detail?: string) => Promise<void>;
  quit: () => void;
}

/**
 * The kind of a rejection reason, such as "TypeError". The message and stack stay in the host log.
 * Reading a reason must not throw here, even for one without a string form such as Object.create(null).
 */
const describeRejectionKind = (reason: unknown): string => {
  try {
    if (reason instanceof Error) return /^[A-Za-z][\w.]{0,59}$/.test(reason.name) ? reason.name : "Error";
  } catch {
    // A reason whose prototype or name cannot be read is described as unknown.
  }
  return "Unknown rejection reason";
};

/**
 * Handlers for errors nothing else caught.
 *
 * - An uncaught exception may have stopped a function halfway, so the app reports it once and quits.
 * - A broken pipe only means a reader went away, such as the terminal that started the app or an
 *   exited child process. It is logged, and the app keeps running.
 * - An unhandled rejection left no synchronous state half done. It is logged and shown as a warning.
 */
export const createMainProcessErrorHandlers = (options: MainProcessErrorHandlerOptions) => {
  let fatalErrorReported = false;
  return {
    onUncaughtException(error: Error): void {
      if (isBrokenPipeError(error)) {
        options.logError("A stream reader closed before BuildWarden finished writing to it.", { error });
        return;
      }
      options.logError("Uncaught exception in main process.", { error });
      // Several exceptions in a row show one dialog and quit once.
      if (fatalErrorReported) return;
      fatalErrorReported = true;
      void options.showFatalError("Uncaught Exception", error.message, error.stack)
        .catch(() => undefined)
        .then(() => options.quit());
    },
    onUnhandledRejection(reason: unknown): void {
      options.logError("Unhandled rejection in main process.", { reason });
      if (isBrokenPipeError(reason)) return;
      options.publishWarning({
        title: "Unexpected error",
        message: `A background task failed (${describeRejectionKind(reason)}). BuildWarden kept running; the log has the details.`,
      });
    },
  };
};
