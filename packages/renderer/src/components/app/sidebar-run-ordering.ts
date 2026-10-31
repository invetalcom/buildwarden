import type { RunListItem } from "@buildwarden/shared";

export const recentRunOrderTimestamp = (run: Pick<RunListItem, "lastUserInputAt" | "createdAt">) =>
  new Date(run.lastUserInputAt ?? run.createdAt).getTime();
