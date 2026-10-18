import { normalizeRunSubagentInfo, RUN_CHAT_CONTEXT_SOURCE, type RunEventType } from "@buildwarden/shared";

/** Chat is a conversation, not the execution log. Keep the original events in
 * history, but apply the same presentation rules on desktop and mobile web. */
export const isVisibleChatStep = (
  step: { eventType: RunEventType; content: string },
  metadata: Record<string, unknown>,
): boolean => {
  if (metadata.source === RUN_CHAT_CONTEXT_SOURCE || metadata.subagentId) return false;
  if (metadata.source === "user") return true;
  if (["error", "request", "user-input-requested", "approval-requested", "approval-resolved"].includes(step.eventType)) return true;
  if (metadata.silent === true) return false;
  if (normalizeRunSubagentInfo(metadata.subagent)) return true;
  // An agent inspecting an image is a tool action, not a delivered image.
  // Actual assistant image answers remain visible, even without any text.
  if (metadata.itemType === "imageView") return false;
  return ["output", "plan", "plan-updated"].includes(step.eventType) && Boolean(step.content.trim());
};
