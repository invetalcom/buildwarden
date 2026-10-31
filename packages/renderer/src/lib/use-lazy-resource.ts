import { useCallback, useEffect, useState } from "react";

/** Fetch details only for an open surface; reject stale responses after navigation. */
export const useLazyResource = <T>(key: string, load: () => Promise<T>, enabled: boolean) => {
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setResult(null); setAttempt((value) => value + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void load().then(
      (data) => { if (!disposed) setResult({ key, data }); },
      (error: unknown) => { if (!disposed) setResult({ key, error: error instanceof Error ? error.message : "Could not load details." }); },
    );
    return () => { disposed = true; };
  }, [key, load, enabled, attempt]);
  return { data: result?.key === key ? result.data : undefined, error: result?.key === key ? result.error : undefined, retry };
};
