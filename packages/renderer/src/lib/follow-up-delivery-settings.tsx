import type { FollowUpDelivery } from "@buildwarden/shared";
import { createContext, useContext, type ReactNode } from "react";

const FollowUpDeliveryContext = createContext<FollowUpDelivery>("queue");

export const FollowUpDeliveryProvider = ({ delivery, children }: { delivery: FollowUpDelivery; children: ReactNode }) => (
  <FollowUpDeliveryContext.Provider value={delivery}>{children}</FollowUpDeliveryContext.Provider>
);

/** Preferred delivery for follow-ups sent while the agent works. */
// The hook intentionally shares the private context with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const useFollowUpDeliveryPreference = (): FollowUpDelivery => useContext(FollowUpDeliveryContext);
