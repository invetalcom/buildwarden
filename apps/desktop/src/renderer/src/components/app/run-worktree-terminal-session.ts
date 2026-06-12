/**
 * One PTY per run for the app lifetime (survives switching to another run and back).
 * Must match `runTerminalSessionIdForRun` in main.
 */
export const runWorktreeTerminalSessionId = (runId: string): string => `buildwarden-run-terminal:${runId}`;
