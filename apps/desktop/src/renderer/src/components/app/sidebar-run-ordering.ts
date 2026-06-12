import type { RunRecord } from "@buildwarden/shared";

export const recentRunOrderTimestamp = (run: Pick<RunRecord, "lastUserInputAt" | "createdAt">) =>
  new Date(run.lastUserInputAt ?? run.createdAt).getTime();
