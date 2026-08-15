/** @vitest-environment happy-dom */

import type { AppSnapshot, DesktopApi, RunRecord } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useRunActionDialogs, type RunActionDialogDeps } from "./use-run-action-dialogs";

const snapshot = {
  projects: [],
  providerAccounts: [],
  models: [],
  runs: [],
  chats: [],
  bookmarks: [],
  chatBookmarks: [],
  settings: {},
  selectedProjectId: null,
  selectedRunId: null,
} as unknown as AppSnapshot;

const run = (id: string, branchName: string): RunRecord => ({
  id,
  projectId: "project-1",
  branchName,
  workspaceType: "worktree",
} as RunRecord);

const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

let latestDialogs: ReturnType<typeof useRunActionDialogs> | null = null;
const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

const HookHarness = ({ deps }: { deps: RunActionDialogDeps }) => {
  latestDialogs = useRunActionDialogs(deps);
  return null;
};

const dialogs = () => {
  if (!latestDialogs) throw new Error("The dialog hook is not mounted.");
  return latestDialogs;
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  latestDialogs = null;
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("useRunActionDialogs branch suggestions", () => {
  it("ignores a stale suggestion after another run opens", async () => {
    const firstSuggestion = deferred<string>();
    const secondSuggestion = deferred<string>();
    const suggestRunBranchName = vi.fn((runId: string) =>
      runId === "run-1" ? firstSuggestion.promise : secondSuggestion.promise);
    const deps: RunActionDialogDeps = {
      buildwarden: { suggestRunBranchName } as unknown as DesktopApi,
      snapshot,
      runYoloMode: false,
      handleAction: async (action) => action(),
      setError: vi.fn(),
      onRunMutated: vi.fn(async () => undefined),
      onRunContinued: vi.fn(async () => undefined),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => root.render(<HookHarness deps={deps} />));

    await act(async () => dialogs().openBranchPublishDialog(run("run-1", "feat/first"), "local"));
    let firstRequest!: Promise<void>;
    await act(async () => {
      firstRequest = dialogs().suggestBranchNameWithAi();
      await Promise.resolve();
    });

    await act(async () => dialogs().openBranchPublishDialog(run("run-2", "feat/second"), "local"));
    let secondRequest!: Promise<void>;
    await act(async () => {
      secondRequest = dialogs().suggestBranchNameWithAi();
      await Promise.resolve();
    });

    await act(async () => {
      firstSuggestion.resolve("feat/stale");
      await firstRequest;
    });
    expect(dialogs().branchPublishName).toBe("feat/second");
    expect(dialogs().branchSuggestBusy).toBe(true);

    await act(async () => {
      secondSuggestion.resolve("feat/current");
      await secondRequest;
    });
    expect(dialogs().branchPublishName).toBe("feat/current");
    expect(dialogs().branchSuggestBusy).toBe(false);
  });
});

describe("useRunActionDialogs pull request publishing", () => {
  it("passes the configured commit message when publishing open changes", async () => {
    const createRunPullRequest = vi.fn(async () => "https://example.test/pull/1");
    const suggestRunPullRequestDraft = vi.fn(async () => ({
      title: "Generated PR title",
      commitMessage: "Generated commit message",
      description: "## Summary\n\nGenerated description",
    }));
    const deps: RunActionDialogDeps = {
      buildwarden: {
        getRunPublishOptions: vi.fn(async () => ({
          defaultTargetBranch: "main",
          defaultSourceBranch: "feat/open-changes",
          defaultDescription: "Default description",
          defaultCommitMessage: "Commit open changes",
          hasOpenChanges: true,
          suggestedTitle: "Publish open changes",
          targetBranches: ["main"],
        })),
        suggestRunPullRequestDraft,
        createRunPullRequest,
      } as unknown as DesktopApi,
      snapshot,
      runYoloMode: false,
      handleAction: async (action) => action(),
      setError: vi.fn(),
      onRunMutated: vi.fn(async () => undefined),
      onRunContinued: vi.fn(async () => undefined),
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push({ root, container });
    await act(async () => root.render(<HookHarness deps={deps} />));

    await act(async () => dialogs().openPublishDialog(run("run-1", "feat/open-changes")));
    expect(dialogs().pullRequestCommitMessage).toBe("Commit open changes");

    await act(async () => dialogs().generatePullRequestDraft());
    expect(dialogs().pullRequestTitle).toBe("Generated PR title");
    expect(dialogs().pullRequestCommitMessage).toBe("Generated commit message");
    expect(dialogs().pullRequestDescription).toContain("Generated description");

    await act(async () => dialogs().submitPullRequest());

    expect(createRunPullRequest).toHaveBeenCalledWith(
      "run-1",
      "main",
      "Generated PR title",
      undefined,
      "## Summary\n\nGenerated description",
      "Generated commit message",
    );
  });
});
