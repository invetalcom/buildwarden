import { parseScopedId, scopedId } from "../../lib/instance-identity";

/**
 * One PTY per run for the app lifetime (survives switching to another run and back).
 * Must match `runTerminalSessionIdForRun` in main.
 */
export const runWorktreeTerminalSessionId = (runId: string): string => {
  const owner = parseScopedId(runId);
  return owner ? scopedId(owner.instanceId, `buildwarden-run-terminal:${owner.id}`) : `buildwarden-run-terminal:${runId}`;
};
