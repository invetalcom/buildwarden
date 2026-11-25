import { describe, expect, it } from "vitest";
import { HostNotRunningError, type HostControlRequest } from "./control-protocol";
import { runningHostPid, waitForService } from "./service-start";

const hosts = (...pids: Array<number | null>) => (async () => {
  const pid = pids.length > 1 ? pids.shift() : pids[0];
  if (pid === null) throw new HostNotRunningError("not running");
  return { pid };
}) as unknown as HostControlRequest;

describe("waitForService", () => {
  it("waits until a new host answers", async () => {
    expect(await waitForService(hosts(null, 2), null)).toBe(true);
    expect(await waitForService(hosts(null, 2), 1)).toBe(true);
  });

  it("does not mistake a host that was already running for the service", async () => {
    await expect(waitForService(hosts(1), 1)).rejects.toThrow("another BuildWarden host (process 1)");
  });

  it("does not wait for a host that hangs, and treats a failing one as not running", async () => {
    const hanging = (() => new Promise(() => undefined)) as unknown as HostControlRequest;
    const failing = (async () => { throw new Error("BuildWarden closed the connection before it answered."); }) as unknown as HostControlRequest;
    expect(await runningHostPid(hanging, 1)).toBeNull();
    expect(await runningHostPid(failing)).toBeNull();
    expect(await waitForService(hanging, null, 5)).toBe(false);
  });

  it("recovers a host that hung before the restart", async () => {
    let restarted = false;
    const host = (() => restarted ? Promise.resolve({ pid: 2 }) : new Promise(() => undefined)) as unknown as HostControlRequest;
    const previousPid = await runningHostPid(host, 1);
    restarted = true;
    expect(await waitForService(host, previousPid)).toBe(true);
  });

  it("gives up when no host answers", async () => {
    expect(await waitForService(hosts(null), null, 1)).toBe(false);
    expect(await runningHostPid(hosts(null))).toBeNull();
  });
});
