/** Keep earlier evidence labelled while publishing the new outcome and workspace snapshot. */
export const publishedFollowUpSummary = (summary: string | null, previous: string | null): string | null => {
  if (!summary || /^(?:Claude Code|Codex|ACP agent) run completed\.$/.test(summary.trim())) {
    const prefix = "No new answer was produced in this turn. Previous report (from an earlier result):\n\n";
    return previous ? prefix + (previous.startsWith(prefix) ? previous.slice(prefix.length) : previous) : summary;
  }
  return summary;
};
