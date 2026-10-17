import { useRef } from "react";

type AnyFunction = (...args: never[]) => unknown;

/**
 * Replaces every function-valued prop with a wrapper whose identity is stable
 * for the lifetime of the component and which always calls the latest prop.
 * Lets a memoized child skip re-renders caused only by inline closures.
 * Like useStableCallback, the wrappers must not be called during render.
 */
export function useStableFunctionProps<T extends object>(props: T): T {
  const latestPropsRef = useRef(props);
  // Assigned during render so child effects, which run before ours, never see stale handlers.
  latestPropsRef.current = props;
  const wrappersRef = useRef(new Map<string, AnyFunction>());

  const stableProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== "function") {
      stableProps[key] = value;
      continue;
    }
    let wrapper = wrappersRef.current.get(key);
    if (!wrapper) {
      wrapper = (...args: never[]) => {
        const latest = (latestPropsRef.current as Record<string, unknown>)[key];
        return typeof latest === "function" ? (latest as AnyFunction)(...args) : undefined;
      };
      wrappersRef.current.set(key, wrapper);
    }
    stableProps[key] = wrapper;
  }
  return stableProps as T;
}

/** Returns the previous value while the next one is shallowly equal to it. */
export function useShallowStableValue<T>(value: T): T {
  const previousRef = useRef(value);
  const previous = previousRef.current;
  if (previous !== value && !shallowEqual(previous, value)) {
    previousRef.current = value;
  }
  return previousRef.current;
}

/**
 * Returns the previous value while the next one serializes identically. For
 * small plain-data values derived from snapshots, which get new identities on
 * every refresh.
 */
export function useJsonStableValue<T>(value: T): T {
  const previousRef = useRef<{ value: T; json: string } | null>(null);
  const json = JSON.stringify(value);
  if (previousRef.current?.json !== json) {
    previousRef.current = { value, json };
  }
  return previousRef.current.value;
}

const shallowEqual =(left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key)
    && Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};
