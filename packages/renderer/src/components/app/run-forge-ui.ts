import type { RunForgeReadiness, RunForgeRequestDetailsResult } from "@buildwarden/shared";

export const runForgeReadinessLabel: Record<RunForgeReadiness, string> = {
  ready: "Ready to merge",
  pending: "Waiting",
  blocked: "Blocked",
  merged: "Merged",
  closed: "Closed",
  unavailable: "Unavailable",
};

export const runForgeReadinessColor: Record<RunForgeReadiness, string> = {
  ready: "text-emerald-400",
  pending: "text-amber-400",
  blocked: "text-red-400",
  merged: "text-violet-400",
  closed: "text-zinc-500",
  unavailable: "text-zinc-500",
};

export const runForgeReadinessHex: Record<RunForgeReadiness, string> = {
  ready: "#34d399",
  pending: "#fbbf24",
  blocked: "#f87171",
  merged: "#a78bfa",
  closed: "#71717a",
  unavailable: "#71717a",
};

export type RunForgeAgentAction = "feedback" | "checks" | "conflicts";

export const buildRunForgeAgentPrompt = (
  action: RunForgeAgentAction,
  details: RunForgeRequestDetailsResult,
): string => {
  const { summary } = details;
  const label = summary.provider === "github" ? "PR" : "MR";
  if (action === "checks") {
    const failed = details.checks.filter((check) => check.status === "failure" || check.status === "cancelled");
    return [
      `Fix the failed checks on ${label} #${summary.number} (${summary.sourceBranch} -> ${summary.targetBranch}).`,
      "Inspect the failures, make the smallest correct changes, and run relevant validation locally before reporting back.",
      "",
      ...failed.map((check) => `- ${check.name}${check.url ? `: ${check.url}` : ""}`),
    ].join("\n").trim();
  }
  if (action === "conflicts") {
    return [
      `Resolve the merge conflicts on ${label} #${summary.number}.`,
      `Source branch: ${summary.sourceBranch}`,
      `Base branch: ${summary.targetBranch}`,
      "Preserve the intent of both sides, run relevant validation, and summarize any judgment calls. Do not merge the request.",
    ].join("\n");
  }
  const unresolved = details.reviewThreads.filter((thread) => thread.resolved !== true);
  return [
    `Address the unresolved review feedback on ${label} #${summary.number}.`,
    "Make the requested changes in this same workspace and run relevant validation. Do not resolve remote threads automatically; leave that for the user after verification.",
    "",
    ...unresolved.flatMap((thread) => thread.comments.map((comment) => {
      const line = thread.newLineNumber ?? thread.oldLineNumber;
      return `- ${thread.path}${line ? `:${String(line)}` : ""} — ${comment.author?.username ?? "reviewer"}: ${comment.body}`;
    })),
  ].join("\n").trim();
};
