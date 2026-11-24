export const normalizeSuggestedCommitMessage = (raw: string): string => {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[\w-]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  return t;
};
