import type { RunDetail, RunWorktreeDiffResult } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { loadRunDiff } from "./run-diff-loading";

describe("run diff loading", () => {
  it("keeps a failed refresh visibly stale until a successful retry replaces it", async () => {
    let state: Partial<RunDetail> = { diff: "old patch", diffLoaded: false };
    const update = (patch: Partial<RunDetail>) => { state = { ...state, ...patch }; };
    const client = { getRunWorktreeDiff: vi.fn<() => Promise<RunWorktreeDiffResult>>().mockRejectedValueOnce(new Error("Disconnected")) };

    await loadRunDiff(client, "run-1", update);
    expect(state).toMatchObject({ diff: "old patch", diffLoadError: "Disconnected", diffRevision: null, diffPending: false, diffLoaded: true });

    let finish!: (value: RunWorktreeDiffResult) => void;
    client.getRunWorktreeDiff.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const retry = loadRunDiff(client, "run-1", update);
    expect(state).toMatchObject({ diff: "old patch", diffLoadError: "Disconnected", diffPending: true });
    finish({ diff: "new patch", worktreeUnavailable: false });
    await retry;
    expect(state).toMatchObject({ diff: "new patch", diffLoadError: null, diffPending: false, diffLoaded: true });
    expect(client.getRunWorktreeDiff).toHaveBeenCalledTimes(2);
  });

  it("reports an initial failure without an automatic retry loop or a false empty result", async () => {
    let state: Partial<RunDetail> = { diff: "", diffLoaded: false };
    const client = { getRunWorktreeDiff: vi.fn().mockRejectedValue("offline") };
    await loadRunDiff(client, "run-1", (patch) => { state = { ...state, ...patch }; });
    expect(state).toMatchObject({ diff: "", diffLoaded: true, diffPending: false, diffLoadError: "Could not load changes." });
    expect(client.getRunWorktreeDiff).toHaveBeenCalledTimes(1);
  });
});
