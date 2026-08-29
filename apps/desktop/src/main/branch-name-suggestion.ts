const trimMatchingCharacters = (value: string, characters: ReadonlySet<string>): string => {
  let start = 0;
  let end = value.length;
  while (start < end && characters.has(value[start]!)) start += 1;
  while (end > start && characters.has(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
};

const trimTrailingCharacters = (value: string, characters: ReadonlySet<string>): string => {
  let end = value.length;
  while (end > 0 && characters.has(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
};

const QUOTE_CHARACTERS = new Set(["\"", "'", "`"]);
const BRANCH_SEGMENT_EDGE_CHARACTERS = new Set([".", "-"]);
const BRANCH_NAME_TRAILING_CHARACTERS = new Set([".", "/", "-"]);

const stripSuggestionWrapper = (raw: string): string => {
  let value = raw.trim();
  if (value.startsWith("```")) {
    value = value.replace(/^```[\w-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  const candidate = value
    .split(/\r?\n/)
    .find((line) => {
      const candidate = line.trim();
      return candidate.length > 0 && !/^(?:branch(?:\s+name)?|name)\s*:\s*$/i.test(candidate);
    })
    ?.trim()
    .replace(/^(?:branch(?:\s+name)?|name)\s*:\s*/i, "")
    .trim() ?? "";
  return trimMatchingCharacters(candidate, QUOTE_CHARACTERS).trim();
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
    .map((segment) => trimMatchingCharacters(
      segment.replace(/-{2,}/g, "-"),
      BRANCH_SEGMENT_EDGE_CHARACTERS,
    ).replace(/\.lock$/i, "-lock"))
    .filter(Boolean);

  const truncated = segments
    .join("/")
    .slice(0, 100);
  return trimTrailingCharacters(truncated, BRANCH_NAME_TRAILING_CHARACTERS)
    .split("/")
    .map((segment) => segment.replace(/\.lock$/i, "-lock"))
    .join("/");
};
