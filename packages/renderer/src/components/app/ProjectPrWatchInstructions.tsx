import { useEffect, useMemo, useState } from "react";
import { PR_WATCH_INSTRUCTIONS_MAX_CHARS, buildPrWatchPrompt, type ProjectForgeProvider } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** A made-up wake, so the preview shows where the instructions land in a real prompt. */
const previewPrompt = (provider: ProjectForgeProvider, instructions: string) => buildPrWatchPrompt({
  provider,
  number: 128,
  title: "Example change",
  sourceBranch: "feature/example",
  targetBranch: "main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  failedChecks: [{ name: "build", url: null, log: "error TS2322: Type 'string' is not assignable to type 'number'." }],
  conflicts: false,
  feedback: [{
    ref: "T1",
    item: {
      ref: "T1", kind: "thread", threadId: "thread", replyToCommentId: null, path: "src/example.ts", line: 42,
      commentIds: ["comment"], author: "reviewer", excerpt: "This can be null here.",
    },
    comments: [{ author: "reviewer", body: "This can be null here.", isNew: true }],
  }],
  instructions,
});

/** Project instructions appended to every PR watch prompt. */
export const ProjectPrWatchInstructions = ({ projectId, provider, disabled }: Readonly<{
  projectId: string;
  provider: ProjectForgeProvider;
  disabled: boolean;
}>) => {
  const client = useBuildWardenClient();
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    setMessage(null);
    void client.getProjectPrWatchInstructions(projectId)
      .then((value) => { if (!cancelled) { setSaved(value); setDraft(value); } })
      .catch((loadError: unknown) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [client, projectId]);

  const preview = useMemo(() => previewPrompt(provider, draft), [provider, draft]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const value = await client.saveProjectPrWatchInstructions(projectId, draft);
      setSaved(value);
      setDraft(value);
      setMessage("Saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        aria-label="PR watch instructions"
        placeholder="For example: run pnpm lint and pnpm test before committing. Ignore the Codecov check."
        maxLength={PR_WATCH_INSTRUCTIONS_MAX_CHARS}
        rows={3}
        disabled={disabled || busy}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); setMessage(null); }}
        className="min-h-20 text-xs"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <details className="min-w-0 flex-1 text-xs text-[var(--ec-muted)]">
          <summary className="cursor-pointer">Preview the prompt</summary>
          <pre className="app-inset app-scrollbar mt-2 max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-[11px] leading-4 text-[var(--ec-text)]">{preview}</pre>
        </details>
        <Button type="button" size="sm" className="h-8 px-2.5" disabled={disabled || busy || draft.trim() === saved} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {error ? <p role="alert" className="text-xs text-[var(--ec-danger)] md:text-right">{error}</p> : null}
      {message ? <p className="text-xs text-[var(--ec-success)] md:text-right">{message}</p> : null}
    </div>
  );
};
