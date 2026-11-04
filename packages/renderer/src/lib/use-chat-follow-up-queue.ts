import { useCallback, useEffect, useState } from "react";
import {
  providerSupportsFollowUpSteering,
  resolveFollowUpDelivery,
  type FollowUpChatOptions,
  type FollowUpDelivery,
  type FollowUpQueueAction,
  type FollowUpQueueResult,
  type ProviderType,
  type QueuedFollowUpRecord,
} from "@buildwarden/shared";
import { useBuildWardenClient } from "./buildwarden-client";
import { useFollowUpDeliveryPreference } from "./follow-up-delivery-settings";
import { describeFollowUpQueueNotice } from "../components/app/follow-up-queue-notice";

/**
 * Follow-up queue state for one chat: live entries from the chat detail (bridged by the
 * latest action result), delivery resolution, and queue actions with inline notices.
 */
export const useChatFollowUpQueue = ({
  chatId,
  serverQueue,
  active,
  providerType,
}: {
  chatId: string | null;
  serverQueue: QueuedFollowUpRecord[] | undefined;
  active: boolean;
  providerType: ProviderType | undefined;
}) => {
  const client = useBuildWardenClient();
  const preference = useFollowUpDeliveryPreference();
  const [localQueue, setLocalQueue] = useState<{ chatId: string; queue: QueuedFollowUpRecord[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Live events refresh the detail's queue; the local copy only bridges the gap after an action.
  useEffect(() => setLocalQueue(null), [serverQueue]);
  useEffect(() => setNotice(null), [chatId]);

  const queue = (chatId && localQueue?.chatId === chatId ? localQueue.queue : serverQueue) ?? [];
  /** New messages join the queue while a turn runs or entries are held, so ordering holds. */
  const queues = Boolean(chatId) && (active || queue.length > 0);
  const steeringAvailable = active && providerSupportsFollowUpSteering(providerType);

  const applyResult = useCallback((id: string, result: FollowUpQueueResult) => {
    setLocalQueue({ chatId: id, queue: result.queue });
    setNotice(describeFollowUpQueueNotice(result));
  }, []);

  const queueFollowUp = useCallback(async (prompt: string, options: FollowUpChatOptions, delivery: FollowUpDelivery) => {
    if (!chatId) throw new Error("The chat has not started yet.");
    applyResult(chatId, await client.queueChatFollowUp(chatId, prompt, options, delivery));
  }, [applyResult, chatId, client]);

  const updateQueue = useCallback(async (action: FollowUpQueueAction) => {
    if (!chatId) return;
    try {
      applyResult(chatId, await client.updateChatFollowUpQueue(chatId, action));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Could not update the queue.");
      throw caught;
    }
  }, [applyResult, chatId, client]);

  return {
    queue,
    queues,
    steeringAvailable,
    primaryDelivery: resolveFollowUpDelivery(preference, steeringAvailable),
    alternateDelivery: resolveFollowUpDelivery(preference, steeringAvailable, true),
    notice,
    setNotice,
    queueFollowUp,
    updateQueue,
  };
};
