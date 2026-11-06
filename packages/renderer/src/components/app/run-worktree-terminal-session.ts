import { parseScopedId, scopedId } from "../../lib/instance-identity";

/**
 * Host-scoped terminal identities. Omitting terminalId preserves the legacy default terminal.
 * The host records the run owner independently of the terminal suffix.
 */
export const runWorktreeTerminalSessionId = (runId: string, terminalId?: string): string => {
  const owner = parseScopedId(runId);
  const suffix = terminalId ? `:${terminalId}` : "";
  return owner ? scopedId(owner.instanceId, `buildwarden-run-terminal:${owner.id}${suffix}`) : `buildwarden-run-terminal:${runId}${suffix}`;
};
