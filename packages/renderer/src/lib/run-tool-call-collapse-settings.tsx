import { DEFAULT_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD } from "@buildwarden/shared";
import { createContext, useContext, type ReactNode } from "react";

const RunToolCallCollapseThresholdContext = createContext(DEFAULT_CONSECUTIVE_TOOL_CALL_COLLAPSE_THRESHOLD);

export interface RunToolCallCollapseThresholdProviderProps {
  threshold: number;
  children: ReactNode;
}

export const RunToolCallCollapseThresholdProvider = ({
  threshold,
  children,
}: RunToolCallCollapseThresholdProviderProps) => (
  <RunToolCallCollapseThresholdContext.Provider value={threshold}>
    {children}
  </RunToolCallCollapseThresholdContext.Provider>
);

// The hook intentionally shares the private context with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const useRunToolCallCollapseThreshold = (): number =>
  useContext(RunToolCallCollapseThresholdContext);
