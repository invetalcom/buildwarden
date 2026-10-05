import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT, IPC_CHANNELS } from "@buildwarden/shared";
import { describe, expect, it, vi } from "vitest";
import { registerAttentionInboxIpc } from "./attention-inbox-ipc";

const fixture = () => {
  const ipc = { handle: vi.fn<IpcMain["handle"]>() };
  const controller = {
    acknowledgeAttentionItem: vi.fn(async () => undefined),
    acknowledgeAttentionItems: vi.fn(async () => undefined),
  };
  registerAttentionInboxIpc(ipc, controller);
  const invoke = (channel: string, value: unknown) => {
    const handler = ipc.handle.mock.calls.find(([registered]) => registered === channel)![1];
    return handler({} as IpcMainInvokeEvent, value);
  };
  return { controller, invoke };
};

describe("attention acknowledgement IPC", () => {
  it("rejects malformed single IDs before calling the controller", async () => {
    const { controller, invoke } = fixture();
    for (const value of [undefined, null, 42, {}, ["item"]]) {
      await expect(invoke(IPC_CHANNELS.acknowledgeAttentionItem, value)).rejects.toThrow("Invalid attention item ID.");
    }
    expect(controller.acknowledgeAttentionItem).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.acknowledgeAttentionItem, "item");
    expect(controller.acknowledgeAttentionItem).toHaveBeenCalledExactlyOnceWith("item");
  });

  it("rejects malformed and oversized batches before calling the controller", async () => {
    const { controller, invoke } = fixture();
    for (const value of [undefined, null, 42, {}, "item", ["item", null], Array(ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT + 1).fill("item")]) {
      await expect(invoke(IPC_CHANNELS.acknowledgeAttentionItems, value)).rejects.toThrow("Invalid attention item IDs.");
    }
    expect(controller.acknowledgeAttentionItems).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.acknowledgeAttentionItems, []);
    const ids = Array.from({ length: ATTENTION_ACKNOWLEDGEMENT_BATCH_LIMIT }, (_, index) => `item-${index}`);
    await invoke(IPC_CHANNELS.acknowledgeAttentionItems, ids);
    expect(controller.acknowledgeAttentionItems).toHaveBeenNthCalledWith(1, []);
    expect(controller.acknowledgeAttentionItems).toHaveBeenNthCalledWith(2, ids);
  });
});
