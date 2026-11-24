import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "@buildwarden/shared";
import { AppServiceContext } from "./services/app-service";
import { type RunEnded, RunEndedNotifier } from "./services/run-ended-notifier";

const ended: RunEnded = { run: { id: "run-1" } as RunRecord, status: "completed", turnFinished: true, waitingForSubagents: false, failureReason: null };

const createNotifier = () => {
  const logError = vi.fn();
  const context = Object.assign(Object.create(AppServiceContext.prototype) as AppServiceContext, { logControllerError: logError });
  return { notifier: new RunEndedNotifier(context, {}), logError };
};

describe("RunEndedNotifier", () => {
  it("tells listeners in order and waits for each one", async () => {
    const { notifier } = createNotifier();
    const calls: string[] = [];
    notifier.setListeners([
      ["slow", { onRunEnded: async () => { await Promise.resolve(); calls.push("slow"); } }],
      ["next", { onRunEnded: () => { calls.push("next"); } }],
    ]);
    await notifier.notify(ended);
    expect(calls).toEqual(["slow", "next"]);
  });

  it("runs listeners without asynchronous work in the same tick", () => {
    const { notifier } = createNotifier();
    const first = vi.fn();
    const second = vi.fn();
    notifier.setListeners([["first", { onRunEnded: first }], ["second", { onRunEnded: second }]]);
    void notifier.notify(ended);
    expect(first).toHaveBeenCalledWith(ended);
    expect(second).toHaveBeenCalledWith(ended);
  });

  it("logs a failing listener and continues with the others", async () => {
    const { notifier, logError } = createNotifier();
    const after = vi.fn();
    notifier.setListeners([
      ["throws", { onRunEnded: () => { throw new Error("sync"); } }],
      ["rejects", { onRunEnded: async () => { throw new Error("async"); } }],
      ["after", { onRunEnded: after }],
    ]);
    await notifier.notify(ended);
    expect(after).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenLastCalledWith(expect.any(String), expect.any(Error), { runId: "run-1", service: "rejects" });
  });
});
