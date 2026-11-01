import { createContext, useContext, type ReactNode } from "react";
import { parseScopedId } from "./instance-identity";
import type { BuildWardenClient } from "./buildwarden-client-core";
import { BuildWardenClientProvider } from "./buildwarden-client";

export interface InstanceSummary {
  id: string;
  name: string;
  label: string;
  status: "connecting" | "online" | "offline" | "pairing-required";
  readOnly: boolean;
}
export interface InstanceContextValue {
  instances: readonly InstanceSummary[];
  activeInstanceId: string | null;
  selectInstance: (id: string) => void;
  manageInstances: () => void;
  addProject: () => void;
  clientForEntity: (entityId: string) => BuildWardenClient;
}
const InstanceContext = createContext<InstanceContextValue | null>(null);
export const InstanceContextProvider = ({ value, children }: { value: InstanceContextValue; children: ReactNode }) => <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>;
// Context and provider intentionally share a module.
// eslint-disable-next-line react-refresh/only-export-components
export const useInstanceContext = () => useContext(InstanceContext);

/** Keep permissions and host-only reads aligned with each detail pane, including split views. */
export const InstanceScope = ({ entityId, children }: { entityId: string; children: ReactNode }) => {
  const context = useInstanceContext();
  return context ? <BuildWardenClientProvider client={context.clientForEntity(entityId)}>{children}</BuildWardenClientProvider> : children;
};

export const InstanceBadge = ({ entityId }: { entityId: string | null | undefined }) => {
  const context = useInstanceContext();
  const owner = context?.instances.find((entry) => entry.id === parseScopedId(entityId)?.instanceId);
  if (!owner) return null;
  return <span className="bw-instance-badge" title={owner.label}>{owner.label}{owner.status !== "online" ? ` · ${owner.status}` : owner.readOnly ? " · Read-only" : ""}</span>;
};

export const InstanceTargetSelector = ({ purpose = "Settings for" }: { purpose?: string }) => {
  const context = useInstanceContext();
  if (!context) return null;
  return <div className="bw-instance-target">
    <label>{purpose}<select aria-label={purpose} value={context.activeInstanceId ?? ""} onChange={(event) => context.selectInstance(event.target.value)}>
      {!context.activeInstanceId && <option value="">Choose instance</option>}
      {context.instances.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} · {entry.status}{entry.readOnly ? " · Read-only" : ""}</option>)}
    </select></label>
    <button type="button" onClick={context.manageInstances}>Manage instances</button>
  </div>;
};
