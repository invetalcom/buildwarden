/** @vitest-environment happy-dom */

import type { DesktopApi, ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProjectBranchesPage } from "./ProjectBranchesPage";

const branch = (name: string, overrides: Partial<ProjectGitBranchInfo> = {}): ProjectGitBranchInfo => ({
  name,
  isCurrent: false,
  isBase: false,
  hasLocal: true,
  hasRemote: true,
  upstream: `origin/${name}`,
  ahead: 0,
  behind: 0,
  commitSha: "abc1234",
  updatedAt: new Date().toISOString(),
  subject: `Commit on ${name}`,
  authorName: "Ada",
  baseAhead: 1,
  baseBehind: 0,
  mergedIntoBase: false,
  linkedRunCount: 0,
  worktreePath: null,
  ...overrides,
});

const overview = (overrides: Partial<ProjectGitBranchOverview> = {}): ProjectGitBranchOverview => ({
  repoPath: "C:/repo",
  baseBranch: "main",
  currentBranch: "main",
  provider: "github",
  webBaseUrl: "https://github.com/acme/app",
  remoteName: "origin",
  baseCompareRef: "origin/main",
  changedFileCount: 0,
  operation: null,
  conflictedFiles: [],
  branches: [
    branch("main", { isCurrent: true, isBase: true, baseAhead: null, baseBehind: null, ahead: 2 }),
    branch("feature/login"),
    branch("old-fix", { mergedIntoBase: true, baseAhead: 0, baseBehind: 3, hasRemote: false, upstream: null }),
  ],
  ...overrides,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const renderPage = async (api: Partial<DesktopApi>) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient({ getProjectForgeAuthStatus: vi.fn(async () => null), ...api } as unknown as DesktopApi)}>
        <ProjectBranchesPage
          projectId="project-1"
          repoPath="C:/repo"
          baseBranch="main"
          currentBranch="main"
          branches={["main"]}
          busy={false}
          onBranchesChanged={vi.fn()}
        />
      </BuildWardenClientProvider>,
    ),
  );
};

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};

const buttonByText = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);

describe("project branches page", () => {
  it("summarizes the current branch and filters the list", async () => {
    await renderPage({ getProjectBranchOverview: vi.fn(async () => overview()) });

    expect(container?.textContent).toContain("2 to push");
    expect(container?.textContent).toContain("Clean");
    expect(container?.textContent).toContain("Clean up merged (1)");
    expect(container?.querySelectorAll("[data-branch]")).toHaveLength(3);

    await click(buttonByText(container!, "Merged 1"));
    expect([...container!.querySelectorAll("[data-branch]")].map((row) => row.getAttribute("data-branch"))).toEqual(["old-fix"]);
  });

  it("disables renaming a branch that agent runs use", async () => {
    const base = overview();
    await renderPage({
      getProjectBranchOverview: vi.fn(async () => ({
        ...base,
        branches: base.branches.map((entry) => (entry.name === "feature/login" ? { ...entry, linkedRunCount: 1 } : entry)),
      })),
    });

    await click(container?.querySelector('[aria-label="Actions for feature/login"]'));
    const rename = buttonByText(document.body, "Rename…")!;
    expect(rename.getAttribute("aria-disabled")).toBe("true");
    expect(rename.title).toBe("Used by agent runs. Create a new branch instead.");

    // Keyboard users reach the disabled item and its reason; activating it does nothing.
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(rename);
    await click(rename);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("merges a branch into the current branch from the row menu and shows a conflict error in the dialog", async () => {
    const mergeProjectBranch = vi.fn(async () => {
      throw new Error('Merging "feature/login" into "main" stopped on conflicts in a.ts. The merge was aborted.');
    });
    await renderPage({ getProjectBranchOverview: vi.fn(async () => overview()), mergeProjectBranch });

    await click(container?.querySelector('[aria-label="Actions for feature/login"]'));
    await click(buttonByText(document.body, "Merge into main…"));
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("Merge feature/login into main");

    await click(buttonByText(dialog!, "Merge commit"));
    await act(async () => {
      dialog!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mergeProjectBranch).toHaveBeenCalledWith("project-1", { branchName: "feature/login", mode: "no-ff" });
    expect(document.querySelector("dialog [role=alert]")?.textContent).toContain("stopped on conflicts");
  });

  it("moves keyboard focus through the row actions menu and back to its trigger", async () => {
    await renderPage({ getProjectBranchOverview: vi.fn(async () => overview()) });
    const trigger = container!.querySelector<HTMLButtonElement>('[aria-label="Actions for feature/login"]')!;
    const press = (key: string) =>
      act(async () => {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });

    await click(trigger);
    expect(document.activeElement?.textContent).toBe("New branch from here…");
    await press("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Merge into main…");
    await press("ArrowUp");
    await press("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Delete…");

    await press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers to abort a merge that is in progress", async () => {
    const abortProjectGitOperation = vi.fn(async () => overview());
    await renderPage({
      getProjectBranchOverview: vi.fn(async () => overview({ operation: "merge", conflictedFiles: ["src/a.ts"] })),
      abortProjectGitOperation,
    });

    expect(container?.textContent).toContain("Merge in progress");
    expect(container?.textContent).toContain("Conflicts in src/a.ts");

    await click(buttonByText(container!, "Abort merge"));
    expect(abortProjectGitOperation).toHaveBeenCalledWith("project-1");
    expect(container?.textContent).toContain("Aborted the merge.");
  });

  it("shows conflicts without an operation but offers no abort", async () => {
    await renderPage({ getProjectBranchOverview: vi.fn(async () => overview({ operation: null, conflictedFiles: ["src/a.ts"] })) });

    expect(container?.textContent).toContain("Unresolved conflicts");
    expect(container?.textContent).toContain("Conflicts in src/a.ts. Resolve them in your editor or terminal.");
    expect([...container!.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Abort"))).toBe(false);
  });

  it("deletes the selected merged branches during cleanup", async () => {
    const deleteProjectBranch = vi.fn(async () => overview({ branches: overview().branches.slice(0, 2) }));
    await renderPage({ getProjectBranchOverview: vi.fn(async () => overview()), deleteProjectBranch, getProjectBranchDeleteImpact: vi.fn() });

    await click(buttonByText(container!, "Clean up merged (1)"));
    const dialog = document.querySelector("dialog");
    expect(dialog?.textContent).toContain("old-fix");
    await act(async () => {
      dialog!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(deleteProjectBranch).toHaveBeenCalledWith("project-1", { branchName: "old-fix" });
    expect(document.querySelector("dialog")).toBeNull();
    expect(container?.textContent).toContain("Deleted 1 merged branch.");
  });

  it("says the local branch is gone when deleting it on the remote fails", async () => {
    const deleteProjectBranch = vi.fn(async () => overview());
    const deleteProjectRemoteBranch = vi.fn(async () => {
      throw new Error("remote rejected");
    });
    await renderPage({
      getProjectBranchOverview: vi.fn(async () => overview()),
      getProjectBranchDeleteImpact: vi.fn(async () => ({ branchName: "feature/login", linkedRuns: [] })),
      deleteProjectBranch,
      deleteProjectRemoteBranch,
    });

    await click(container?.querySelector('[aria-label="Actions for feature/login"]'));
    await click(buttonByText(document.body, "Delete…"));
    const dialog = document.querySelector("dialog")!;
    await click(dialog.querySelector('[aria-label="Also delete origin/feature/login"]'));
    await act(async () => {
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(deleteProjectRemoteBranch).toHaveBeenCalledWith("project-1", { branchName: "feature/login", force: false });
    expect(dialog.querySelector("[role=alert]")?.textContent).toContain("Deleted feature/login locally, but not on origin. remote rejected");
  });

  it("drops already deleted branches from the cleanup selection after a partial failure", async () => {
    const [main, feature, oldFix] = overview().branches;
    const olderFix = { ...oldFix!, name: "older-fix" };
    const afterPartialCleanup = overview({ branches: [main!, feature!, olderFix] });
    const getProjectBranchOverview = vi.fn().mockResolvedValueOnce(overview({ branches: [main!, feature!, oldFix!, olderFix] })).mockResolvedValue(afterPartialCleanup);
    const deleteProjectBranch = vi.fn(async (_projectId: string, input: { branchName: string }) => {
      if (input.branchName === "older-fix") throw new Error("locked");
      return afterPartialCleanup;
    });
    await renderPage({ getProjectBranchOverview, deleteProjectBranch, getProjectBranchDeleteImpact: vi.fn() });

    await click(buttonByText(container!, "Clean up merged (2)"));
    const dialog = document.querySelector("dialog")!;
    const submit = () => act(async () => {
      dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await submit();

    expect(dialog.textContent).toContain("Deleted 1 of 2 branches.");
    expect(dialog.textContent).toContain("1 of 1 selected");
    expect(buttonByText(dialog, "Delete 1 branch")).toBeTruthy();

    deleteProjectBranch.mockClear();
    await submit();
    expect(deleteProjectBranch.mock.calls.map(([, input]) => input.branchName)).toEqual(["older-fix"]);
  });
});
