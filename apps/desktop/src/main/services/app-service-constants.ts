import type { RunRecord } from "@buildwarden/shared";

export const MAX_DIFF_CHARS_FOR_COMMIT_SUGGEST = 100_000;
export const MAX_DIFF_CHARS_FOR_REVIEW = 140_000;
export const FOLDER_BASELINE_MISSING_REASON = "No folder baseline snapshot is available for this run.";
export const SELECTED_PROJECT_KEY = "selectedProjectId";
export const SELECTED_RUN_KEY = "selectedRunId";
export const SELECTED_CHAT_KEY = "selectedChatId";

/** How a run turn is started. */
export interface RunStartOptions {
  /**
   * BuildWarden starts this turn on its own (an automation, a loop, a delegated task, a PR watch).
   * The project and run the user has open stay the stored selection.
   */
  background?: boolean;
}
export const NETWORK_PROXY_SECRET_KEY = "app:network-proxy-password";
export const ACTIVE_RUN_STATUSES = new Set<RunRecord["status"]>(["queued", "preparing", "running"]);

/** Shown when the app restarts while a run or chat was still marked active in the DB. */
export const SESSION_INTERRUPTED_MESSAGE =
  "This session was interrupted because the app closed before it finished. You can start a new run or send a follow-up.";

export const AZURE_LEGACY_AUTO_RECOVERY_KIND = "Azure Legacy-max-tool-rounds";
