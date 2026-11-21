/** @vitest-environment happy-dom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi, PrWatchView, RunForgeRequestSummary, RunPrWatchCandidates } from "@buildwarden/shared";
import { BuildWardenClientProvider } from "../../lib/buildwarden-client";
import { createElectronBuildWardenClient } from "../../lib/buildwarden-client-core";
import { RunPrWatchControl } from "./RunPrWatchControl";
import { resolveManualRequestUrl } from "./pr-watch-ui";

const PR_URL = "https://github.com/acme/app/pull/12";
const summary: RunForgeRequestSummary = {
  provider: "github", number: 12, title: "Redesign cards", url: PR_URL, state: "open", readiness: "pending", draft: false,
  mergeability: "mergeable", reviewDecision: "none", author: "dev", sourceBranch: "feat/cards", sourceRepository: "acme/app",
  targetBranch: "main", headSha: "abc", checks: { completed: 1, total: 2, successful: 1, failed: 0, running: 1 },
  unresolvedThreadCount: 0, supportedActions: ["refresh"], supportedMergeMethods: ["merge"], updatedAt: null,
  lastSyncedAt: "2026-11-21T10:00:00.000Z", stale: false, syncError: null,
};
const request = (number: number, sourceBranch = "feat/cards") => ({
  provider: "github" as const, number, title: `Request ${String(number)}`, url: `https://github.com/acme/app/pull/${String(number)}`, state: "open",
  draft: false, author: "dev", sourceBranch, sourceRepository: "acme/app", targetBranch: "main", createdAt: null, updatedAt: null,
});
const candidates: RunPrWatchCandidates = {
  workspaceBranch: "feat/cards",
  linked: summary,
  linkSource: "auto",
  error: null,
  candidates: [
    { request: request(12), watchable: true, reason: null, watchedByRunId: null },
    { request: request(14), watchable: true, reason: null, watchedByRunId: null },
    { request: request(15, "other"), watchable: false, reason: 'Its branch "other" is not checked out in this run\'s workspace.', watchedByRunId: null },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement;
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  root = null;
});

const render = async (watch: PrWatchView | null = null) => {
  const api = {
    getRunPrWatchCandidates: vi.fn<DesktopApi["getRunPrWatchCandidates"]>().mockResolvedValue(candidates),
    setRunForgeLink: vi.fn<DesktopApi["setRunForgeLink"]>().mockResolvedValue(summary),
    startPrWatch: vi.fn<DesktopApi["startPrWatch"]>().mockResolvedValue({} as PrWatchView),
    stopPrWatch: vi.fn<DesktopApi["stopPrWatch"]>().mockResolvedValue(null),
    resumePrWatch: vi.fn<DesktopApi["resumePrWatch"]>().mockResolvedValue({} as PrWatchView),
  };
  const client = createElectronBuildWardenClient(api as unknown as DesktopApi);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <BuildWardenClientProvider client={client}>
      <RunPrWatchControl runId="run-1" summary={summary} watch={watch} showBadge readOnly={false} onOpenRequest={vi.fn()} />
    </BuildWardenClientProvider>,
  ));
  return api;
};

const buttonByText = (text: string) => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);

describe("RunPrWatchControl", () => {
  it("confirms the linked request before watching it", async () => {
    const api = await render();
    expect(container.textContent).toContain("PR #12");
    await act(async () => buttonByText("Watch")!.click());
    expect(document.body.textContent).toContain("Watch PR #12");
    expect(document.body.textContent).toContain("Redesign cards");
    expect(document.body.textContent).toContain("Linked automatically by branch");
    expect(api.getRunPrWatchCandidates).toHaveBeenCalledWith("run-1");

    const conflicts = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("Merge conflicts"))!;
    await act(async () => conflicts.click());
    const watchButtons = [...document.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Watch");
    await act(async () => watchButtons.at(-1)!.click());
    expect(api.startPrWatch).toHaveBeenCalledWith("run-1", { prUrl: PR_URL, options: { checks: true, feedback: true, conflicts: false } });
  });

  it("lets the user switch to another request on the branch, and explains the ones it cannot watch", async () => {
    const api = await render();
    await act(async () => buttonByText("Watch")!.click());
    await act(async () => buttonByText("Change PR")!.click());
    const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(2);
    expect(radios[1]!.disabled).toBe(true);
    expect(document.body.textContent).toContain('Its branch "other" is not checked out');
    await act(async () => radios[0]!.click());
    expect(api.setRunForgeLink).toHaveBeenCalledWith("run-1", "https://github.com/acme/app/pull/14");
  });

  it("shows a paused watch's reason and resumes it", async () => {
    const api = await render({
      runId: "run-1", projectId: "p", prUrl: PR_URL, prNumber: 12, provider: "github", status: "paused",
      options: { checks: true, feedback: true, conflicts: true }, message: "Push failed: rejected.", endReason: null,
      wakeCount: 2, attemptsOnHead: 1, attemptHeadSha: "abc", lastCheckedAt: null, lastWakeAt: null, pending: null,
      lastResult: null, attention: null, createdAt: "2026-11-21T10:00:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z",
    });
    await act(async () => buttonByText("Watch paused")!.click());
    expect(document.body.textContent).toContain("Push failed: rejected.");
    expect(document.body.textContent).toContain("2 of 5 wakes used");
    await act(async () => buttonByText("Resume")!.click());
    expect(api.resumePrWatch).toHaveBeenCalledWith("run-1");
  });
});

describe("resolveManualRequestUrl", () => {
  it("turns a number into the linked host's URL and accepts full URLs", () => {
    expect(resolveManualRequestUrl("#14", PR_URL)).toBe("https://github.com/acme/app/pull/14");
    expect(resolveManualRequestUrl("!7", "https://gitlab.com/g/p/-/merge_requests/3")).toBe("https://gitlab.com/g/p/-/merge_requests/7");
    expect(resolveManualRequestUrl("https://github.com/acme/app/pull/20", null)).toBe("https://github.com/acme/app/pull/20");
    expect(resolveManualRequestUrl("14", null)).toBeNull();
    expect(resolveManualRequestUrl("not a url", PR_URL)).toBeNull();
  });
});
