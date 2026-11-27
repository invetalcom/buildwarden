import { useState } from "react";
import type { AcpAgentSessionSummary, AppSnapshot } from "@buildwarden/shared";
import { useOptionalBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Select } from "../ui/select";

const formatUpdatedAt = (value: string | null): string => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

/**
 * Lists the sessions an ACP agent saved for a project's folder (ACP `session/list`) and imports
 * one as a run that continues the agent's session.
 */
export function AcpSessionImporter({ providerAccountId, projects }: { providerAccountId: string; projects: AppSnapshot["projects"] }) {
  const client = useOptionalBuildWardenClient();
  const [projectId, setProjectId] = useState(projects[0]?.project.id ?? "");
  const [sessions, setSessions] = useState<AcpAgentSessionSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  if (!client) return null;
  const list = async () => {
    if (!projectId) return;
    setBusy("list"); setMessage(""); setSessions(null);
    try {
      const result = await client.listAcpAgentSessions(providerAccountId, projectId);
      if (!result.supported) setMessage("This agent does not list its saved sessions.");
      else if (result.sessions.length === 0) setMessage("The agent saved no sessions for this project's folder.");
      setSessions(result.sessions);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const importSession = async (session: AcpAgentSessionSummary) => {
    setBusy(session.sessionId); setMessage("");
    try {
      const run = await client.importAcpAgentSession({
        providerAccountId, projectId, sessionId: session.sessionId, ...(session.title ? { title: session.title } : {}),
      });
      setSessions((current) => current?.map((entry) => (entry.sessionId === session.sessionId ? { ...entry, imported: true } : entry)) ?? null);
      setMessage(`Imported as run "${run.prompt.slice(0, 60)}" in the project's runs.`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={projectId}
          ariaLabel="Project whose folder the sessions belong to"
          placeholder={projects.length === 0 ? "Add a project first" : "Choose a project"}
          options={projects.map(({ project }) => ({ value: project.id, label: project.name }))}
          onValueChange={(value) => { setProjectId(value); setSessions(null); setMessage(""); }}
          disabled={projects.length === 0 || busy !== null}
        />
        <Button type="button" size="sm" variant="secondary" disabled={!projectId || busy !== null} onClick={() => void list()}>
          {busy === "list" ? "Listing…" : "List sessions"}
        </Button>
      </div>
      {sessions && sessions.length > 0 ? (
        <div className="max-h-40 overflow-y-auto">
          {sessions.map((session) => (
            <div key={session.sessionId} className="flex items-center justify-between gap-2 border-b border-[var(--ec-border)] py-1 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate text-[var(--ec-text)]" title={session.title ?? session.sessionId}>{session.title ?? session.sessionId}</p>
                <p className="truncate text-[var(--ec-muted)]">{formatUpdatedAt(session.updatedAt)}</p>
              </div>
              <Button type="button" size="sm" variant="secondary" disabled={session.imported || busy !== null} onClick={() => void importSession(session)}>
                {session.imported ? "Imported" : busy === session.sessionId ? "Importing…" : "Import"}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {message ? <p className="text-[var(--ec-muted)]" role="status">{message}</p> : null}
    </div>
  );
}
