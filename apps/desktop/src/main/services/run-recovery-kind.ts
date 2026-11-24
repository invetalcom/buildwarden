/** How an interrupted run can be recovered, if at all. A checkpoint wins over a saved provider session. */
export const resolveRecoveryKind = (
  providerRecoverySupported: boolean,
  hasCheckpoint: boolean,
  hasResumeCursor: boolean,
): "checkpoint" | "provider-session" | null => {
  if (!providerRecoverySupported) {
    return null;
  }
  if (hasCheckpoint) {
    return "checkpoint";
  }
  return hasResumeCursor ? "provider-session" : null;
};
