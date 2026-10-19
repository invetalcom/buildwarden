/** Error text for the UI, without Electron's "Error invoking remote method '…': Error:" wrapper. */
export const formatAppErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
};
