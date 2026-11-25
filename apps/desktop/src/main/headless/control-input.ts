import { isAbsolute } from "node:path";

/** Command inputs arrive as untyped JSON. */
export const requireText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
};

export const requireAbsolutePath = (value: unknown, label: string): string => {
  const path = requireText(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  return path;
};
