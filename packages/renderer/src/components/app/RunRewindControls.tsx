import { useState } from "react";
import type { RunDetail, RunRewindArchive, RunRewindInput, RunRewindResult } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";

export function RunRewindControls({ detail, disabled, onRewind, onPrepared }: {
  detail: RunDetail;
  disabled: boolean;
  onRewind: (input: RunRewindInput) => Promise<RunRewindResult>;
  onPrepared: (result: RunRewindResult) => void;
}) {
  const client = useBuildWardenClient();
  const points = detail.promptRestorePoints ?? [];
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<RunRewindInput["mode"]>("conversation");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [archives, setArchives] = useState<RunRewindArchive[] | null>(null);
  const pending = detail.pendingRewind;
  const point = points.find((entry) => entry.id === (pending?.restorePointId ?? selected)) ?? points.at(-1);
  const selectedMode = pending?.mode ?? mode;
  const rewind = async (overrideMode?: RunRewindInput["mode"]) => {
    if (!point) return;
    setBusy(true); setMessage("");
    try {
      const result = await onRewind({ runId: detail.run.id, restorePointId: point.id, mode: overrideMode ?? selectedMode });
      onPrepared(result);
      setArchives(null);
      setMessage(result.providerStrategy === "native" ? "Native conversation rewound. Edit the prompt in the composer and send when ready." : "The next turn will start a fresh session with retained history. Edit the prompt in the composer and send when ready.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  return <details className="shrink-0 rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-1 text-xs" open={pending ? true : undefined}>
    <summary className="cursor-pointer text-[var(--ec-muted)]">{pending ? "Rewind interrupted — retry to continue" : "Rewind / edit an earlier prompt"}</summary>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select aria-label="Prompt to rewind" value={point?.id ?? ""} disabled={busy || Boolean(pending)} onChange={(event) => { setSelected(event.target.value); setMode("conversation"); }}
        className="min-w-0 flex-1 rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1">
        {!points.length && <option value="">No retained restore points</option>}
        {points.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.prompt.slice(0, 100)}</option>)}
      </select>
      <select aria-label="Rewind mode" value={selectedMode} disabled={busy || Boolean(pending)} onChange={(event) => setMode(event.target.value as RunRewindInput["mode"])}
        className="rounded border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1">
        <option value="conversation">Conversation only</option>
        <option value="conversation-and-files" disabled={!point?.filesAvailable || !client.capabilities.gitMutations}>Conversation and files</option>
      </select>
      <Button size="xs" disabled={disabled || busy || !point || !client.capabilities.runMutations || !client.capabilities.gitMutations} onClick={() => void rewind()}>{pending ? "Retry rewind" : "Rewind and edit"}</Button>
      {pending?.mode === "conversation-and-files" && <Button size="xs" variant="secondary" disabled={disabled || busy || !client.capabilities.runMutations || !client.capabilities.gitMutations}
        onClick={() => void rewind("conversation")}>Keep current files and finish rewind</Button>}
    </div>
    <p className="mt-1 text-[var(--ec-muted)]">Archives this prompt and everything after it, and replaces your composer draft with the original prompt and attachments. {selectedMode === "conversation" ? "Current files are kept." : "All file edits since this prompt, including your manual edits, are reverted; discarded changes are backed up."} Codex uses native rewind when available; other sessions restart with retained history.</p>
    {message && <p role="status" className="mt-1">{message}</p>}
    <Button size="xs" variant="ghost" className="mt-1" disabled={busy} onClick={() => void client.getRunRewindHistory(detail.run.id).then(setArchives).catch((e: unknown) => setMessage(String(e)))}>Show archived turns</Button>
    {archives?.length === 0 && <p className="text-[var(--ec-muted)]">No archived turns.</p>}
    {archives?.map((archive) => <details key={archive.id} className="mt-1">
      <summary className="cursor-pointer">{archive.createdAt} · {archive.prompt.slice(0, 80)}</summary>
      <div className="app-scrollbar max-h-64 overflow-auto">
        {archive.steps.map((step) => <div key={step.id} className="my-2"><strong>{step.title}</strong><pre className="whitespace-pre-wrap break-words font-sans">{step.content}</pre></div>)}
      </div>
    </details>)}
  </details>;
}
