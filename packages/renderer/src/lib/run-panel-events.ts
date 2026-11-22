/**
 * Asks the run page showing `runId` to close its file viewer. The viewer's state lives inside the
 * run page, while the "hide side panels" control sits in the app shell.
 */
export const RUN_CLOSE_FILE_PANEL_EVENT = "buildwarden:close-run-file-panel";

export const requestRunFilePanelClose = (runId: string): void => {
  window.dispatchEvent(new CustomEvent<{ runId: string }>(RUN_CLOSE_FILE_PANEL_EVENT, { detail: { runId } }));
};
