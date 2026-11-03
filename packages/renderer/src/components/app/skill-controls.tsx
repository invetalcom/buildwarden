import { useEffect, useRef, useState } from "react";
import { APP_SETTING_KEYS, parseIntegratedSkillsDisabledSetting, parseProjectActiveSkillsSetting, type IntegratedSkillMetadata, type SkillSessionSnapshot } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { Input } from "../ui/input";

export interface SkillControlsProps {
  projectId?: string;
  session?: { kind: "run" | "chat"; id: string };
  selection?: string[] | null;
  onSelectionChange?: (ids: string[] | null) => void;
  onMention: (mention: string) => void;
  disabled?: boolean;
}

export const SkillControls = ({ projectId, session, selection, onSelectionChange, onMention, disabled }: SkillControlsProps) => {
  const client = useBuildWardenClient();
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<IntegratedSkillMetadata[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<SkillSessionSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const kind = session?.kind;
  const id = session?.id;
  useEffect(() => {
    if (!open || !client.capabilities.settings) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const [skills, app, state] = await Promise.all([client.listIntegratedSkills(), client.getSnapshot(), kind && id ? client.getSessionSkills(kind, id) : null]);
        if (cancelled) return;
        const disabledIds = new Set(parseIntegratedSkillsDisabledSetting(app.settings[APP_SETTING_KEYS.integratedSkillsDisabled]));
        setCatalog(skills.filter((skill) => !disabledIds.has(skill.id)));
        setDefaults(projectId ? parseProjectActiveSkillsSetting(app.settings[APP_SETTING_KEYS.projectActiveSkills])[projectId] ?? [] : []);
        setSnapshot(state);
        setError("");
      } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught)); }
    };
    void refresh();
    const unsubscribe = kind === "run" ? client.onRunEvent((event) => { if (event.runId === id && (event.metadata?.skillEvent || event.metadata?.skillAvailability)) void refresh(); })
      : kind === "chat" ? client.onChatEvent((event) => { if (event.runId === id && (event.metadata?.skillEvent || event.metadata?.skillAvailability)) void refresh(); }) : undefined;
    return () => { cancelled = true; unsubscribe?.(); };
  }, [client, open, kind, id, projectId]);
  if (!client.capabilities.settings) return null;
  const override = session ? snapshot?.overrideIds ?? null : selection ?? null;
  const selectedIds = override ?? defaults;
  const canSelect = Boolean(session || onSelectionChange);
  const update = async (ids: string[] | null) => {
    setPending(true);
    try {
      if (session) {
        await client.setSessionSkills(session.kind, session.id, ids);
        setSnapshot(await client.getSessionSkills(session.kind, session.id));
      } else onSelectionChange?.(ids);
      setError("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setPending(false); }
  };
  const filtered = catalog.filter((skill) => `${skill.title} ${skill.id} ${skill.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="relative" ref={anchor}>
    <button type="button" className="rounded px-2 py-1 text-xs text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]" aria-expanded={open} onClick={() => setOpen(!open)}>Skills{override !== null ? ` (${override.length})` : ""}</button>
    <AnchorDropdownPortal open={open} anchorRef={anchor} onClose={() => setOpen(false)} align="start" widthPx={420} className="glass-popover p-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>{canSelect ? override === null ? "Project defaults" : "Session override" : "Invoke a skill for this message"}</span>
        {canSelect ? <button type="button" disabled={disabled || pending} onClick={() => void update(override === null ? [] : null)} className="text-[var(--ec-accent)]">{override === null ? "Select none" : "Use project defaults"}</button> : null}
      </div>
      <Input className="my-2" value={query} aria-label="Search available skills" placeholder="Search skills…" onChange={(event) => setQuery(event.target.value)} />
      {error ? <p role="alert" className="mb-2 text-xs text-[var(--ec-text)]">{error}</p> : null}
      <div className="app-scrollbar max-h-64 overflow-y-auto">
        {filtered.map((skill) => <div key={skill.id} className="flex items-start gap-2 border-b border-[var(--ec-border)] py-2 text-xs">
          {canSelect ? <input type="checkbox" aria-label={`Select ${skill.title}`} className="mt-0.5 accent-[var(--ec-accent)]" checked={selectedIds.includes(skill.id)} disabled={disabled || pending} onChange={(event) => void update(event.target.checked ? [...selectedIds, skill.id] : selectedIds.filter((selected) => selected !== skill.id))} /> : null}
          <div className="min-w-0 flex-1"><div className="font-medium text-[var(--ec-text)]">{skill.title} <span className="font-normal text-[var(--ec-muted)]">· {skill.source}</span></div><p className="line-clamp-2 text-[var(--ec-muted)]">{skill.description}</p></div>
          <button type="button" disabled={disabled || pending} className="shrink-0 text-[var(--ec-accent)]" onClick={() => { onMention(`$skill(${skill.id})`); setOpen(false); }}>Use now</button>
        </div>)}
        {!filtered.length ? <p className="py-2 text-xs text-[var(--ec-muted)]">No matching enabled skills.</p> : null}
      </div>
      {snapshot?.diagnostics.length ? <details className="mt-2 text-xs"><summary className="cursor-pointer">Last turn: {snapshot.loadedIds.length} loaded / {snapshot.diagnostics.filter((item) => item.status === "available" || item.status === "loaded").length} available</summary>
        <ul className="mt-1 max-h-32 overflow-auto space-y-1">{snapshot.diagnostics.map((item) => <li key={item.skillId} title={item.message}>{item.skillId}: <strong>{item.status}</strong>{item.message ? ` — ${item.message}` : ""}</li>)}</ul>
      </details> : null}
      <p className="mt-2 text-[10px] text-[var(--ec-muted)]">Selection makes a skill available; Use now loads it for this message. Changes apply to the next turn. Provider-native skills and slash commands are managed separately.</p>
    </AnchorDropdownPortal>
  </div>;
};
