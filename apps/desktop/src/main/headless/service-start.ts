import { setTimeout as delay } from "node:timers/promises";
import { HostNotRunningError, type HostControlRequest } from "./control-protocol";

const SERVICE_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/** The process that answers for this data directory, or null when none does. */
export const runningHostPid = async (request: HostControlRequest): Promise<number | null> => {
  try {
    return (await request("status")).pid;
  } catch (error) {
    if (error instanceof HostNotRunningError) return null;
    throw error;
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
    const pid = await runningHostPid(request);
    if (pid !== null && pid === previousPid) {
      throw new Error(`The service could not start: another BuildWarden host (process ${String(pid)}) uses this data directory. Stop it with \`buildwarden stop\`, then run \`buildwarden service install\` again.`);
    }
    if (pid !== null) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
};
