import { DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD } from "@buildwarden/shared";
import { createContext, useContext, type ReactNode } from "react";

const PastedTextAttachmentThresholdContext = createContext(DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD);

export interface PastedTextAttachmentThresholdProviderProps {
  threshold: number;
  children: ReactNode;
}

export const PastedTextAttachmentThresholdProvider = ({
  threshold,
  children,
}: PastedTextAttachmentThresholdProviderProps) => (
  <PastedTextAttachmentThresholdContext.Provider value={threshold}>
    {children}
  </PastedTextAttachmentThresholdContext.Provider>
);

// The hook intentionally shares the private context with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const usePastedTextAttachmentThreshold = (): number =>
  useContext(PastedTextAttachmentThresholdContext);
