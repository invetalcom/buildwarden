import { useLayoutEffect, useRef } from "react";

/** Latest committed value for event handlers and effects; never read during render.
 * Updating after commit prevents suspended renders from leaking uncommitted values.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
