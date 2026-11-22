/** The tab an arrow, Home or End key moves to, or undefined for any other key. */
export const nextTabForKey = <Value extends string>(key: string, values: readonly Value[], current: Value | null): Value | undefined => {
  if (values.length === 0) return undefined;
  if (key === "Home") return values[0];
  if (key === "End") return values.at(-1);
  const direction = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  const index = current === null ? -1 : values.indexOf(current);
  return direction === 0 ? undefined : values[(index + direction + values.length) % values.length];
};
