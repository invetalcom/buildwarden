const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * Remote clients drop trailing `undefined` arguments, but JSON turns an interior one into
 * `null`, so an omitted options object arrives as `null` when a delivery follows it.
 */
const isOmittableRecord = (value: unknown): boolean => value === undefined || value === null || isRecord(value);
const isOptionalDelivery = (value: unknown): boolean =>
  value === undefined || value === null || value === "queue" || value === "steer";

/** `[ownerId, prompt, options?, delivery?]` for queueRunFollowUp / queueChatFollowUp. */
export const isQueueFollowUpRemoteArgs = (args: readonly unknown[]): boolean =>
  args.length >= 2 && args.length <= 4 && typeof args[0] === "string" && typeof args[1] === "string" &&
  isOmittableRecord(args[2]) && isOptionalDelivery(args[3]);

export const isFollowUpQueueAction = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.type === "resume") return true;
  if (typeof value.queuedFollowUpId !== "string") return false;
  if (value.type === "edit") return typeof value.prompt === "string";
  if (value.type === "move") return value.direction === "up" || value.direction === "down";
  return value.type === "delete" || value.type === "send-now";
};

/** `[ownerId, action]` for updateRunFollowUpQueue / updateChatFollowUpQueue. */
export const isUpdateFollowUpQueueRemoteArgs = (args: readonly unknown[]): boolean =>
  args.length === 2 && typeof args[0] === "string" && isFollowUpQueueAction(args[1]);

/** Maps the wire `null` for omitted arguments back to `undefined`. */
export const omittedRemoteArg = <Value>(value: Value | null | undefined): Value | undefined => value ?? undefined;
