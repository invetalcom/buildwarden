/**
 * Error text for the UI, without Electron's "Error invoking remote method '…':" wrapper. A plain
 * "Error:" prefix goes too; other kinds such as "TypeError:" stay, since they tell a bug apart.
 */
export const formatAppErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
};
