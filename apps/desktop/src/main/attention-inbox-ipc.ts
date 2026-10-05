import type { IpcMain } from "electron";
import { IPC_CHANNELS, isAttentionAcknowledgementBatch, type DesktopApi } from "@buildwarden/shared";

export const registerAttentionInboxIpc = (
  ipc: Pick<IpcMain, "handle">,
  controller: Pick<DesktopApi, "acknowledgeAttentionItem" | "acknowledgeAttentionItems">,
): void => {
  ipc.handle(IPC_CHANNELS.acknowledgeAttentionItem, async (_, itemId: unknown) => {
    if (typeof itemId !== "string") throw new Error("Invalid attention item ID.");
    return controller.acknowledgeAttentionItem(itemId);
  });
  ipc.handle(IPC_CHANNELS.acknowledgeAttentionItems, async (_, itemIds: unknown) => {
    if (!isAttentionAcknowledgementBatch(itemIds)) throw new Error("Invalid attention item IDs.");
    return controller.acknowledgeAttentionItems(itemIds);
  });
};
