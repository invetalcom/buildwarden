/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BuildWardenClient } from "@buildwarden/renderer";
import type { ProjectGitBranchInfo, ProjectGitBranchOverview } from "@buildwarden/shared";
import { MobileAppProvider, type MobileAppValue } from "../../data/mobile-app-context";
import { ProjectBranchesPanel } from "./ProjectBranchesPanel";

let root: Root | undefined;
let container: HTMLDivElement;
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); });

const branch = (name: string, overrides: Partial<ProjectGitBranchInfo> = {}): ProjectGitBranchInfo => ({
  name, isCurrent: false, isBase: false, hasLocal: true, hasRemote: false, upstream: null, ahead: 0, behind: 0,
  commitSha: "abc1234", updatedAt: null, subject: `Work on ${name}`, mergedIntoBase: true, linkedRunCount: 0, worktreePath: null, ...overrides,
});
const overview = (branches: ProjectGitBranchInfo[]): ProjectGitBranchOverview => ({
  repoPath: "/repo", baseBranch: "main", currentBranch: "main", provider: "github", webBaseUrl: null, remoteName: "origin", baseCompareRef: "main",
  branches,
});
const initial = overview([branch("main", { isCurrent: true, isBase: true }), branch("feature"), branch("remote-only", { hasLocal: false, hasRemote: true })]);

const render = async (overrides: Partial<Record<keyof BuildWardenClient, unknown>> = {}, gitMutations = true) => {
  const client = {
    capabilities: { platform: "web", gitMutations },
    getProjectBranchOverview: vi.fn(async () => initial),
    ...overrides,
  } as unknown as BuildWardenClient;
  const value = { client, snapshot: { projects: [] }, snapshotStore: { refresh: vi.fn() }, router: {} } as unknown as MobileAppValue;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root?.render(<MobileAppProvider value={value}><ProjectBranchesPanel projectId="p" /></MobileAppProvider>));
  return client;
};

const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim().startsWith(text));
const tap = async (element: HTMLElement | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => element!.click());
};

describe("mobile project branches", () => {
  it("creates a branch from the chosen source and checks it out", async () => {
    const createProjectBranch = vi.fn(async () => ({ ...initial, currentBranch: "feature/new" }));
    await render({ createProjectBranch });

    await tap(button("New branch"));
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "feature/new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tap(button("Create branch"));

    expect(createProjectBranch).toHaveBeenCalledWith("p", { branchName: "feature/new", startPoint: "main", checkout: true });
    expect(container.textContent).toContain("Created and checked out feature/new.");
  });

  it("checks out an existing branch and tracks a remote-only branch", async () => {
    const checkoutProjectBranch = vi.fn(async () => undefined);
    await render({ checkoutProjectBranch });

    await tap(button("feature"));
    // The sheet portals out of the animated tab, so the tab bar and New run button cannot cover it.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Check out");
    await tap(button("Check out"));
    expect(checkoutProjectBranch).toHaveBeenCalledWith("p", "feature");

    await tap(button("remote-only"));
    await tap(button("Check out tracking origin/remote-only"));
    expect(checkoutProjectBranch).toHaveBeenLastCalledWith("p", "remote-only");
  });

  it("deletes a branch after showing linked run impact", async () => {
    const deleteProjectBranch = vi.fn(async () => overview([branch("main", { isCurrent: true, isBase: true })]));
    const getProjectBranchDeleteImpact = vi.fn(async () => ({ branchName: "feature", linkedRuns: [{ id: "r1" }] }));
    await render({ deleteProjectBranch, getProjectBranchDeleteImpact });

    await tap(button("feature"));
    await tap(button("Delete branch"));
    expect(document.body.textContent).toContain("Also deletes 1 linked agent run");
    await tap([...document.body.querySelectorAll<HTMLButtonElement>("footer button")].find((candidate) => candidate.textContent === "Delete branch"));

    expect(deleteProjectBranch).toHaveBeenCalledWith("p", { branchName: "feature", force: false });
    expect(container.textContent).toContain("Deleted feature.");
    expect(container.textContent).not.toContain("Work on feature");
  });

  it("keeps the list read-only without git write access", async () => {
    await render({}, false);
    expect(button("New branch")).toBeUndefined();
    expect(container.querySelectorAll("button[type=button]").length).toBe(2);
  });
});
