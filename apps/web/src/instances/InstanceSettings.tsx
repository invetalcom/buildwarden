import { useState, type FormEvent } from "react";
import { Badge, Button, Input } from "@buildwarden/renderer";
import { AlertTriangle } from "lucide-react";
import type { ConnectedInstance, InstanceManager } from "./instance-manager";
import type { RemotePairingFragment } from "../remote-pairing-code";

export const InstanceSettings = ({ instances, manager, hint, onPaired, onAddProject, showHeading = true }: {
  instances: readonly ConnectedInstance[]; manager: InstanceManager; hint: RemotePairingFragment; onPaired: () => void; onAddProject?: (id: string) => void;
  showHeading?: boolean;
}) => {
  const [name, setName] = useState("");
  const [host, setHost] = useState(hint.hostOrigin);
  const [code, setCode] = useState(hint.code);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const action = async (work: () => Promise<void | string | null>) => {
    setBusy(true); setMessage("");
    try { const result = await work(); if (result) setMessage(result); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const pair = (event: FormEvent) => {
    event.preventDefault();
    void action(async () => { await manager.pair(host, code, name); setCode(""); setName(""); onPaired(); });
  };
  return <section className="bw-instance-settings" aria-label="Manage instances">
    {showHeading && <h2>Connected instances</h2>}
    <p className="bw-secondary">Names are saved for this browser. Adding an instance keeps your other connections.</p>
    {instances.map((instance) => <InstanceSetting key={instance.connection.id} instance={instance} busy={busy}
      onRename={(value) => void action(() => manager.rename(instance.connection.id, value))}
      onRemove={() => void action(() => manager.remove(instance.connection.id))}
      onAddProject={onAddProject ? () => onAddProject(instance.connection.id) : undefined}
      onRetry={() => void action(() => manager.refresh(instance.connection.id))}
      onPair={() => { setHost(instance.connection.hostOrigin); setName(instance.connection.name); setCode(""); }} />)}
    <form className="bw-pair-form" onSubmit={pair}>
      <h3>Add or re-pair an instance</h3>
      <label>Instance name<Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="e.g. Work PC" /></label>
      <label>Host URL<Input value={host} onChange={(event) => setHost(event.target.value)} placeholder="https://device.tailnet.ts.net" autoComplete="url" /></label>
      <label>Pairing code<Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="BW-XXXX-XXXX-XXXX" autoComplete="one-time-code" /></label>
      <p className="bw-secondary">On this desktop instance, open Settings → Network → Remote access and create a {import.meta.env.VITE_WEB_MODE !== "hosted" && host === window.location.origin ? "host-served" : "hosted website"} code. Cross-host connections require this browser origin to be allowed by the target host.</p>
      <Button type="submit" size="sm" disabled={busy || !host.trim() || !code.trim()}>{busy ? "Connecting…" : "Connect instance"}</Button>
    </form>
    {message && <p role="alert">{message}</p>}
  </section>;
};

const InstanceSetting = ({ instance, busy, onRename, onRemove, onRetry, onPair, onAddProject }: {
  instance: ConnectedInstance; busy: boolean; onRename: (name: string) => void; onRemove: () => void; onRetry: () => void; onPair: () => void; onAddProject?: () => void;
}) => {
  const [name, setName] = useState(instance.connection.name);
  const unavailable = instance.status === "offline" || instance.status === "pairing-required";
  const statusLabel = instance.status === "pairing-required" ? "Pairing required" : instance.status === "offline" ? "Offline" : instance.status === "online" ? "Online" : "Connecting";
  return <div className="bw-instance-setting" data-unavailable={unavailable || undefined} role="group" aria-label={`${instance.connection.name}: ${statusLabel}`}>
    <form onSubmit={(event) => { event.preventDefault(); onRename(name); }}>
      <label><span className="bw-instance-label">Instance name<Badge tone={unavailable ? "failed" : instance.status === "online" ? "completed" : "neutral"} dot>{statusLabel}</Badge></span><Input aria-label={`Name for ${instance.connection.hostOrigin}`} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <Button type="submit" variant="secondary" size="sm" disabled={busy || !name.trim() || name.trim() === instance.connection.name}>Save name</Button>
    </form>
    <div className="bw-secondary">{instance.connection.hostOrigin}{instance.status === "online" && ` · ${instance.client?.capabilities.mutations ? "Control" : "Read-only"}`}</div>
    {unavailable ? <p className="bw-instance-error"><AlertTriangle size={16} aria-hidden /><span>{instance.error ?? (instance.status === "offline" ? "Host unavailable. Check that BuildWarden is running and reconnect." : "Session expired or revoked. Pair this instance again.")}</span></p>
      : instance.error && <p className="bw-secondary">{instance.error}</p>}
    <div className="bw-actions">
      {onAddProject && <Button variant="secondary" size="sm" disabled={busy || instance.status !== "online" || !instance.client?.capabilities.projectCreation} onClick={onAddProject}>Add project</Button>}
      <Button variant="secondary" size="sm" disabled={busy} onClick={instance.status === "pairing-required" ? onPair : onRetry}>{instance.status === "pairing-required" ? "Pair again" : "Reconnect"}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>Remove connection</Button>
    </div>
  </div>;
};
