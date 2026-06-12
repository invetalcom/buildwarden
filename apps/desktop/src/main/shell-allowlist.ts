import { DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES } from "@buildwarden/shared";

const safeCompile = (source: string): RegExp | null => {
  const t = source.trim();
  if (!t) {
    return null;
  }
  try {
    return new RegExp(t, "i");
  } catch {
    return null;
  }
};

/** Built-in safe patterns plus optional user-defined regex sources (from settings). */
export const compileShellAllowlistRegExes = (extraPatternSources: string[] | undefined): RegExp[] => {
  const builtIns = DEFAULT_SHELL_ALLOWLIST_PATTERN_SOURCES.map((s) => safeCompile(s)).filter((r): r is RegExp => r !== null);
  const extras = (extraPatternSources ?? []).map((s) => safeCompile(s)).filter((r): r is RegExp => r !== null);
  return [...builtIns, ...extras];
};
