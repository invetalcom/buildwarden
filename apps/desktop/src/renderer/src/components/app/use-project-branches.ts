import {
  GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE,
  isDetachedHeadProjectErrorMessage,
  type DesktopApi,
  type ProjectSnapshot,
} from "@buildwarden/shared";
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { reportRendererError } from "../../lib/report-renderer-error";
import { pickProjectBranch } from "./app-model";

interface UseProjectBranchesInput {
  buildwarden: DesktopApi | undefined;
  selectedProject: ProjectSnapshot | null;
  setError: Dispatch<SetStateAction<string | null>>;
}

export type CurrentProjectBranchStatus = "not-applicable" | "loading" | "attached" | "detached" | "unavailable";

interface CurrentProjectBranchState {
  projectId: string | null;
  branch: string;
  status: CurrentProjectBranchStatus;
}

const readCurrentProjectBranch = async (buildwarden: DesktopApi, projectId: string): Promise<string | null> => {
  try {
    return await buildwarden.getProjectCurrentBranch(projectId);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (isDetachedHeadProjectErrorMessage(message)) {
      return null;
    }
    throw caught;
  }
};

const errorMessage = (caught: unknown): string => caught instanceof Error ? caught.message : String(caught) || "Unexpected error";

export const useProjectBranches = ({ buildwarden, selectedProject, setError }: UseProjectBranchesInput) => {
  const [availableRunBranches, setAvailableRunBranches] = useState<string[]>([]);
  const [currentProjectBranchState, setCurrentProjectBranchState] = useState<CurrentProjectBranchState>({
    projectId: null,
    branch: "",
    status: "not-applicable",
  });
  const [detachedCheckoutBranch, setDetachedCheckoutBranch] = useState("");
  const [projectCheckoutBusy, setProjectCheckoutBusy] = useState(false);
  const [runBaseBranch, setRunBaseBranch] = useState("");
  const selectedProjectId = selectedProject?.project.id ?? null;
  const selectedProjectIdRef = useRef(selectedProjectId);
  const branchLoadRequestRef = useRef(0);
  selectedProjectIdRef.current = selectedProjectId;
  const currentProjectBranchMatchesSelection = currentProjectBranchState.projectId === selectedProjectId;
  const currentProjectBranch = currentProjectBranchMatchesSelection ? currentProjectBranchState.branch : "";
  const currentProjectBranchStatus: CurrentProjectBranchStatus = currentProjectBranchMatchesSelection
    ? currentProjectBranchState.status
    : selectedProject?.project.kind === "git"
      ? "loading"
      : "not-applicable";

  const loadProjectBranches = useCallback(async () => {
    const requestId = ++branchLoadRequestRef.current;
    const requestedProjectId = selectedProject?.project.id ?? null;
    const isLatestRequest = () =>
      requestId === branchLoadRequestRef.current && requestedProjectId === selectedProjectIdRef.current;

    if (!buildwarden || !selectedProject) {
      setAvailableRunBranches([]);
      setRunBaseBranch("");
      setCurrentProjectBranchState({ projectId: null, branch: "", status: "not-applicable" });
      setDetachedCheckoutBranch("");
      return;
    }
    if (selectedProject.project.kind === "folder") {
      setAvailableRunBranches([]);
      setRunBaseBranch("");
      setCurrentProjectBranchState({ projectId: selectedProject.project.id, branch: "", status: "not-applicable" });
      setDetachedCheckoutBranch("");
      setError((previous) => (previous && isDetachedHeadProjectErrorMessage(previous) ? null : previous));
      return;
    }

    const projectId = selectedProject.project.id;
    const defaultBranch = selectedProject.project.defaultBranch;
    setCurrentProjectBranchState({ projectId, branch: "", status: "loading" });
    const applyDetachedHeadState = (branches: string[]) => {
      setAvailableRunBranches(branches);
      setRunBaseBranch((current) => pickProjectBranch(branches, defaultBranch, current));
      setCurrentProjectBranchState({ projectId, branch: "", status: "detached" });
      setError(GIT_PROJECT_NOT_ON_NAMED_BRANCH_MESSAGE);
      setDetachedCheckoutBranch(pickProjectBranch(branches, defaultBranch));
    };

    try {
      const branches = await buildwarden.getProjectBranches(projectId);
      if (!isLatestRequest()) {
        return;
      }
      const nextBranches = branches.length > 0 ? branches : [defaultBranch];
      const currentBranch = await readCurrentProjectBranch(buildwarden, projectId);
      if (!isLatestRequest()) {
        return;
      }
      if (!currentBranch) {
        applyDetachedHeadState(nextBranches);
        return;
      }
      setDetachedCheckoutBranch("");
      setCurrentProjectBranchState({ projectId, branch: currentBranch, status: "attached" });
      setAvailableRunBranches(nextBranches);
      setRunBaseBranch((current) => pickProjectBranch(nextBranches, defaultBranch, current));
      setError((previous) => (previous && isDetachedHeadProjectErrorMessage(previous) ? null : previous));
    } catch (caught) {
      if (!isLatestRequest()) {
        return;
      }
      reportRendererError("renderer.project-branches.load", caught, { projectId });
      setDetachedCheckoutBranch("");
      setAvailableRunBranches([defaultBranch]);
      setRunBaseBranch(defaultBranch);
      setCurrentProjectBranchState({ projectId, branch: defaultBranch, status: "unavailable" });
      setError(errorMessage(caught));
    }
  }, [buildwarden, selectedProject, setError]);

  useEffect(() => {
    void loadProjectBranches();
  }, [loadProjectBranches]);

  const submitCheckoutDetachedProjectBranch = useCallback(async () => {
    if (!buildwarden || !selectedProject?.project.id || !detachedCheckoutBranch.trim()) {
      return;
    }
    setProjectCheckoutBusy(true);
    try {
      await buildwarden.checkoutProjectBranch(selectedProject.project.id, detachedCheckoutBranch.trim());
      await loadProjectBranches();
    } catch (caught) {
      reportRendererError("renderer.project-branch.checkout", caught, {
        projectId: selectedProject.project.id,
        branchName: detachedCheckoutBranch.trim(),
      });
      setError(caught instanceof Error ? caught.message : "Checkout failed");
    } finally {
      setProjectCheckoutBusy(false);
    }
  }, [buildwarden, detachedCheckoutBranch, loadProjectBranches, selectedProject, setError]);

  return {
    availableRunBranches,
    currentProjectBranch,
    currentProjectBranchStatus,
    detachedCheckoutBranch,
    loadProjectBranches,
    projectCheckoutBusy,
    runBaseBranch,
    setDetachedCheckoutBranch,
    setRunBaseBranch,
    submitCheckoutDetachedProjectBranch,
  };
};
