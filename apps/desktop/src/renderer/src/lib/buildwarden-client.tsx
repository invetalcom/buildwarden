import { createContext, useContext, type ReactNode } from "react";
import type { BuildWardenClient } from "./buildwarden-client-core";

const BuildWardenClientContext = createContext<BuildWardenClient | null>(null);

export interface BuildWardenClientProviderProps {
  client: BuildWardenClient;
  children: ReactNode;
}

export const BuildWardenClientProvider = ({ client, children }: BuildWardenClientProviderProps) => (
  <BuildWardenClientContext.Provider value={client}>{children}</BuildWardenClientContext.Provider>
);

// The hook intentionally shares the private context with its provider.
// eslint-disable-next-line react-refresh/only-export-components
export const useBuildWardenClient = (): BuildWardenClient => {
  const client = useContext(BuildWardenClientContext);
  if (!client) {
    throw new Error("BuildWardenClientProvider is missing");
  }
  return client;
};
