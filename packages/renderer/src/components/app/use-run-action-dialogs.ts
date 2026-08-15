import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  AppSnapshot,
  ContinueRunInput,
  DesktopApi,
  RunPublishOptions,
  RunRecord,
} from "@buildwarden/shared";
import { harnessTypeForProvider, isRunContinuable } from "./app-model";

export interface RunActionDialogDeps {
  buildwarden: DesktopApi | undefined;
  snapshot: AppSnapshot;
  runYoloMode: boolean;
  handleAction: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
  /** Reload snapshot + run detail and refocus the run pane after a run-mutating action. */
  onRunMutated: (runId: string, projectId: string) => Promise<void>;
  /** Select and focus the freshly created continuation run. */
  onRunContinued: (newRunId: string, projectId: string) => Promise<void>;
}

const requireBridge = (buildwarden: DesktopApi | undefined): DesktopApi => {
  if (!buildwarden) {
    throw new Error("The Electron desktop bridge is unavailable.");
  }
  return buildwarden;
};

const isPlainEnter = (event: ReactKeyboardEvent<Element>): boolean =>
  event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;

/** Commit dialog: commit the run worktree with a user-edited (or AI-suggested) message. */
const useCommitDialog = (deps: RunActionDialogDeps) => {
  const { buildwarden, handleAction, setError } = deps;
  const [commitDialogRun, setCommitDialogRun] = useState<RunRecord | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitSuggestBusy, setCommitSuggestBusy] = useState(false);

  const openCommitDialog = (run: RunRecord) => {
    const normalizedPrompt = run.prompt.replace(/\s+/g, " ").trim();
    const suggestedMessage = `buildwarden: ${normalizedPrompt.slice(0, 60) || "apply run changes"}${normalizedPrompt.length > 60 ? "..." : ""}`;
    setCommitDialogRun(run);
    setCommitMessage(suggestedMessage);
  };

  const closeCommitDialog = () => {
    setCommitDialogRun(null);
    setCommitMessage("");
  };

  const suggestCommitMessageWithAi = async () => {
    if (!commitDialogRun || !buildwarden) {
      return;
    }

    setCommitSuggestBusy(true);
    setError(null);
    try {
      const text = await buildwarden.suggestCommitMessage(commitDialogRun.id);
      setCommitMessage(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate commit message.");
    } finally {
      setCommitSuggestBusy(false);
    }
  };

  const submitCommitRun = async () => {
    if (!commitDialogRun) {
      return;
    }

    await handleAction(async () => {
      const bridge = requireBridge(buildwarden);

      const trimmedMessage = commitMessage.trim();
      if (!trimmedMessage) {
        throw new Error("Enter a commit message.");
      }

      await bridge.commitRun(commitDialogRun.id, trimmedMessage);
      await deps.onRunMutated(commitDialogRun.id, commitDialogRun.projectId);
      closeCommitDialog();
    });
  };

  const handleCommitDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommitDialog();
      return;
    }

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submitCommitRun();
    }
  };

  return {
    commitDialogRun,
    commitMessage,
    setCommitMessage,
    commitSuggestBusy,
    openCommitDialog,
    closeCommitDialog,
    handleCommitDialogKeyDown,
    suggestCommitMessageWithAi,
    submitCommitRun,
  };
};

/** Continue dialog: start a follow-on run from a finished run, optionally carrying workspace changes. */
const useContinueRunDialog = (deps: RunActionDialogDeps) => {
  const { buildwarden, snapshot, handleAction } = deps;
  const [continueDialogRun, setContinueDialogRun] = useState<RunRecord | null>(null);
  const [continuePrompt, setContinuePrompt] = useState("");
  const [continueModelId, setContinueModelId] = useState("");
  const [continueIncludeWorkspaceChanges, setContinueIncludeWorkspaceChanges] = useState(true);

  const openContinueRunDialog = (run: RunRecord) => {
    if (!isRunContinuable(run)) {
      return;
    }
    setContinueDialogRun(run);
    setContinuePrompt("");
    setContinueModelId(run.modelId);
    setContinueIncludeWorkspaceChanges(true);
  };

  const closeContinueRunDialog = () => {
    setContinueDialogRun(null);
    setContinuePrompt("");
    setContinueModelId("");
    setContinueIncludeWorkspaceChanges(true);
  };

  const submitContinueRun = async () => {
    const sourceRun = continueDialogRun;
    if (!sourceRun) {
      return;
    }

    await handleAction(async () => {
      const bridge = requireBridge(buildwarden);
      if (!isRunContinuable(sourceRun)) {
        throw new Error("Wait for this run to finish before starting a continuation.");
      }

      const selectedModel = snapshot.models.find((model) => model.id === continueModelId);
      if (!selectedModel) {
        throw new Error("Select a configured model before starting a continuation.");
      }

      const selectedProvider = snapshot.providerAccounts.find((provider) => provider.id === selectedModel.providerAccountId);
      if (!selectedProvider) {
        throw new Error("The selected model is missing its provider configuration.");
      }

      const payload: ContinueRunInput = {
        sourceRunId: sourceRun.id,
        providerAccountId: selectedModel.providerAccountId,
        modelId: selectedModel.id,
        harnessType: harnessTypeForProvider(selectedProvider.providerType),
        mode: sourceRun.mode,
        prompt: continuePrompt.trim(),
        goalText: sourceRun.goalText,
        includeWorkspaceChanges: continueIncludeWorkspaceChanges,
        yoloMode: deps.runYoloMode,
      };
      const newRun = await bridge.continueRun(payload);
      closeContinueRunDialog();
      await deps.onRunContinued(newRun.id, sourceRun.projectId);
    });
  };

  return {
    continueDialogRun,
    continuePrompt,
    setContinuePrompt,
    continueModelId,
    setContinueModelId,
    continueIncludeWorkspaceChanges,
    setContinueIncludeWorkspaceChanges,
    openContinueRunDialog,
    closeContinueRunDialog,
    submitContinueRun,
  };
};

/** Publish dialog: create a PR/MR from the run branch with a generated or edited description. */
const usePublishDialog = (deps: RunActionDialogDeps) => {
  const { buildwarden, handleAction, setError } = deps;
  const [publishDialogRun, setPublishDialogRun] = useState<RunRecord | null>(null);
  const [publishOptions, setPublishOptions] = useState<RunPublishOptions | null>(null);
  const [pullRequestTitle, setPullRequestTitle] = useState("");
  const [pullRequestTargetBranch, setPullRequestTargetBranch] = useState("");
  const [pullRequestSourceBranchMode, setPullRequestSourceBranchMode] = useState<"worktree" | "custom">("worktree");
  const [pullRequestSourceBranchName, setPullRequestSourceBranchName] = useState("");
  const [pullRequestCommitMessage, setPullRequestCommitMessage] = useState("");
  const [pullRequestDescription, setPullRequestDescription] = useState("");
  const [pullRequestDraftBusy, setPullRequestDraftBusy] = useState(false);

  const closePublishDialog = () => {
    setPublishDialogRun(null);
    setPublishOptions(null);
    setPullRequestTitle("");
    setPullRequestTargetBranch("");
    setPullRequestSourceBranchMode("worktree");
    setPullRequestSourceBranchName("");
    setPullRequestCommitMessage("");
    setPullRequestDescription("");
    setPullRequestDraftBusy(false);
  };

  const openPublishDialog = async (run: RunRecord) => {
    await handleAction(async () => {
      const bridge = requireBridge(buildwarden);

      const options = await bridge.getRunPublishOptions(run.id);
      setPublishDialogRun(run);
      setPublishOptions(options);
      setPullRequestTitle(options.suggestedTitle);
      setPullRequestTargetBranch(options.defaultTargetBranch);
      setPullRequestSourceBranchMode("worktree");
      setPullRequestSourceBranchName(options.defaultSourceBranch);
      setPullRequestCommitMessage(options.defaultCommitMessage);
      setPullRequestDescription(options.defaultDescription);
    });
  };

  const generatePullRequestDraft = async () => {
    if (!publishDialogRun || !buildwarden) {
      return;
    }

    setPullRequestDraftBusy(true);
    setError(null);
    try {
      const draft = await buildwarden.suggestRunPullRequestDraft(
        publishDialogRun.id,
        pullRequestTargetBranch.trim(),
      );
      setPullRequestTitle(draft.title);
      if (draft.commitMessage) {
        setPullRequestCommitMessage(draft.commitMessage);
      }
      setPullRequestDescription(draft.description);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate the merge request or pull request draft.");
    } finally {
      setPullRequestDraftBusy(false);
    }
  };

  const submitPullRequest = async () => {
    if (!publishDialogRun) {
      return;
    }

    await handleAction(async () => {
      const bridge = requireBridge(buildwarden);

      const trimmedTitle = pullRequestTitle.trim();
      const trimmedTargetBranch = pullRequestTargetBranch.trim();
      const trimmedSourceBranch = pullRequestSourceBranchName.trim();
      const trimmedCommitMessage = pullRequestCommitMessage.trim();

      if (!trimmedTitle) {
        throw new Error("Enter a merge request or pull request title.");
      }

      if (!trimmedTargetBranch) {
        throw new Error("Select a target branch.");
      }

      if (publishOptions?.hasOpenChanges && !trimmedCommitMessage) {
        throw new Error("Enter a commit message for the open changes.");
      }

      if (pullRequestSourceBranchMode === "custom") {
        if (!trimmedSourceBranch) {
          throw new Error("Enter a custom source branch name.");
        }
        if (trimmedSourceBranch === publishOptions?.defaultSourceBranch) {
          throw new Error("The custom source branch must differ from the current worktree branch.");
        }
      }

      await bridge.createRunPullRequest(
        publishDialogRun.id,
        trimmedTargetBranch,
        trimmedTitle,
        pullRequestSourceBranchMode === "custom" ? trimmedSourceBranch : undefined,
        pullRequestDescription.trim(),
        publishOptions?.hasOpenChanges ? trimmedCommitMessage : undefined,
      );
      await deps.onRunMutated(publishDialogRun.id, publishDialogRun.projectId);
      closePublishDialog();
    });
  };

  const handlePublishDialogKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLButtonElement | HTMLDivElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePublishDialog();
      return;
    }

    if (event.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (isPlainEnter(event)) {
      event.preventDefault();
      void submitPullRequest();
    }
  };

  return {
    publishDialogRun,
    publishOptions,
    pullRequestTitle,
    setPullRequestTitle,
    pullRequestTargetBranch,
    setPullRequestTargetBranch,
    pullRequestSourceBranchMode,
    setPullRequestSourceBranchMode,
    pullRequestSourceBranchName,
    setPullRequestSourceBranchName,
    pullRequestCommitMessage,
    setPullRequestCommitMessage,
    pullRequestDescription,
    setPullRequestDescription,
    pullRequestDraftBusy,
    openPublishDialog,
    closePublishDialog,
    handlePublishDialogKeyDown,
    generatePullRequestDraft,
    submitPullRequest,
  };
};

/** Branch-publish dialog: push the run branch to the remote or create a local branch from it. */
const useBranchPublishDialog = (deps: RunActionDialogDeps) => {
  const { buildwarden, handleAction, setError } = deps;
  const [branchPublishDialogRun, setBranchPublishDialogRun] = useState<RunRecord | null>(null);
  const [branchPublishName, setBranchPublishName] = useState("");
  const [branchPublishMode, setBranchPublishMode] = useState<"publish" | "local">("publish");
  const [branchSuggestBusy, setBranchSuggestBusy] = useState(false);
  const branchSuggestionRequestRef = useRef(0);

  const openBranchPublishDialog = (run: RunRecord, mode: "publish" | "local") => {
    branchSuggestionRequestRef.current += 1;
    setBranchSuggestBusy(false);
    setBranchPublishDialogRun(run);
    setBranchPublishName(run.branchName);
    setBranchPublishMode(mode);
  };

  const closeBranchPublishDialog = () => {
    branchSuggestionRequestRef.current += 1;
    setBranchSuggestBusy(false);
    setBranchPublishDialogRun(null);
    setBranchPublishName("");
    setBranchPublishMode("publish");
  };

  const suggestBranchNameWithAi = async () => {
    if (!branchPublishDialogRun || branchPublishMode !== "local" || !buildwarden) {
      return;
    }

    const requestId = branchSuggestionRequestRef.current + 1;
    branchSuggestionRequestRef.current = requestId;
    setBranchSuggestBusy(true);
    setError(null);
    try {
      const branchName = await buildwarden.suggestRunBranchName(branchPublishDialogRun.id);
      if (branchSuggestionRequestRef.current !== requestId) return;
      setBranchPublishName(branchName);
    } catch (e) {
      if (branchSuggestionRequestRef.current !== requestId) return;
      setError(e instanceof Error ? e.message : "Could not generate a branch name.");
    } finally {
      if (branchSuggestionRequestRef.current === requestId) {
        setBranchSuggestBusy(false);
      }
    }
  };

  const publishBranch = async () => {
    if (!branchPublishDialogRun) {
      return;
    }

    await handleAction(async () => {
      const bridge = requireBridge(buildwarden);

      const trimmedBranchName = branchPublishName.trim();
      if (!trimmedBranchName) {
        throw new Error("Enter a branch name.");
      }

      if (branchPublishMode === "local") {
        if (branchPublishDialogRun.workspaceType !== "worktree" && trimmedBranchName === branchPublishDialogRun.branchName) {
          throw new Error("The new local branch must differ from the current worktree branch.");
        }
        await bridge.createRunLocalBranch(branchPublishDialogRun.id, trimmedBranchName);
      } else {
        await bridge.publishRunBranch(branchPublishDialogRun.id, trimmedBranchName);
      }
      await deps.onRunMutated(branchPublishDialogRun.id, branchPublishDialogRun.projectId);
      closeBranchPublishDialog();
    });
  };

  const handleBranchPublishDialogKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLButtonElement | HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeBranchPublishDialog();
      return;
    }

    if (!(event.target instanceof HTMLButtonElement) && isPlainEnter(event)) {
      event.preventDefault();
      void publishBranch();
    }
  };

  return {
    branchPublishDialogRun,
    branchPublishName,
    setBranchPublishName,
    branchPublishMode,
    branchSuggestBusy,
    openBranchPublishDialog,
    closeBranchPublishDialog,
    handleBranchPublishDialogKeyDown,
    suggestBranchNameWithAi,
    publishBranch,
  };
};

/**
 * Owns the commit / publish / branch-publish / continue dialog state for runs.
 * All dialogs share the pattern: open with a run, edit draft fields, submit via
 * the desktop bridge, then refresh snapshot + run detail through `onRunMutated`.
 */
export const useRunActionDialogs = (deps: RunActionDialogDeps) => ({
  ...useCommitDialog(deps),
  ...useContinueRunDialog(deps),
  ...usePublishDialog(deps),
  ...useBranchPublishDialog(deps),
});
