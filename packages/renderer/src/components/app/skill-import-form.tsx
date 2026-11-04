import { useState } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export const SkillImportForm = () => {
  const client = useBuildWardenClient();
  const [source, setSource] = useState<"local" | "git">("local");
  const [location, setLocation] = useState("");
  const [revision, setRevision] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const submit = async () => {
    setBusy(true);
    setMessage("");
    try {
      const skill = await client.importSkill(source === "local"
        ? { source, path: location.trim() }
        : { source, url: location.trim(), revision: revision.trim(), subdirectory: subdirectory.trim() });
      setMessage(`Imported ${skill.title}. Select it in a project or invoke it from the composer.${skill.diagnostics?.length ? ` ${skill.diagnostics.join(" ")}` : ""}`);
      window.dispatchEvent(new Event("buildwarden-skills-changed"));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="rounded-xl border border-[var(--ec-border)] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Skill import source" className="rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-1 text-xs text-[var(--ec-text)]" value={source} disabled={busy} onChange={(event) => { setSource(event.target.value as "local" | "git"); setLocation(""); }}>
        <option value="local">Local folder</option><option value="git">Git commit</option>
      </select>
      <Input className="min-w-48 flex-1" aria-label="Skill source location" value={location} disabled={busy} placeholder={source === "local" ? "Host folder containing SKILL.md" : "https://github.com/owner/repository.git"} onChange={(event) => setLocation(event.target.value)} />
      {source === "local" && client.capabilities.directoryPicker ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void client.pickProjectDirectory().then((path) => { if (path) setLocation(path); }).catch((error: unknown) => setMessage(String(error)))}>Browse</Button> : null}
      <Button size="sm" disabled={busy || !location.trim() || (source === "git" && !/^[a-f0-9]{40}$/i.test(revision.trim()))} onClick={() => void submit()}>{busy ? "Importing…" : "Import skill"}</Button>
    </div>
    {source === "git" ? <div className="mt-2 flex flex-wrap gap-2">
      <Input className="min-w-48 flex-1" aria-label="Skill Git commit SHA" value={revision} disabled={busy} placeholder="Full commit SHA (40 characters)" onChange={(event) => setRevision(event.target.value)} />
      <Input className="min-w-48 flex-1" aria-label="Skill repository subdirectory" value={subdirectory} disabled={busy} placeholder="Skill subdirectory (empty for repository root)" onChange={(event) => setSubdirectory(event.target.value)} />
    </div> : null}
    <p className="mt-2 text-xs text-[var(--ec-muted)]">Imports copy the complete skill folder. Reimport the same source to update future turns; interrupted runs retain their saved version. Loading a skill does not execute its scripts.</p>
    {message ? <p role="status" className="mt-2 text-xs text-[var(--ec-text)]">{message}</p> : null}
  </div>;
};
