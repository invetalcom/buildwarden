import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a callback with a permanent identity that always invokes the latest
 * `fn`. Use for event handlers passed to memoized children so the memo is not
 * defeated by inline-closure churn. Never call the result during render.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
