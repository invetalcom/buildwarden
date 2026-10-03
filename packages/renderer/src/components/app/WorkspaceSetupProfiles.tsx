import { useEffect, useState } from "react";
import { APP_SETTING_KEYS, parseWorkspaceSetupSettings, type ProjectWorkspaceSetup, type WorkspaceSetupProfile } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export const WorkspaceSetupProfiles = ({ projectId }: { projectId: string }) => {
  const client = useBuildWardenClient();
  const [value, setValue] = useState<ProjectWorkspaceSetup>({ activeProfileId: "", profiles: [] });
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void client.getSnapshot().then((snapshot) => {
      if (!alive) return;
      const config = parseWorkspaceSetupSettings(snapshot.settings[APP_SETTING_KEYS.workspaceSetupProfiles])[projectId] ?? { activeProfileId: "", profiles: [] };
      setValue(config); setSelected(config.activeProfileId || config.profiles[0]?.id || ""); setLoaded(true);
    }).catch((error: unknown) => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [client, projectId]);
  const profile = value.profiles.find((p) => p.id === selected);
  const update = (patch: Partial<WorkspaceSetupProfile>) => setValue((current) => ({ ...current, profiles: current.profiles.map((p) => p.id === selected ? { ...p, ...patch } : p) }));
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const snapshot = await client.getSnapshot();
      const all = parseWorkspaceSetupSettings(snapshot.settings[APP_SETTING_KEYS.workspaceSetupProfiles]);
      await client.setAppSetting(APP_SETTING_KEYS.workspaceSetupProfiles, JSON.stringify({ ...all, [projectId]: value }));
      setMessage("Saved. Applies to new isolated workspaces.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const lines = (text: string) => text.split(/\r?\n/);
  const control = "h-8 rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 text-xs text-[var(--ec-text)]";
  return <section className="space-y-2 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-3" aria-label="Workspace setup profiles">
    <div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto text-sm font-medium">Workspace setup profiles</h3>
      <select className={control} aria-label="Edit setup profile" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!loaded || busy}>
        <option value="">Select profile</option>{value.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <Button size="sm" variant="secondary" disabled={!loaded || busy || value.profiles.length >= 10} onClick={() => {
        const id = crypto.randomUUID();
        setValue({ ...value, profiles: [...value.profiles, { id, name: "New profile", dependencies: "isolated", submodules: "none", commands: [], environmentFiles: [], previewCommand: "", previewUrl: "" }] }); setSelected(id);
      }}>Add profile</Button>
      <Button size="sm" disabled={!loaded || busy} onClick={() => void save()}>Save profiles</Button>
    </div>
    <p className="text-xs text-[var(--ec-muted)]">Setup commands are trusted commands you configure here. They run before the agent, with a five-minute limit each. Local repository runs are unchanged.</p>
    <label className="flex items-center gap-2 text-xs">Default for new isolated runs
      <select className={control} value={value.activeProfileId} disabled={busy} onChange={(e) => setValue({ ...value, activeProfileId: e.target.value })}>
        <option value="">No setup profile (existing behavior)</option>{value.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
    {profile && <div className="grid gap-2 md:grid-cols-2">
      <label className="space-y-1 text-xs">Profile name<Input value={profile.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} disabled={busy} /></label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">Dependencies<select className={control} value={profile.dependencies} onChange={(e) => update({ dependencies: e.target.value as WorkspaceSetupProfile["dependencies"] })} disabled={busy}><option value="isolated">Isolated (install with setup command)</option><option value="shared">Share original node_modules</option></select></label>
        <label className="flex flex-col gap-1 text-xs">Submodules<select className={control} value={profile.submodules} onChange={(e) => update({ submodules: e.target.value as WorkspaceSetupProfile["submodules"] })} disabled={busy}><option value="none">Skip</option><option value="top-level">Top level</option><option value="recursive">Recursive</option></select></label>
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
