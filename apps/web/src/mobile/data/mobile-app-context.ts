import { createContext, useContext } from "react";
import type { AppSnapshot, UiTheme } from "@buildwarden/shared";
import type { BuildWardenClient } from "@buildwarden/renderer";
import type { MobileRouter } from "../nav/mobile-router";
import type { ApprovalQueue } from "./use-approval-queue";
import type { SnapshotStore } from "./use-snapshot";

export interface MobileAppValue {
  client: BuildWardenClient;
  snapshot: AppSnapshot;
  snapshotStore: SnapshotStore;
  approvals: ApprovalQueue;
  router: MobileRouter;
  theme: UiTheme;
  /** Currently scoped project; drives the app-bar title and the default for new runs. */
  activeProjectId: string | null;
  selectProject: (projectId: string) => void;
  openProjectDrawer: () => void;
  disconnect: (changeHost?: boolean) => Promise<void>;
}

const MobileAppContext = createContext<MobileAppValue | null>(null);

export const MobileAppProvider = MobileAppContext.Provider;

export const useMobileApp = (): MobileAppValue => {
  const value = useContext(MobileAppContext);
  if (!value) {
    throw new Error("MobileAppProvider is missing");
  }
  return value;
};
