import { setTimeout as delay } from "node:timers/promises";
import type { HostControlRequest, HostStatus } from "./control-protocol";

const SERVICE_START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const STATUS_TIMEOUT_MS = 5_000;

/** Null when no host answers in time. One that hangs or fails cannot hold up the installation. */
const hostStatus = async (request: HostControlRequest, timeoutMs: number): Promise<HostStatus | null> => {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      request("status").catch(() => null),
      delay(timeoutMs, null, { signal: timeout.signal }),
    ]);
  } finally {
    timeout.abort();
  }
};

/**
 * systemd reports a service as started before the host had a chance to fail, and a host that was started
 * in another way may own the data directory. So the host that answers has to come from the service's
 * current start, which systemd identifies with an invocation id.
 */
export const waitForService = async (
  request: HostControlRequest,
  serviceInvocationId: () => Promise<string>,
  timeoutMs = SERVICE_START_TIMEOUT_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const host = await hostStatus(request, Math.min(STATUS_TIMEOUT_MS, deadline - Date.now()));
    if (host) {
      if (host.invocationId && host.invocationId === await serviceInvocationId()) return true;
      throw new Error(`The service could not start: another BuildWarden host (process ${String(host.pid)}) uses this data directory. Stop it with \`buildwarden stop\`, then run \`buildwarden service install\` again.`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  return false;
};
