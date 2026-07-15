import { describe, expect, it, vi } from "vitest";
import { HostEventBus } from "./host-events";

describe("HostEventBus", () => {
  it("fans events out to independent transport subscribers and supports disposal", () => {
    const events = new HostEventBus();
    const ipcSubscriber = vi.fn();
    const websocketSubscriber = vi.fn();
    const disposeIpc = events.subscribe("task", ipcSubscriber);
    events.subscribe("task", websocketSubscriber);

    const payload = { projectId: "project-1", taskId: "task-1", status: "in_progress" as const };
    events.publish("task", payload);
    disposeIpc();
    events.publish("task", { ...payload, status: "done" });

    expect(ipcSubscriber).toHaveBeenCalledTimes(1);
    expect(ipcSubscriber).toHaveBeenCalledWith(payload);
    expect(websocketSubscriber).toHaveBeenCalledTimes(2);
  });
});
