import { useEffect } from "react";
import { reportRendererError } from "./report-renderer-error";

export const useRendererErrorReporting = () => {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      reportRendererError("renderer.window.error", event.error ?? event.message, {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      });
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportRendererError("renderer.window.unhandledrejection", event.reason);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);
};
