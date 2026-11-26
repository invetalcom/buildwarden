import type { AppWarning } from "@buildwarden/shared";
import { isBrokenPipeError } from "./logger";

export interface MainProcessErrorHandlerOptions {
  logError: (message: string, metadata: Record<string, unknown>) => void;
  /** Tells the open windows about an error the app keeps running after. */
  publishWarning: (warning: AppWarning) => void;
  /** Shows the error and resolves once the user dismissed it. */
  showFatalError: (title: string, message: string, detail?: string) => Promise<void>;
  quit: () => void;
}

/** Text for a rejection reason; one without a string form, such as Object.create(null), must not throw here. */
const describeRejectionReason = (reason: unknown): string => {
  if (reason instanceof Error) return reason.message;
  try {
    return String(reason);
  } catch {
    return "Unknown rejection reason";
  }
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
        message: describeRejectionReason(reason),
        ...(reason instanceof Error && reason.stack ? { detail: reason.stack } : {}),
      });
    },
  };
};
