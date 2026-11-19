import { describe, expect, it } from "vitest";
import { isManageOwnedProcessesRemoteArgs, isOwnedProcessesRemoteArgs, isOwnedProcessOutputRemoteArgs } from "./remote-args";

const run = { kind: "run", id: "run-1" };
const chat = { kind: "chat", id: "chat-1" };

describe("owned process remote arguments", () => {
  it("accepts an owner for reads and rejects malformed owners", () => {
    expect(isOwnedProcessesRemoteArgs([run])).toBe(true);
    expect(isOwnedProcessesRemoteArgs([{ kind: "project", id: "p" }])).toBe(false);
    expect(isOwnedProcessesRemoteArgs([{ kind: "run", id: "" }])).toBe(false);
    expect(isOwnedProcessesRemoteArgs([run, "extra"])).toBe(false);
    expect(isOwnedProcessOutputRemoteArgs([chat, "4100-1"])).toBe(true);
    expect(isOwnedProcessOutputRemoteArgs([chat, ""])).toBe(false);
    expect(isOwnedProcessOutputRemoteArgs([chat, "x".repeat(129)])).toBe(false);
  });

  it("only lets each manage operation act on its own kind of owner", () => {
    const manageRun = isManageOwnedProcessesRemoteArgs("run");
    const manageChat = isManageOwnedProcessesRemoteArgs("chat");
    expect(manageRun([{ owner: run, action: "stop", processId: "4100-1" }])).toBe(true);
    expect(manageRun([{ owner: run, action: "stop-all" }])).toBe(true);
    // A chat owner sent through the run operation would bypass the chat scope.
    expect(manageRun([{ owner: chat, action: "stop-all" }])).toBe(false);
    expect(manageChat([{ owner: chat, action: "restart", processId: "4100-1" }])).toBe(true);
    expect(manageChat([{ owner: chat, action: "explode" }])).toBe(false);
    expect(manageChat([{ owner: chat, action: "kill" }])).toBe(false);
    expect(manageChat([{ owner: chat, action: "kill", processId: "x".repeat(129) }])).toBe(false);
  });
});
