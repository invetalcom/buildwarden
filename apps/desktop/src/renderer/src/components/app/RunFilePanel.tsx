import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FileText, GitBranch, Loader2, RefreshCw } from "lucide-react";
import type { RunWorkspaceFileReference, RunWorkspaceFileResult } from "@buildwarden/shared";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { CodeMirrorFileViewer } from "./CodeMirrorFileViewer";
import { GitDiffPreview } from "./git-diff-preview";
import { summarizeDiffStats } from "./git-diff-utils";

type FilePanelView = "file" | "diff";

const normalizeFilePath = (value: string) => value.replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "").replace(/^\.\//, "");

// Exported for focused renderer behavior tests.
// eslint-disable-next-line react-refresh/only-export-components
export const filePathMatches = (left: string, right: string) => {
  const a = normalizeFilePath(left);
  const b = normalizeFilePath(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
};

const formatBytes = (value: number | null) => {
  if (value == null) {
    return "";
  }
  if (value < 1024) {
    return `${String(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const referenceToInputPath = (target: RunWorkspaceFileReference) => {
  if (!target.line) {
    return target.path;
  }
  const columnSuffix = target.column ? `:${String(target.column)}` : "";
  return `${target.path}:${String(target.line)}${columnSuffix}`;
};

const truncatedPreviewBytes = (sizeBytes: number | null) =>
  sizeBytes == null ? null : Math.min(sizeBytes, 1_000_000);

const unavailableMessage = (result: RunWorkspaceFileResult | null, loading: boolean, error: string | null) => {
  if (loading) {
    return null;
  }
  if (error) {
    return error;
  }
  if (!result?.unavailableReason) {
    return null;
  }
  switch (result.unavailableReason) {
    case "outside-workspace":
      return "That path is outside this run workspace.";
    case "workspace-unavailable":
      return "This run workspace is no longer available.";
    case "not-found":
      return "File does not exist in this run workspace.";
    case "directory":
      return "This path points to a directory.";
    case "binary":
      return result.error ?? "Binary files are not shown in the inline viewer.";
    case "read-error":
      return result.error ?? "Could not read this file.";
    case "empty-path":
      return "No file path was provided.";
    default:
      return "Could not open this file.";
  }
};

const FilePreviewContent = ({
  loading,
  message,
  result,
}: {
  loading: boolean;
  message: string | null;
  result: RunWorkspaceFileResult | null;
}) => {
  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-zinc-500" role="status">
        <Loader2 className="h-4 w-4 animate-spin text-cyan-400" aria-hidden />
        Opening file...
      </div>
    );
  }
  if (message) {
    return <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-zinc-500">{message}</div>;
  }
  if (result?.content == null) {
    return null;
  }
  return (
    <>
      {result.truncated ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
          Preview truncated at {formatBytes(truncatedPreviewBytes(result.sizeBytes))} of {formatBytes(result.sizeBytes)}.
        </div>
      ) : null}
      <CodeMirrorFileViewer
        className="min-h-0 flex-1 overflow-hidden"
        content={result.content}
        filePath={result.path}
        line={result.line}
        column={result.column}
      />
    </>
  );
};

const FilePanelBody = ({
  view,
  loading,
  message,
  result,
  diffPending,
  diffText,
  displayPath,
}: {
  view: FilePanelView;
  loading: boolean;
  message: string | null;
  result: RunWorkspaceFileResult | null;
  diffPending: boolean;
  diffText: string;
  displayPath: string;
}) => {
  if (view === "file") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/60">
        <FilePreviewContent loading={loading} message={message} result={result} />
      </div>
    );
  }
  if (diffPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 text-xs text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin text-cyan-400" aria-hidden />
        Computing file diff...
      </div>
    );
  }
  return (
    <GitDiffPreview
      diffText={diffText}
      activeFilePath={displayPath}
      emptyMessage="No diff is available for this file."
      activityEmphasis
      defaultCollapsedFileSections={false}
      alwaysExpandedFileSections
      fillContainer
    />
  );
};

export interface RunFilePanelProps {
  runId: string;
  target: RunWorkspaceFileReference;
  diffText: string;
  diffPending: boolean;
}

export const RunFilePanel = ({ runId, target, diffText, diffPending }: RunFilePanelProps) => {
  const [view, setView] = useState<FilePanelView>("file");
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<RunWorkspaceFileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputPath = useMemo(() => referenceToInputPath(target), [target]);
  const displayPath = result?.path || target.path;
  const hasFileDiff = useMemo(() => {
    if (diffPending || !diffText.trim()) {
      return false;
    }
    return summarizeDiffStats(diffText).files.some((file) => filePathMatches(file.path, displayPath));
  }, [diffPending, diffText, displayPath]);
  const canShowDiffTab = diffPending || hasFileDiff;
  const message = unavailableMessage(result, loading, error);

  useEffect(() => {
    setView("file");
    setResult(null);
    setError(null);
    setCopied(false);
  }, [runId, inputPath]);

  useEffect(() => {
    if (!canShowDiffTab && view === "diff") {
      setView("file");
    }
  }, [canShowDiffTab, view]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.buildwarden
      .getRunWorkspaceFile({ runId, path: inputPath })
      .then((next) => {
        if (cancelled) {
          return;
        }
        setResult(next);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Could not open this file.");
        setResult(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [inputPath, reloadKey, runId]);

  const copyPath = useCallback(() => {
    setCopied(false);
    void navigator.clipboard
      .writeText(displayPath)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  }, [displayPath]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />
          <div className="min-w-0">
            <p className="truncate font-mono text-[11px] font-medium text-zinc-100" title={displayPath}>
              {displayPath}
            </p>
            <p className="truncate text-[10px] text-zinc-500">
              {result?.sizeBytes != null ? formatBytes(result.sizeBytes) : "Run workspace file"}
              {result?.line ? ` - line ${String(result.line)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100"
            onClick={copyPath}
            title={copied ? "Copied" : "Copy path"}
            aria-label="Copy path"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-zinc-400 hover:text-zinc-100"
            onClick={() => setReloadKey((current) => current + 1)}
            disabled={loading}
            title="Reload file"
            aria-label="Reload file"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-stretch border-b border-zinc-800/80 bg-zinc-950/35 px-2">
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 border-b-2 px-2 text-[11px] transition",
            view === "file" ? "border-cyan-500/70 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
          )}
          onClick={() => setView("file")}
        >
          <FileText className="h-3.5 w-3.5" aria-hidden />
          File
        </button>
        {canShowDiffTab ? (
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-2 text-[11px] transition",
              view === "diff" ? "border-cyan-500/70 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-200",
            )}
            onClick={() => setView("diff")}
          >
            <GitBranch className="h-3.5 w-3.5" aria-hidden />
            Diff
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-2">
        <FilePanelBody
          view={view}
          loading={loading}
          message={message}
          result={result}
          diffPending={diffPending}
          diffText={diffText}
          displayPath={displayPath}
        />
      </div>
    </div>
  );
};
