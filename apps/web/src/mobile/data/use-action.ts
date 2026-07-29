import { useCallback, useRef, useState } from "react";
import { errorMessage } from "../lib/format";

export interface ActionRunner {
  busy: boolean;
  error: string | null;
  clearError: () => void;
  /** Runs a mutation, surfacing failures as a message instead of an unhandled rejection. */
  run: <Result>(action: () => Promise<Result>, fallbackMessage?: string) => Promise<Result | undefined>;
  /**
   * Like {@link run}, but reports whether the call completed.
   *
   * Most host mutations return `Promise<void>`, so `run`'s `undefined` cannot tell success from
   * failure; anything that navigates away or dismisses a confirmation has to ask this instead.
   */
  ok: (action: () => Promise<unknown>, fallbackMessage?: string) => Promise<boolean>;
}

/**
 * Shared busy/error handling for the imperative host calls a screen makes. Mobile has no toast
 * stack to fall back on, so every failure has to land somewhere the user can actually see.
 */
export const useAction = (): ActionRunner => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(0);

  const run = useCallback(async <Result,>(action: () => Promise<Result>, fallbackMessage?: string) => {
    inFlight.current += 1;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(errorMessage(caught, fallbackMessage ?? "That action did not go through."));
      return undefined;
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setBusy(false);
    }
  }, []);

  const ok = useCallback(
    async (action: () => Promise<unknown>, fallbackMessage?: string) => {
      const completed = await run(async () => {
        await action();
        return true as const;
      }, fallbackMessage);
      return completed === true;
    },
    [run],
  );

  return { busy, error, clearError: () => setError(null), run, ok };
};
