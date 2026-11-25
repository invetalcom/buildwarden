import { setTimeout as delay } from "node:timers/promises";
import type { HostControlRequest } from "./control-protocol";

const SERVICE_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const STATUS_TIMEOUT_MS = 5_000;

/**
 * The process that answers for this data directory, or null when none does in time. A host that hangs or
 * fails counts as none: it must not hold up the restart that recovers it.
 */
export const runningHostPid = async (request: HostControlRequest, timeoutMs = STATUS_TIMEOUT_MS): Promise<number | null> => {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      request("status").then(({ pid }) => pid, () => null),
      delay(timeoutMs, null, { signal: timeout.signal }),
    ]);
  } finally {
    timeout.abort();
  }
};

/**
 * systemd reports a service as started before the host had a chance to fail. A restart replaces the
 * service's own process, so a host that answers with the same id as before does not belong to it.
 */
export const waitForService = async (
  request: HostControlRequest,
  previousPid: number | null,
  timeoutMs = SERVICE_START_TIMEOUT_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await runningHostPid(request, Math.min(STATUS_TIMEOUT_MS, deadline - Date.now()));
    if (pid !== null && pid === previousPid) {
      throw new Error(`The service could not start: another BuildWarden host (process ${String(pid)}) uses this data directory. Stop it with \`buildwarden stop\`, then run \`buildwarden service install\` again.`);
    }
    if (pid !== null) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
};
