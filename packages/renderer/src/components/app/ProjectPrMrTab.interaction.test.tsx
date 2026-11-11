/** @vitest-environment happy-dom */

import type {
  DesktopApi,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestStatus,
} from "@buildwarden/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { ProjectPrMrTab } from "./ProjectPrMrTab";

// The diff body is irrelevant here, and the real renderer needs a browser layout engine.
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

const requestUrl = "https://github.com/acme/widgets/pull/17";

const requestDetails = (): ProjectForgeRequestDetailsResult => ({
  provider: "github",
  webBaseUrl: "https://github.com",
  repoLabel: "acme/widgets",
  request: {
    provider: "github",
    number: 17,
    title: "Improve request actions",
    url: requestUrl,
    state: "open",
    draft: false,
    author: "octocat",
    sourceBranch: "feat/actions",
    targetBranch: "main",
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T13:00:00.000Z",
    description: "Adds project request actions.",
    authorUser: null,
    labels: [],
    additions: 4,
    deletions: 1,
    changedFiles: 1,
    commentCount: 0,
    reviewCommentCount: 0,
  },
  activity: [],
  commits: [],
  files: [],
  reviewThreads: [],
  warnings: [],
});

const readyStatus = (overrides: Partial<ProjectForgeRequestStatus> = {}): ProjectForgeRequestStatus => ({
  state: "open",
  readiness: "ready",
  draft: false,
  mergeability: "mergeable",
  reviewDecision: "approved",
  headSha: "head-sha",
  checks: { completed: 1, total: 1, successful: 1, failed: 0, running: 0 },
  checkRuns: [],
  unresolvedThreadCount: 0,
  supportedActions: ["refresh", "open", "mark-draft", "merge", "close"],
  supportedMergeMethods: ["squash"],
  lastSyncedAt: "2026-08-08T13:00:00.000Z",
  ...overrides,
});

const createApi = (status: ProjectForgeRequestStatus, overrides: Partial<DesktopApi> = {}) => ({
  getProjectForgeAuthStatus: vi.fn(async () => ({
    provider: "github" as const,
    webBaseUrl: "https://github.com",
    repoLabel: "acme/widgets",
    hasToken: true,
  })),
  getProjectForgeRequestDetails: vi.fn(async () => requestDetails()),
  getProjectForgeRequestStatus: vi.fn(async () => status),
  updateProjectForgeRequest: vi.fn(async () => status),
  mergeProjectForgeRequest: vi.fn(async () => status),
  ...overrides,
}) as unknown as DesktopApi;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
let projectSequence = 0;

const normalizedButtonText = (button: HTMLButtonElement) => button.textContent?.replace(/\s+/g, " ").trim();

const getButton = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  .find((button) => normalizedButtonText(button) === label);

const waitForValue = async <T,>(read: () => T | undefined): Promise<T> => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the project PR/MR UI to settle.");
};

const renderProjectRequest = async (api: DesktopApi) => {
  projectSequence += 1;
  const projectId = `project-interaction-${String(projectSequence)}`;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });

  await act(async () => {
    root.render(
      <BuildWardenClientProvider client={createElectronBuildWardenClient(api)}>
        <ProjectPrMrTab
          projectId={projectId}
          modelOptions={[]}
          defaultModelId=""
          initialRequest={{ url: requestUrl, requestId: projectSequence }}
          onOpenProjectSettings={vi.fn()}
        />
      </BuildWardenClientProvider>,
    );
  });

  await waitForValue(() => getButton("Mark draft"));
  return projectId;
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const mounted of mountedRoots.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectPrMrTab request actions", () => {
  it("forwards the request URL and expected HEAD, then applies an updated draft state", async () => {
    const updated = readyStatus({
      readiness: "pending",
      draft: true,
      supportedActions: ["refresh", "open", "mark-ready", "close"],
      supportedMergeMethods: [],
    });
    const updateProjectForgeRequest = vi.fn(async () => updated);
    const api = createApi(readyStatus(), { updateProjectForgeRequest });
    const projectId = await renderProjectRequest(api);

    await act(async () => getButton("Mark draft")!.click());

    await waitForValue(() => getButton("Mark ready"));
    expect(updateProjectForgeRequest).toHaveBeenCalledWith(projectId, {
      prUrl: requestUrl,
      action: "mark-draft",
      expectedHeadSha: "head-sha",
    });
    expect(document.body.textContent).toContain("PR #17 is now a draft.");
  });

  it("forwards the selected merge method and expected HEAD, then applies the merged state", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const merged = readyStatus({
      state: "merged",
      readiness: "merged",
      supportedActions: ["refresh", "open"],
      supportedMergeMethods: [],
    });
    const mergeProjectForgeRequest = vi.fn(async () => merged);
    const api = createApi(readyStatus(), { mergeProjectForgeRequest });
    const projectId = await renderProjectRequest(api);

    await act(async () => getButton("Merge")!.click());
    const squashButton = await waitForValue(() => getButton("squash"));
    await act(async () => squashButton.click());

    await waitForValue(() => document.body.textContent?.includes("PR #17 was merged.") ? true : undefined);
    expect(mergeProjectForgeRequest).toHaveBeenCalledWith(projectId, {
      prUrl: requestUrl,
      method: "squash",
      expectedHeadSha: "head-sha",
    });
    expect(getButton("Merge")).toBeUndefined();
  });

  it("hides merge when the expected HEAD is unavailable", async () => {
    const mergeProjectForgeRequest = vi.fn();
    const api = createApi(readyStatus({ headSha: null }), { mergeProjectForgeRequest });

    await renderProjectRequest(api);

    expect(getButton("Merge")).toBeUndefined();
    expect(mergeProjectForgeRequest).not.toHaveBeenCalled();
  });

  it("renders project request mutation failures", async () => {
    const updateProjectForgeRequest = vi.fn(async () => {
      throw new Error("GitHub denied the request");
    });
    const api = createApi(readyStatus(), { updateProjectForgeRequest });
    await renderProjectRequest(api);

    await act(async () => getButton("Mark draft")!.click());

    await waitForValue(() => document.body.textContent?.includes("GitHub denied the request") ? true : undefined);
    expect(document.body.textContent).toContain("GitHub denied the request");
  });
});

describe("ProjectPrMrTab code map", () => {
  const storageKey = "buildwarden:project-pr-mr-diff-map-view";
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n";
  const toggle = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;

  it("switches Files changed between the diff and a map of the project checkout", async () => {
    const getProjectCodeMap = vi.fn(async () => ({
      files: [{ path: "src/a.ts", lines: 10 }, { path: "src/b.ts", lines: 20 }],
      truncated: false,
      workspaceUnavailable: false,
    }));
    const api = createApi(readyStatus(), {
      fetchProjectPrMrDiff: vi.fn(async () => ({ diff, provider: "github" as const, number: 17, baseRef: "main" })),
      getProjectCodeMap,
    });
    try {
      const projectId = await renderProjectRequest(api);
      const filesTab = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => normalizedButtonText(button)?.startsWith("Files changed"))!;
      await act(async () => filesTab.click());

      const codeMap = () => document.querySelector('[aria-label^="Code map"]');
      const showMap = await waitForValue(() => toggle("Show code map"));
      // The repository is only scanned once the map is actually requested.
      expect(codeMap()).toBeNull();
      expect(getProjectCodeMap).not.toHaveBeenCalled();

      await act(async () => showMap.click());
      await waitForValue(() => document.body.textContent?.includes("2 files") ? true : undefined);
      expect(getProjectCodeMap).toHaveBeenCalledExactlyOnceWith(projectId);
      expect(document.body.textContent).toContain("1 changed");
      expect(codeMap()?.getAttribute("aria-label")).toContain("2 files, 1 changed");
      expect(window.localStorage.getItem(storageKey)).toBe("1");

      await act(async () => toggle("Show the diff")!.click());
      expect(codeMap()).toBeNull();
      expect(toggle("Show code map")).toBeDefined();
      expect(window.localStorage.getItem(storageKey)).toBe("0");

      // Coming back to the map reuses the scan; only the rescan button reads the checkout again.
      await act(async () => toggle("Show code map")!.click());
      await waitForValue(() => document.body.textContent?.includes("2 files") ? true : undefined);
      expect(getProjectCodeMap).toHaveBeenCalledTimes(1);
      await act(async () => toggle("Rescan the repository")!.click());
      await waitForValue(() => getProjectCodeMap.mock.calls.length === 2 ? true : undefined);
      expect(getProjectCodeMap).toHaveBeenLastCalledWith(projectId);
    } finally {
      window.localStorage.removeItem(storageKey);
    }
  });
});
