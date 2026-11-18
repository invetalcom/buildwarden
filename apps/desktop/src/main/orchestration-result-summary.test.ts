import { expect, it } from "vitest";
import { publishedFollowUpSummary } from "./orchestration-result-summary";

it.each(["Claude Code", "Codex", "ACP agent"])("preserves earlier evidence for %s", (provider) => {
  const result = publishedFollowUpSummary(provider + " run completed.", "Found a bug");
  expect(result).toContain("Previous report (from an earlier result):\n\nFound a bug");
  expect(publishedFollowUpSummary(null, result)).toBe(result);
});
it("keeps new reports and does not invent prior evidence", () => {
  expect(publishedFollowUpSummary("Fixed it", "Old report")).toBe("Fixed it");
  expect(publishedFollowUpSummary(null, null)).toBeNull();
});

it.each(["Claude Code", "Codex", "ACP agent"])("preserves earlier evidence after %s cancellation", (provider) => {
  const cancelled = provider + " run cancelled.";
  expect(publishedFollowUpSummary(cancelled, "Found a bug")).toContain("Previous report (from an earlier result):\n\nFound a bug");
  expect(publishedFollowUpSummary(cancelled, null)).toBeNull();
  expect(publishedFollowUpSummary(null, cancelled)).toBeNull();
});

it.each(["No output returned from the provider.", "   "])("retains the prior report for %s", (summary) => {
  expect(publishedFollowUpSummary(summary, "Earlier evidence")).toContain("Previous report (from an earlier result):\n\nEarlier evidence");
});

it.each(["No output returned from the provider.", "Claude Code run completed.", "Codex run completed.", "ACP agent run completed.", "   "])("never promotes the placeholder %s to earlier evidence", (placeholder) => {
  expect(publishedFollowUpSummary(placeholder, null)).toBeNull();
  expect(publishedFollowUpSummary(null, placeholder)).toBeNull();
  const legacyReport = "No new answer was produced in this turn. Previous report (from an earlier result):\n\n" + placeholder;
  expect(publishedFollowUpSummary(placeholder, legacyReport)).toBeNull();
  expect(publishedFollowUpSummary(null, publishedFollowUpSummary(placeholder, null))).toBeNull();
});
