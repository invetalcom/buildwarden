import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { BuildWardenClientProvider, Button, InstanceContextProvider, ModalDialog, RemoteHostProjectDialog, setActiveBuildWardenClient, parseScopedId, type BuildWardenClient, type InstanceContextValue } from "@buildwarden/renderer";
import { pairingDetailsFromFragment } from "../remote-pairing-code";
import { InstanceManager } from "./instance-manager";
import { FederatedWorkspace } from "./federated-client";
import { InstanceSettings } from "./InstanceSettings";
import "./integrated-instances.css";

/** Connection infrastructure only: the existing app remains the only navigation shell. */
export const IntegratedRemoteApp = ({ children }: { children: (client: BuildWardenClient, manage: () => void) => ReactNode }) => {
  const [manager] = useState(() => new InstanceManager({ cookieOrigin: import.meta.env.VITE_WEB_MODE === "hosted" ? undefined : window.location.origin }));
  const [workspace] = useState(() => new FederatedWorkspace(manager));
  const registry = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  useSyncExternalStore(workspace.subscribe, workspace.getVersion);
  const [hint] = useState(() => { const pairing = pairingDetailsFromFragment(); return { ...pairing, hostOrigin: pairing.hostOrigin || (import.meta.env.VITE_WEB_MODE === "hosted" ? "" : window.location.origin) }; });
  const [manage, setManage] = useState(Boolean(hint.code));
  const [addProject, setAddProject] = useState<string | null>(null);
  const activeId = workspace.activeInstanceId;
  const client = useMemo(() => workspace.client(activeId), [workspace, activeId]);
  const projectHost = registry.instances.find((entry) => entry.connection.id === addProject);
  const initialized = registry.instances.some((entry) => entry.snapshot);
  useEffect(() => { void manager.start(); return manager.stop; }, [manager]);
  useEffect(() => { setActiveBuildWardenClient(client); return () => setActiveBuildWardenClient(null); }, [client]);
  const context: InstanceContextValue = {
    activeInstanceId: activeId,
    instances: registry.instances.map((entry) => ({ id: entry.connection.id, name: entry.connection.name,
      label: registry.instances.some((other) => other.connection.id !== entry.connection.id && other.connection.name.toLocaleLowerCase() === entry.connection.name.toLocaleLowerCase()) ? `${entry.connection.name} · ${new URL(entry.connection.hostOrigin).host}` : entry.connection.name,
      status: entry.status, readOnly: !entry.client?.capabilities.mutations,
    })),
    selectInstance: workspace.selectInstance,
    manageInstances: () => setManage(true),
    addProject: () => setAddProject(activeId),
    clientForEntity: (id) => workspace.client(parseScopedId(id)?.instanceId ?? activeId),
  };
  const settings = <InstanceSettings instances={registry.instances} manager={manager} hint={hint} showHeading={!initialized} onAddProject={(id) => { setAddProject(id); setManage(false); }} onPaired={() => setManage(false)} />;
  if (!registry.loaded) return <main className="bw-instance-gate" role="status">Connecting to BuildWarden instances…</main>;
  if (!initialized) return <main className="bw-instance-gate">{registry.error && <p role="alert">{registry.error}</p>}{settings}</main>;
  return <InstanceContextProvider value={context}><BuildWardenClientProvider client={client}>
    {children(client, context.manageInstances)}
    {manage && <ModalDialog className="bw-instance-dialog" onClose={() => setManage(false)} title={
      <span className="flex items-center justify-between gap-3">
        <span>Connected instances</span>
        <Button variant="ghost" size="sm" onClick={() => setManage(false)}>Close</Button>
      </span>
    }>
      {settings}
    </ModalDialog>}
    {addProject && projectHost?.client && <RemoteHostProjectDialog client={projectHost.client} open onClose={() => setAddProject(null)} onProjectAdded={() => { void manager.refresh(projectHost.connection.id); setAddProject(null); }} />}
  </BuildWardenClientProvider></InstanceContextProvider>;
};
