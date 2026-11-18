const previousReportPrefix = "No new answer was produced in this turn. Previous report (from an earlier result):\n\n";
const isNoAnswer = (summary: string | null): boolean =>
  !summary?.trim() || summary.trim() === "No output returned from the provider." || /^(?:Claude Code|Codex|ACP agent) run completed\.$/.test(summary.trim());

/** Keep earlier evidence labelled while publishing the new outcome and workspace snapshot. */
export const publishedFollowUpSummary = (summary: string | null, previous: string | null): string | null => {
  if (isNoAnswer(summary)) {
    let report = previous;
    while (report?.startsWith(previousReportPrefix)) report = report.slice(previousReportPrefix.length);
    return isNoAnswer(report) ? null : previousReportPrefix + report;
  }
  return summary;
};
