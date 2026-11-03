import type { FollowUpQueueResult } from "@buildwarden/shared";

/** Inline notice for a queue result, or null when the outcome needs no explanation. */
export const describeFollowUpQueueNotice = (result: FollowUpQueueResult | null | undefined): string | null => {
  if (!result) return null;
  if (result.steerError) {
    return result.outcome === "moved-to-front"
      ? `Could not steer: ${result.steerError} It is next in the queue.`
      : `Could not steer: ${result.steerError} It stays queued.`;
  }
  if (result.outcome === "moved-to-front") return "Moved to the front. It sends when the current turn ends.";
  return null;
};
