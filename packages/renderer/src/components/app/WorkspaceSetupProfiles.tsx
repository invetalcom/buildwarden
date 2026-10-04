import { useEffect, useState } from "react";
import { APP_SETTING_KEYS, parseWorkspaceSetupSettings, type ProjectWorkspaceSetup, type WorkspaceSetupProfile } from "@buildwarden/shared";
import type { BuildWardenClient } from "../../lib/buildwarden-client-core";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

export const WorkspaceSetupProfiles = ({ projectId, client }: { projectId: string; client: BuildWardenClient }) => {
  const canEdit = client.capabilities.projectSettingsMutations;
  const [value, setValue] = useState<ProjectWorkspaceSetup>({ activeProfileId: "", profiles: [] });
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    if (!canEdit) return;
    void client.getSnapshot().then((snapshot) => {
      if (!alive) return;
      const config = parseWorkspaceSetupSettings(snapshot.settings[APP_SETTING_KEYS.workspaceSetupProfiles])[projectId] ?? { activeProfileId: "", profiles: [] };
      setValue(config); setSelected(config.activeProfileId || config.profiles[0]?.id || ""); setLoaded(true);
    }).catch((error: unknown) => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [client, projectId, canEdit]);
  const profile = value.profiles.find((p) => p.id === selected);
  const update = (patch: Partial<WorkspaceSetupProfile>) => setValue((current) => ({ ...current, profiles: current.profiles.map((p) => p.id === selected ? { ...p, ...patch } : p) }));
  const save = async () => {
    if (!canEdit) return;
    setBusy(true); setMessage("");
    try {
      const snapshot = await client.getSnapshot();
      const all = parseWorkspaceSetupSettings(snapshot.settings[APP_SETTING_KEYS.workspaceSetupProfiles]);
      const normalized = parseWorkspaceSetupSettings(JSON.stringify({ ...all, [projectId]: value }));
      await client.setAppSetting(APP_SETTING_KEYS.workspaceSetupProfiles, JSON.stringify(normalized));
      const saved = normalized[projectId];
      setValue(saved);
      setSelected(saved.profiles.some((entry) => entry.id === selected) ? selected : saved.activeProfileId || saved.profiles[0]?.id || "");
      setMessage("Saved. Applies to new isolated workspaces.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const lines = (text: string) => text.split(/\r?\n/);
  const profileOptions = value.profiles.map((p) => ({ value: p.id, label: p.name }));
  if (!canEdit) return <section className="space-y-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-3" aria-label="Workspace setup profiles">
    <h3 className="text-sm font-medium">Workspace setup profiles</h3>
    <p className="text-xs text-[var(--ec-muted)]">Pair this browser with the admin scope to view and edit the host's workspace setup profiles.</p>
  </section>;
  return <section className="space-y-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-3" aria-label="Workspace setup profiles">
    <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto text-sm font-medium">Workspace setup profiles</h3>
      <Select className="w-48 max-w-full" triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" ariaLabel="Edit setup profile" value={selected} onValueChange={setSelected} disabled={!loaded || busy} options={[{ value: "", label: "Select profile" }, ...profileOptions]} />
      <Button size="sm" variant="secondary" disabled={!loaded || busy || value.profiles.length >= 10} onClick={() => {
        const id = crypto.randomUUID();
        setValue({ ...value, profiles: [...value.profiles, { id, name: "New profile", dependencies: "isolated", submodules: "none", commands: [], environmentFiles: [], previewCommand: "", previewUrl: "" }] }); setSelected(id);
      }}>Add profile</Button>
      <Button size="sm" disabled={!loaded || busy} onClick={() => void save()}>Save profiles</Button>
    </div>
    <p className="text-xs text-[var(--ec-muted)]">Setup commands are trusted commands you configure here. They run before the agent, with a five-minute limit each. Local repository runs are unchanged.</p>
    <div className="flex flex-wrap items-center gap-2 text-xs"><span>Default for new isolated runs</span>
      <Select className="w-72 max-w-full" triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" ariaLabel="Default for new isolated runs" value={value.activeProfileId} disabled={busy} onValueChange={(activeProfileId) => setValue({ ...value, activeProfileId })} options={[{ value: "", label: "No setup profile (existing behavior)" }, ...profileOptions]} />
    </div>
    {profile && <div className="grid gap-2 md:grid-cols-2">
      <label className="space-y-1 text-xs">Profile name<Input value={profile.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} disabled={busy} /></label>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs"><span>Dependencies</span><Select triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" ariaLabel="Dependencies" value={profile.dependencies} onValueChange={(dependencies) => update({ dependencies: dependencies as WorkspaceSetupProfile["dependencies"] })} disabled={busy} options={[{ value: "isolated", label: "Isolated (install with setup command)" }, { value: "shared", label: "Share original node_modules" }]} /></div>
        <div className="flex w-32 flex-col gap-1 text-xs"><span>Submodules</span><Select triggerClassName="h-8 px-2 text-xs" optionClassName="px-2 text-xs" ariaLabel="Submodules" value={profile.submodules} onValueChange={(submodules) => update({ submodules: submodules as WorkspaceSetupProfile["submodules"] })} disabled={busy} options={[{ value: "none", label: "Skip" }, { value: "top-level", label: "Top level" }, { value: "recursive", label: "Recursive" }]} /></div>
      </div>
      <label className="space-y-1 text-xs">Setup commands (one per line)<Textarea className="min-h-20 font-mono text-xs" value={profile.commands.join("\n")} onChange={(e) => update({ commands: lines(e.target.value) })} placeholder="pnpm install --frozen-lockfile" disabled={busy} /></label>
      <label className="space-y-1 text-xs">Environment files to copy (relative paths, one per line)<Textarea className="min-h-20 font-mono text-xs" value={profile.environmentFiles.join("\n")} onChange={(e) => update({ environmentFiles: lines(e.target.value) })} placeholder=".env.local" disabled={busy} /><span className="text-[var(--ec-muted)]">Existing files are preserved; file contents are never stored in settings.</span></label>
      <label className="space-y-1 text-xs">Preview command<Input value={profile.previewCommand} onChange={(e) => update({ previewCommand: e.target.value })} placeholder="pnpm dev" disabled={busy} /></label>
      <label className="space-y-1 text-xs">Preview URL<Input value={profile.previewUrl} onChange={(e) => update({ previewUrl: e.target.value })} placeholder="http://localhost:3000" disabled={busy} /></label>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setValue({ activeProfileId: value.activeProfileId === selected ? "" : value.activeProfileId, profiles: value.profiles.filter((p) => p.id !== selected) }); setSelected(""); }}>Remove profile</Button>
    </div>}
    {message && <p role="status" className="text-xs text-[var(--ec-muted)]">{message}</p>}
  </section>;
};
