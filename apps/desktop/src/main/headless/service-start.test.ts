import { describe, expect, it } from "vitest";
import { HostNotRunningError, type HostControlRequest } from "./control-protocol";
import { waitForService } from "./service-start";

const hosts = (...answers: Array<{ pid: number; invocationId?: string | null } | null>) => (async () => {
  const answer = answers.length > 1 ? answers.shift() : answers[0];
  if (!answer) throw new HostNotRunningError("not running");
  return answer;
}) as unknown as HostControlRequest;
const service = { pid: 2, invocationId: "service" };
const invocationId = async () => "service";

describe("waitForService", () => {
  it("waits until the service answers", async () => {
    expect(await waitForService(hosts(null, service), invocationId)).toBe(true);
  });

  it("does not mistake another host for the service, even when it answers late", async () => {
    for (const other of [{ pid: 1 }, { pid: 1, invocationId: null }, { pid: 1, invocationId: "terminal" }]) {
      await expect(waitForService(hosts(other), invocationId)).rejects.toThrow("another BuildWarden host (process 1)");
      await expect(waitForService(hosts(null, other), invocationId)).rejects.toThrow("another BuildWarden host (process 1)");
    }
    await expect(waitForService(hosts({ pid: 1, invocationId: "" }), async () => "")).rejects.toThrow("another BuildWarden host");
  });

  it("gives up when no host answers, or only one that hangs or fails", async () => {
    const hanging = (() => new Promise(() => undefined)) as unknown as HostControlRequest;
    const failing = (async () => { throw new Error("BuildWarden closed the connection before it answered."); }) as unknown as HostControlRequest;
    for (const request of [hosts(null), hanging, failing]) expect(await waitForService(request, invocationId, 5)).toBe(false);
  });
});
