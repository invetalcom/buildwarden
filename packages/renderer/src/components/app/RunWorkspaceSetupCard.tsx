import { useState } from "react";
import type { RunDetail } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";

export const RunWorkspaceSetupCard = ({ detail, onOpenUrl }: { detail: RunDetail; onOpenUrl?: (url: string) => void }) => {
  const client = useBuildWardenClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setup = detail.workspaceSetup;
  if (!setup) return null;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const preview = async () => {
    const sessionId = `buildwarden-run-terminal:${detail.run.id}`;
    const result = await client.runTerminalStart({ sessionId, cwd: detail.workspacePath ?? detail.run.worktreePath });
    if (!result.ok) throw new Error(result.error);
    if (result.reused) throw new Error("The run terminal is already open. Start the preview there to avoid interrupting an existing command.");
    await client.runTerminalWrite({ sessionId, data: `${setup.profile.previewCommand}\r` });
    if (setup.profile.previewUrl) onOpenUrl?.(setup.profile.previewUrl);
  };
  return <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-xs">
    <span className="mr-auto">Setup: <strong>{setup.profile.name}</strong> · {setup.status}</span>
    {setup.status !== "completed" && client.capabilities.runMutations && ["failed", "cancelled"].includes(detail.run.status) && <Button size="xs" disabled={busy} onClick={() => void act(() => client.followUpRun(detail.run.id, detail.run.prompt))}>Retry setup and run</Button>}
    {setup.status === "completed" && setup.profile.previewCommand && client.capabilities.runMutations && client.capabilities.embeddedTerminal && <Button size="xs" disabled={busy} onClick={() => void act(preview)}>Start preview</Button>}
    {setup.status === "completed" && setup.profile.previewUrl && onOpenUrl && <Button size="xs" variant="secondary" onClick={() => onOpenUrl(setup.profile.previewUrl)}>Open preview</Button>}
    {error && <span role="alert" className="text-[var(--ec-danger)]">{error}</span>}
  </div>;
};
