import { expect, it } from "vitest";
import type { ProjectForgeRequestSummary, RunListItem } from "@buildwarden/shared";
import { eligibleForgeDiscoveryRuns, lightweightForgeSummary } from "./run-forge-policy";

const now = Date.parse("2026-10-31T12:00:00Z");
const run = (id: string, overrides: Partial<RunListItem> = {}): RunListItem => ({
  id, kind: "standard", workspaceVcs: "git", branchName: "feature", listVisibility: "default",
  createdAt: "2026-10-30T12:00:00Z", status: "completed", ...overrides,
} as RunListItem);
const request = { provider: "github", number: 1, url: "https://github.com/a/b/pull/1", title: "PR", state: "open", draft: false, sourceBranch: "feature" } as ProjectForgeRequestSummary;

it("checks recent runs regardless of outcome and old runs only at startup or with an open PR", () => {
  const summary = lightweightForgeSummary(request, null, new Date(now).toISOString());
  const runs = [run("recent"), run("failed", { status: "failed" }), run("cancelled", { status: "cancelled" }),
    run("old", { createdAt: "2020-01-01" }), run("old-open", { createdAt: "2020-01-01", forgeRequest: summary }),
    run("old-merged", { createdAt: "2020-01-01", forgeRequest: { ...summary, state: "merged" } }),
    run("recent-followup", { createdAt: "2020-01-01", lastUserInputAt: "2026-10-30" })];
  expect(eligibleForgeDiscoveryRuns(runs, false, 7, now).map((run) => run.id)).toEqual(["recent", "failed", "cancelled", "old-open", "recent-followup"]);
  expect(eligibleForgeDiscoveryRuns(runs, true, 7, now)).toHaveLength(7);
});

it("excludes hidden runs and their children, non-Git workspaces, and service runs even at startup", () => {
  const runs = [run("later", { listVisibility: "for-later" }), run("child", { kind: "orchestration-task", parentRunId: "later" }),
    run("loop", { kind: "loop-iteration" }), run("automation", { kind: "automation" }), run("lab", { kind: "lab-implementation" }),
    run("files", { workspaceVcs: "folder" }), run("visible-child", { kind: "orchestration-task" })];
  expect(eligibleForgeDiscoveryRuns(runs, true, 7, now).map((run) => run.id)).toEqual(["visible-child"]);
});

it("keeps lightweight state separate from the time detailed status was checked", () => {
  const summary = lightweightForgeSummary(request, null, "first");
  expect(summary.statusLastSyncedAt).toBeNull();
  expect(summary.supportedActions).toEqual(["refresh", "open"]);
  const updated = lightweightForgeSummary({ ...request, state: "merged" }, { ...summary, statusLastSyncedAt: "details" }, "second");
  expect(updated).toMatchObject({ state: "merged", readiness: "merged", lastSyncedAt: "second", statusLastSyncedAt: "details" });
});

it("invalidates cached readiness and write actions when startup discovery finds a draft transition", () => {
  const previous = { ...lightweightForgeSummary(request, null, "before"), readiness: "ready" as const, statusLastSyncedAt: "before", supportedActions: ["merge", "mark-draft"] as const };
  const summary = lightweightForgeSummary({ ...request, draft: true }, { ...previous, supportedActions: [...previous.supportedActions] }, "startup");
  expect(summary).toMatchObject({ draft: true, readiness: "unavailable", statusLastSyncedAt: null, lastSyncedAt: "startup", supportedActions: ["refresh", "open"] });
});
