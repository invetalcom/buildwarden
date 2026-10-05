import type { DesktopApi, RunDetail } from "@buildwarden/shared";

/** Loading state is client-only; callers discard updates from obsolete requests. */
export const loadRunDiff = async (
  client: Pick<DesktopApi, "getRunWorktreeDiff">,
  runId: string,
  update: (patch: Partial<RunDetail>) => void,
): Promise<void> => {
  update({ diffPending: true });
  try {
    const result = await client.getRunWorktreeDiff(runId);
    update({
      diff: result.diff,
      diffRevision: result.diffRevision ?? null,
      diffLoaded: true,
      diffPending: false,
      diffLoadError: null,
      worktreeUnavailable: result.worktreeUnavailable,
    });
  } catch (error) {
    // Keep the last patch for inspection, but never present it as current.
    update({
      diffRevision: null,
      diffLoaded: true,
      diffPending: false,
      diffLoadError: error instanceof Error ? error.message || "Could not load changes." : "Could not load changes.",
    });
  }
};
