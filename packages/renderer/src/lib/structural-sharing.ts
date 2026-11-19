const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/**
 * Returns `next`, but reuses every array and plain object of `previous` that is deeply
 * equal to its counterpart. A reloaded snapshot then keeps the identity of unchanged
 * projects, runs and lists, so memoized components and selectors skip them. When nothing
 * changed, `previous` itself is returned and a React state update bails out.
 *
 * Only JSON-like data is shared; other objects (dates, maps, class instances) compare by identity.
 */
export const replaceEqualDeep = <T>(previous: unknown, next: T): T => {
  if (Object.is(previous, next)) return previous as T;

  if (Array.isArray(previous) && Array.isArray(next)) {
    let equal = previous.length === next.length;
    let reused = false;
    const merged = next.map((item: unknown, index) => {
      const shared = replaceEqualDeep(previous[index], item);
      if (shared !== previous[index]) equal = false;
      if (shared !== item) reused = true;
      return shared;
    });
    if (equal) return previous as T;
    return (reused ? merged : next) as T;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let equal = Object.keys(previous).length === nextKeys.length;
    let reused = false;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const shared = replaceEqualDeep(previous[key], next[key]);
      merged[key] = shared;
      if (shared !== previous[key] || !Object.prototype.hasOwnProperty.call(previous, key)) equal = false;
      if (shared !== next[key]) reused = true;
    }
    if (equal) return previous as T;
    // Without a reused branch, `next` already is the result and needs no copy.
    return (reused ? merged : next) as T;
  }

  return next;
};
