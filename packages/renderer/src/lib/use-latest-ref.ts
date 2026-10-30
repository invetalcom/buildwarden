import { useInsertionEffect, useRef } from "react";

/** Latest committed value for event handlers and layout/passive effects; never read during render.
 * Publish during commit, before descendant layout effects, without leaking suspended renders.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}
