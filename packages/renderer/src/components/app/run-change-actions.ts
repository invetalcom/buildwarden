import type { RunDetail } from "@buildwarden/shared";

export type RunWorkspaceChangeState = "unknown" | "clean" | "dirty";

export const resolveRunWorkspaceChangeState = (
  runDetail: Pick<RunDetail, "diff" | "diffLoaded" | "diffSummary" | "diffSummaryPending"> | null,
): RunWorkspaceChangeState => {
  if (!runDetail || runDetail.diffSummaryPending === true) return "unknown";
  if (runDetail.diffSummary) return runDetail.diffSummary.totalFiles > 0 ? "dirty" : "clean";
  if (runDetail.diffLoaded === true) return runDetail.diff.trim() ? "dirty" : "clean";
  return "unknown";
};

export const deriveRunChangeActionAvailability = ({
  changeState,
  hasCommit,
  canManageChanges,
}: Readonly<{
  changeState: RunWorkspaceChangeState;
  hasCommit: boolean;
  canManageChanges: boolean;
}>) => ({
  canCommit: canManageChanges && changeState === "dirty",
  canPublish: canManageChanges && changeState === "clean" && hasCommit,
  canCreateLocalBranch: canManageChanges && (changeState === "dirty" || hasCommit),
});
