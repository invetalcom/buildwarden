import { useCallback, useEffect, useState } from "react";

/** Fetch details only for an open surface; reject stale responses after navigation. */
export const useLazyResource = <T>(key: string, load: () => Promise<T>, enabled: boolean, identity = key) => {
  const [result, setResult] = useState<{ key: string; identity: string; data?: T; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setAttempt((value) => value + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    void load().then(
      (data) => { if (!disposed) setResult({ key, identity, data }); },
      (error: unknown) => { if (!disposed) setResult((previous) => ({ key, identity, data: previous?.identity === identity ? previous.data : undefined, error: error instanceof Error ? error.message : "Could not load details." })); },
    );
    return () => { disposed = true; };
  }, [key, identity, load, enabled, attempt]);
  return { data: result?.identity === identity ? result.data : undefined, error: result?.key === key ? result.error : undefined, retry };
};
