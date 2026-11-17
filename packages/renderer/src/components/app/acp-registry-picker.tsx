import { useState } from "react";
import type { AcpRegistryAgent } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

export function AcpRegistryPicker({ onSelect }: { onSelect: (command: string) => void }) {
  const client = useBuildWardenClient();
  const [agents, setAgents] = useState<AcpRegistryAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { setAgents(await client.listAcpRegistryAgents()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="col-span-full flex flex-wrap items-center gap-2 text-xs">
    <Button type="button" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Browse ACP registry"}</Button>
    {agents.length > 0 ? <Select value={selected} placeholder="Choose a package-based agent" searchable options={agents.map((agent) => ({ value: agent.id, label: agent.name, description: agent.description }))} onValueChange={(value) => {
      setSelected(value);
      const agent = agents.find((entry) => entry.id === value);
      if (agent) onSelect(agent.command);
    }} /> : null}
    <span className="text-[var(--ec-muted)]">Choosing fills the command. Saving and connecting installs its pinned npm package through npx.</span>
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
