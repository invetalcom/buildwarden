import type { ProviderType, UnifiedProviderFamily } from "@easycode/shared";
import { Bot, GitBranch, Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { DiffReviewPanel, type DiffReviewPanelState } from "./diff-review-panel";
import { ComposerSelect } from "./RunComposer";
import { GitDiffPreview, type GitDiffPreviewHandle } from "./git-diff-preview";
import { countChangedFilesInDiff } from "./git-diff-utils";

interface ProjectPrMrTabProps {
  projectId: string;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
}

const emptyReviewPanel = (): DiffReviewPanelState => ({ result: null, busy: false, error: null });

export const ProjectPrMrTab = ({ projectId, modelOptions, defaultModelId }: ProjectPrMrTabProps) => {
  const [prUrl, setPrUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [diffText, setDiffText] = useState("");
  const [meta, setMeta] = useState<{ provider: "github" | "gitlab"; number: number; baseRef: string } | null>(null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewModelId, setReviewModelId] = useState(defaultModelId);
  const [reviewPanel, setReviewPanel] = useState<DiffReviewPanelState>(emptyReviewPanel);
  const gitDiffPanelRef = useRef<GitDiffPreviewHandle>(null);
  const [allDiffFilesExpanded, setAllDiffFilesExpanded] = useState(false);

  useEffect(() => {
    setReviewModelId(defaultModelId);
  }, [defaultModelId, projectId]);

  useEffect(() => {
    if (modelOptions.some((option) => option.id === reviewModelId)) {
      return;
    }
    setReviewModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, reviewModelId]);

  const diffChangedFileCount = useMemo(() => (diffText.trim() ? countChangedFilesInDiff(diffText) : 0), [diffText]);

  const reviewBusy = reviewPanel.busy;

  const loadDiff = async () => {
    setLoadBusy(true);
    setLoadError(null);
    setMeta(null);
    setDiffText("");
    setReviewPanel(emptyReviewPanel());
    try {
      const result = await window.easycode.fetchProjectPrMrDiff(projectId, {
        prUrl: prUrl.trim(),
        baseBranch: baseBranch.trim() || undefined,
      });
      setDiffText(result.diff);
      setMeta({ provider: result.provider, number: result.number, baseRef: result.baseRef });

      if (reviewModelId.trim()) {
        setReviewPanel((current) => ({ ...current, busy: true, error: null }));
        try {
          const reviewed = await window.easycode.analyzeProjectPrMrDiff(projectId, {
            prUrl: prUrl.trim(),
            diff: result.diff,
            modelId: reviewModelId,
          });
          setReviewPanel({ result: reviewed, busy: false, error: null });
        } catch (reviewError) {
          setReviewPanel({
            result: null,
            busy: false,
            error: reviewError instanceof Error ? reviewError.message : "Could not generate inline review comments.",
          });
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the PR/MR diff.");
    } finally {
      setLoadBusy(false);
    }
  };

  const runPrMrReview = async () => {
    setReviewPanel((current) => ({
      ...current,
      busy: true,
      error: null,
    }));
    try {
      const result = await window.easycode.analyzeProjectPrMrDiff(projectId, {
        prUrl: prUrl.trim(),
        diff: diffText,
        modelId: reviewModelId,
      });
      setReviewPanel({
        result,
        busy: false,
        error: null,
      });
    } catch (error) {
      setReviewPanel((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "Could not analyze the diff.",
      }));
    }
  };

  const kindLabel = meta?.provider === "gitlab" ? "MR" : "PR";

  const prLoadHelp =
    "Paste a GitHub PR or GitLab MR link. Easycode runs git fetch on origin and shows the diff from the merge base to the PR/MR head. The repository URL must match this project's origin.";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", diffText.trim() ? "overflow-hidden" : "")}>
      <Card className="shrink-0 border-zinc-800/80 bg-zinc-950/40 p-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
            <h2 className="text-xs font-semibold text-zinc-100">Pull / merge requests</h2>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800/80 hover:text-zinc-300"
              title={prLoadHelp}
              aria-label="How PR and MR loading works"
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </button>
            {meta ? (
              <span className="text-[9px] text-zinc-500">
                · {kindLabel} #{meta.number} · <span className="font-mono text-zinc-400">{meta.baseRef}</span>
                {diffChangedFileCount > 0 ? (
                  <span className="text-zinc-600">
                    {" "}
                    · {String(diffChangedFileCount)} file{diffChangedFileCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {meta && !reviewModelId.trim() ? (
            <span className="text-[9px] text-amber-200/85">Select a model, then reload for inline comments</span>
          ) : null}
        </div>

        <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 space-y-0.5">
            <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">PR / MR URL</span>
            <Input
              value={prUrl}
              onChange={(event) => setPrUrl(event.target.value)}
              placeholder="https://github.com/org/repo/pull/123 or GitLab …/-/merge_requests/456"
              className="h-7 font-mono text-[11px]"
              disabled={loadBusy}
            />
          </label>
          <label className="w-full space-y-0.5 sm:w-36">
            <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">Base</span>
            <Input
              value={baseBranch}
              onChange={(event) => setBaseBranch(event.target.value)}
              placeholder="default"
              className="h-7 font-mono text-[11px]"
              disabled={loadBusy}
              title="Optional. When empty, uses origin/HEAD (or origin/main)."
            />
          </label>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 px-2.5 text-[11px]"
            onClick={() => void loadDiff()}
            disabled={loadBusy || !prUrl.trim()}
          >
            {loadBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Load diff
          </Button>
        </div>

        {loadError ? <p className="mt-1 text-[9px] text-rose-300">{loadError}</p> : null}
      </Card>

      {diffText.trim() ? (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
          <div
            className="shrink-0 border-b border-zinc-800/80 px-2 py-1.5"
            title="Merge base → PR/MR head via local git fetch (not the hosting API)."
          >
            <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium leading-none text-zinc-100">Diff</p>
                <p className="mt-0.5 hidden text-[9px] leading-tight text-zinc-500 sm:block">
                  Merge base → head · local git
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
                <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-zinc-500" title="Reviewer simulator (not saved)">
                  Model
                </span>
                <ComposerSelect
                  value={reviewModelId}
                  onChange={setReviewModelId}
                  disabled={reviewBusy || modelOptions.length === 0}
                  icon={Bot}
                  iconClassName="text-cyan-300"
                  buttonClassName="h-7 max-w-[11rem] gap-1 px-2 text-[10px] sm:max-w-[14rem]"
                  options={modelOptions.map((option) => ({
                    value: option.id,
                    label: option.label,
                    contextModelId: option.modelId,
                    providerType: option.providerType,
                    providerFamily: option.providerFamily,
                  }))}
                  menuClassName="w-[22rem]"
                  menuSide="bottom"
                />
                {diffChangedFileCount > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-[10px] text-zinc-400"
                    title={allDiffFilesExpanded ? "Collapse all files" : "Expand all files"}
                    onClick={() => gitDiffPanelRef.current?.toggleExpandAllFiles()}
                  >
                    {allDiffFilesExpanded ? "Collapse all" : "Expand all"}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-2 pb-2 pt-1.5">
            {/* Reviewer narrative; cap height so the diff keeps most of the card. */}
            <div className="app-scrollbar max-h-[34%] min-h-0 w-full min-w-0 overflow-y-auto overscroll-y-contain">
              <DiffReviewPanel
                state={reviewPanel}
                onRun={() => void runPrMrReview()}
                disabled={reviewBusy || !diffText.trim()}
                compact
                defaultExpanded={false}
              />
            </div>
            <GitDiffPreview
              ref={gitDiffPanelRef}
              diffText={diffText}
              fillContainer
              className="min-h-0 flex-1"
              emptyMessage="No changes in this range."
              activityEmphasis
              viewType="unified"
              wordDiff
              reviewFindings={reviewPanel.result?.findings ?? null}
              defaultCollapsedFileSections
              onAllFilesExpandedChange={setAllDiffFilesExpanded}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
};
