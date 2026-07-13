import type { ProjectRecord } from "@buildwarden/shared";
import type { CurrentProjectBranchStatus } from "./use-project-branches";

export const projectSidebarContext = (
  project: ProjectRecord | null,
  currentBranch: string,
  branchStatus: CurrentProjectBranchStatus,
): string => {
  if (!project) return "No project selected";
  if (project.kind === "folder") return "Folder";
  if (branchStatus === "loading") return "Loading branch…";
  if (branchStatus === "detached") return "Detached HEAD";
  if (branchStatus === "unavailable") return "Branch unavailable";
  return currentBranch || "Branch unavailable";
};
