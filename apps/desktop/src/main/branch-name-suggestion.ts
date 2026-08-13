const stripSuggestionWrapper = (raw: string): string => {
  let value = raw.trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```[\w-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return value
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .replace(/^(?:branch(?:\s+name)?|name)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim() ?? "";
};

export const normalizeSuggestedBranchName = (raw: string): string => {
  const ascii = stripSuggestionWrapper(raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const segments = ascii
    .replace(/[^a-z0-9/._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .map((segment) => segment
      .replace(/-{2,}/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/\.lock$/i, "-lock"))
    .filter(Boolean);

  return segments
    .join("/")
    .slice(0, 100)
    .replace(/[./-]+$/g, "")
    .split("/")
    .map((segment) => segment.replace(/\.lock$/i, "-lock"))
    .join("/");
};
