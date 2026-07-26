import { useEffect, useMemo, useState } from "react";
import type { RunWorkspaceFileResult } from "@buildwarden/shared";
import { summarizeDiffStats } from "@buildwarden/renderer/logic";
import { ChevronLeft, FileCode2 } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { errorMessage } from "../../lib/format";
import { CenteredSpinner, EmptyState, InlineError, Input, ListRow } from "../../components/primitives";

const UNAVAILABLE_MESSAGES: Record<string, string> = {
  "empty-path": "Enter a path inside the run workspace.",
  "outside-workspace": "That path is outside the run workspace.",
  "workspace-unavailable": "The run workspace no longer exists.",
  "not-found": "No such file in the run workspace.",
  directory: "That path is a directory.",
  binary: "Binary files cannot be previewed.",
  "read-error": "The host could not read that file.",
};

/**
 * Read-only workspace file viewer. The host exposes single-file reads rather than a tree, so the
 * changed-file list from the diff acts as the index, with a path field for anything else.
 */
export const RunFilesPanel = ({ runId, diff, onRequestDiff }: { runId: string; diff: string; onRequestDiff: () => void }) => {
  const { client } = useMobileApp();
  const [path, setPath] = useState("");
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<RunWorkspaceFileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = useMemo(() => summarizeDiffStats(diff).files, [diff]);

  useEffect(() => {
    onRequestDiff();
  }, [onRequestDiff]);

  useEffect(() => {
    if (!path) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .getRunWorkspaceFile({ runId, path })
      .then((next) => {
        if (!cancelled) setResult(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught, "Could not read that file."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, path, runId]);

  if (path) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-[var(--ec-border)] px-1 py-1">
          <button
            type="button"
            onClick={() => setPath("")}
            className="m-tap inline-flex items-center gap-1 px-2 text-xs font-medium text-[var(--ec-accent)]"
          >
            <ChevronLeft className="size-4" />
            Files
          </button>
          <p className="m-mono min-w-0 flex-1 truncate text-[11px] text-[var(--ec-muted)]" dir="rtl">
            {path}
          </p>
        </div>
        {loading ? (
          <CenteredSpinner label="Reading file" />
        ) : error ? (
          <InlineError message={error} />
        ) : result?.unavailableReason ? (
          <EmptyState title="Cannot show this file" message={UNAVAILABLE_MESSAGES[result.unavailableReason] ?? result.error} />
        ) : (
          <div className="m-scroll flex-1">
            <div className="m-scroll-x m-mono whitespace-pre px-3 py-2 text-[11.5px] leading-[1.55]">{result?.content ?? ""}</div>
            {result?.truncated ? (
              <p className="px-4 pb-4 text-[11px] text-[var(--ec-faint)]">File truncated by the host.</p>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="m-scroll flex-1">
      <div className="border-b border-[var(--ec-border)] px-4 py-2.5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) setPath(draft.trim());
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="src/index.ts"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="go"
            className="m-mono text-[13px]"
          />
        </form>
      </div>

      {files.length === 0 ? (
        <EmptyState icon={<FileCode2 className="size-7" />} title="No changed files" message="Type a path above to read any file in the run workspace." />
      ) : (
        files.map((file) => (
          <ListRow
            key={file.path}
            title={<span className="m-mono text-[12.5px]">{file.path.split("/").pop()}</span>}
            subtitle={file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : undefined}
            onClick={() => setPath(file.path)}
          />
        ))
      )}
      <div className="h-6" />
    </div>
  );
};
