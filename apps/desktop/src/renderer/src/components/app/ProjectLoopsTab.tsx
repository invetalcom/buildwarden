import type {
  ProjectLoopAvailability,
  ProjectLoopDetail,
  ProjectLoopEventRecord,
  ProjectLoopIterationRecord,
  ProjectLoopListItem,
  ProjectLoopMergePolicy,
  ProjectLoopPrReviewPolicy,
  ProjectLoopStatus,
  ProjectLoopUiChangePolicy,
  ProjectLoopUiReviewRecord,
  ProjectSnapshot,
  ProviderType,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import { isLoopCapableProviderType } from "@buildwarden/shared";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Image as ImageIcon,
  KeyRound,
  ListChecks,
  Loader2,
  MessageSquareWarning,
  MonitorSmartphone,
  Play,
  Power,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ImageLightbox } from "../ui/image-lightbox";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/cn";

type ModelOption = {
  id: string;
  label: string;
  modelId: string;
  providerType: ProviderType;
  providerFamily: UnifiedProviderFamily | null;
};

type ProjectLoopsTabProps = {
  project: ProjectSnapshot;
  modelOptions: ModelOption[];
  branchOptions: string[];
  busy: boolean;
  availability: ProjectLoopAvailability | null;
  onOpenRun: (runId: string) => void;
  onLoopsChanged: () => void | Promise<void>;
};

type LoopListSection = "open" | "merged" | "cancelled";

const LOOP_LIST_EMPTY_MESSAGES: Record<LoopListSection, string> = {
  open: "No open loops.",
  merged: "No merged loops yet.",
  cancelled: "No cancelled loops.",
};

const MERGE_POLICY_OPTIONS: Array<{ value: ProjectLoopMergePolicy; label: string; description: string }> = [
  {
    value: "wait-for-approval",
    label: "Wait for approval",
    description: "Each PR/MR waits until it is approved or merged on the Git host. Approvals are merged automatically.",
  },
  {
    value: "auto-merge",
    label: "Auto-merge",
    description: "Each PR/MR is merged automatically once it is mergeable and has no unaddressed review comments.",
  },
];

const PR_REVIEW_POLICY_OPTIONS: Array<{ value: ProjectLoopPrReviewPolicy; label: string; description: string }> = [
  {
    value: "none",
    label: "No automatic review",
    description: "Only human reviewers (or external tools) comment; the loop addresses whatever arrives.",
  },
  {
    value: "ai-review",
    label: "AI reviews each PR",
    description: "The review model posts a visible code review with inline comments on the PR/MR; the loop then fixes and resolves those findings like any other comments.",
  },
];

const UI_POLICY_OPTIONS: Array<{ value: ProjectLoopUiChangePolicy; label: string; description: string }> = [
  {
    value: "auto",
    label: "Just merge",
    description: "UI changes ship without a screenshot review.",
  },
  {
    value: "manual-approval",
    label: "I approve each page",
    description: "The agent screenshots every affected page; you approve each one before the PR is created.",
  },
  {
    value: "ai-review",
    label: "AI reviews each page",
    description: "A second model reviews each screenshot plus the code and requests changes when needed.",
  },
];

const LOOP_STATUS_LABELS: Record<ProjectLoopStatus, string> = {
  planning: "Planning",
  implementing: "Implementing",
  "awaiting-ui-approval": "Waiting for UI approval",
  "reviewing-ui": "AI reviewing UI",
  "creating-pr": "Creating PR",
  "awaiting-merge": "Waiting for merge",
  "addressing-comments": "Addressing comments",
  auditing: "Auditing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const ITERATION_STATUS_LABELS: Record<ProjectLoopIterationRecord["status"], string> = {
  pending: "Pending",
  implementing: "Implementing",
  "awaiting-ui-approval": "UI approval",
  "reviewing-ui": "AI UI review",
  "creating-pr": "Creating PR",
  "awaiting-merge": "Waiting for merge",
  "addressing-comments": "Addressing comments",
  merged: "Merged",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const ACTIVE_LOOP_STATUSES = new Set<ProjectLoopStatus>([
  "planning",
  "implementing",
  "awaiting-ui-approval",
  "reviewing-ui",
  "creating-pr",
  "awaiting-merge",
  "addressing-comments",
  "auditing",
]);

const statusToneClass = (status: ProjectLoopStatus | ProjectLoopIterationRecord["status"]): string => {
  if (status === "completed" || status === "merged") {
    return "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]";
  }
  if (status === "failed") {
    return "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]";
  }
  if (status === "cancelled" || status === "skipped" || status === "pending") {
    return "border-[var(--ec-border)] bg-[var(--ec-muted-soft)] text-[var(--ec-muted)]";
  }
  if (status === "awaiting-ui-approval") {
    return "border-[var(--ec-warning)] bg-[var(--ec-warning)]/10 text-[var(--ec-warning)]";
  }
  return "border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)] text-[var(--ec-info)]";
};

const eventToneClass = (role: ProjectLoopEventRecord["role"]): string => {
  if (role === "runner") {
    return "border-[var(--ec-info-ring)] bg-[var(--ec-info-soft)]";
  }
  if (role === "forge") {
    return "border-violet-500/25 bg-violet-500/5";
  }
  if (role === "ui-review" || role === "user") {
    return "border-[var(--ec-warning)]/25 bg-[var(--ec-warning)]/5";
  }
  if (role === "audit") {
    return "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)]";
  }
  return "border-zinc-800 bg-zinc-950/50";
};

const eventRoleIcon = (role: ProjectLoopEventRecord["role"]) => {
  if (role === "runner") return <Rocket className="h-3.5 w-3.5 text-[var(--ec-info)]" />;
  if (role === "planner") return <Bot className="h-3.5 w-3.5 text-cyan-300" />;
  if (role === "forge") return <GitPullRequest className="h-3.5 w-3.5 text-violet-300" />;
  if (role === "ui-review") return <ImageIcon className="h-3.5 w-3.5 text-[var(--ec-warning)]" />;
  if (role === "audit") return <ShieldCheck className="h-3.5 w-3.5 text-[var(--ec-success)]" />;
  if (role === "user") return <Check className="h-3.5 w-3.5 text-[var(--ec-warning)]" />;
  return null;
};

const StatusPill = (
  props:
    | { kind: "loop"; status: ProjectLoopStatus }
    | { kind: "iteration"; status: ProjectLoopIterationRecord["status"] },
) => (
  <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px]", statusToneClass(props.status))}>
    {props.kind === "loop" ? LOOP_STATUS_LABELS[props.status] : ITERATION_STATUS_LABELS[props.status]}
  </span>
);

const BetaBadge = () => (
  <span className="shrink-0 rounded-full border border-amber-400/35 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300">
    Beta
  </span>
);

const LOOP_EXPLAINER_STEPS: Array<{ Icon: typeof Bot; title: string; text: string }> = [
  {
    Icon: ListChecks,
    title: "Plan",
    text: "The agent inspects your repository and splits the request into one or more PR-sized iterations.",
  },
  {
    Icon: Wrench,
    title: "Implement",
    text: "Each iteration is built unattended in its own worktree by a local agent (Codex CLI or Claude Code).",
  },
  {
    Icon: ImageIcon,
    title: "UI check",
    text: "Affected pages are screenshotted automatically. You - or an AI reviewer - approve every page first.",
  },
  {
    Icon: GitPullRequest,
    title: "Pull request",
    text: "Changes are committed, pushed, and opened as a PR/MR through your GitHub/GitLab token. Optionally an AI review is posted on the PR.",
  },
  {
    Icon: GitMerge,
    title: "Merge & audit",
    text: "Review comments are answered and fixed until the PR merges. Then the next iteration starts; a final audit wraps up.",
  },
];

const LOOP_EXPLAINER_FACTS: Array<{ Icon: typeof Bot; title: string; text: string }> = [
  {
    Icon: Power,
    title: "Survives restarts",
    text: "Every step is persisted. Close BuildWarden and loops continue exactly where they stopped.",
  },
  {
    Icon: MonitorSmartphone,
    title: "Fully in the background",
    text: "No PR pages to babysit. Open a loop's detail page for progress, screenshots, and the agent output.",
  },
  {
    Icon: KeyRound,
    title: "What it needs",
    text: "A Git project with a GitHub/GitLab access token and a local Codex CLI or Claude Code model.",
  },
];

const LOOPS_EXPLAINER_COLLAPSED_STORAGE_KEY = "buildwarden:loops-explainer-collapsed";

const LoopsExplainer = () => {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(LOOPS_EXPLAINER_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(LOOPS_EXPLAINER_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        /* private mode or blocked storage; the toggle still works for this session */
      }
      return next;
    });
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-cyan-400" />
        <h3 className="text-sm font-medium text-zinc-100">What are agent loops?</h3>
        <BetaBadge />
        <button
          type="button"
          className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-100"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand explanation" : "Minimize explanation"}
          title={collapsed ? "Expand explanation" : "Minimize explanation"}
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {collapsed ? null : (
        <>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            A loop is a hands-off delivery pipeline: you describe a feature or fix once, and BuildWarden drives it from plan to merged
            pull requests - implementing, screenshotting, reviewing, and reacting to feedback until everything is on your target branch.
          </p>

          <div className="mt-4 grid gap-2 md:grid-cols-3 xl:grid-cols-5">
            {LOOP_EXPLAINER_STEPS.map(({ Icon, title, text }, index) => (
              <div key={title} className="relative rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/10 font-mono text-[11px] text-cyan-200">
                    {index + 1}
                  </span>
                  <Icon className="h-4 w-4 shrink-0 text-cyan-300" />
                  <span className="truncate text-xs font-medium text-zinc-100">{title}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">{text}</p>
                {index < LOOP_EXPLAINER_STEPS.length - 1 ? (
                  <ChevronRight className="absolute -right-2 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-zinc-700 xl:block" />
                ) : null}
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {LOOP_EXPLAINER_FACTS.map(({ Icon, title, text }) => (
              <div key={title} className="flex items-start gap-2.5 rounded-xl border border-zinc-800/70 bg-zinc-950/35 px-3 py-2.5">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-zinc-200">{title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{text}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-zinc-600">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            You stay in control: choose per loop whether PRs merge automatically or wait for approval, and how UI changes are reviewed.
            Loops can be cancelled, resumed, and deleted at any time.
          </p>
        </>
      )}
    </Card>
  );
};

const LoopListRow = ({ item, onSelect }: { item: ProjectLoopListItem; onSelect: (loopId: string) => void }) => {
  const { loop, iterations, pendingUiReviewCount } = item;
  const merged = iterations.filter((iteration) => iteration.status === "merged").length;
  const isActive = ACTIVE_LOOP_STATUSES.has(loop.status);
  return (
    <button
      type="button"
      className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-left transition hover:border-cyan-500/40"
      onClick={() => onSelect(loop.id)}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isActive ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400" /> : null}
        <span className="truncate text-sm text-zinc-100">{loop.name}</span>
        <StatusPill kind="loop" status={loop.status} />
        {pendingUiReviewCount > 0 ? (
          <span className="shrink-0 rounded-full border border-[var(--ec-warning)] bg-[var(--ec-warning)]/10 px-2 py-0.5 text-[10px] text-[var(--ec-warning)]">
            {pendingUiReviewCount} approval{pendingUiReviewCount === 1 ? "" : "s"} needed
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
        <span>
          {merged}/{iterations.length || "?"} merged
        </span>
        <span className="font-mono">{loop.baseBranch}</span>
        <span>{new Date(loop.createdAt).toLocaleDateString()}</span>
      </div>
    </button>
  );
};

const loopUnavailableReasonText = (availability: ProjectLoopAvailability): string => {
  if (availability.reason === "not-git") {
    return "Loops need a Git project with a GitHub or GitLab remote.";
  }
  if (availability.reason === "no-remote") {
    return 'Loops need an "origin" remote pointing at GitHub or GitLab.';
  }
  if (availability.reason === "no-forge-token") {
    const providerLabel = availability.provider === "gitlab" ? "GitLab" : "GitHub";
    return `Save a ${providerLabel} access token in the PR Review tab (${availability.repoLabel ?? "repository"}) so the loop can create and merge PRs in the background.`;
  }
  return "Loops need at least one enabled model from a local provider (Codex CLI or Claude Code), because only they can drive the app and capture screenshots.";
};

const LOOP_UI_REVIEW_DECISION_LABELS: Partial<Record<ProjectLoopUiReviewRecord["status"], string>> = {
  approved: "Approved by you",
  "changes-requested": "Changes requested by you",
  "ai-approved": "Approved by AI reviewer",
  "ai-changes-requested": "Changes requested by AI reviewer",
};

const IMAGE_DATA_URL_EXTENSIONS: ReadonlyArray<[prefix: string, extension: string]> = [
  ["data:image/jpeg", ".jpg"],
  ["data:image/webp", ".webp"],
  ["data:image/gif", ".gif"],
];

const imageDataUrlExtension = (imageDataUrl: string): string => {
  for (const [prefix, extension] of IMAGE_DATA_URL_EXTENSIONS) {
    if (imageDataUrl.startsWith(prefix)) {
      return extension;
    }
  }
  return ".png";
};

const trimUnderscores = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "_") {
    start += 1;
  }
  while (end > start && value[end - 1] === "_") {
    end -= 1;
  }
  return value.slice(start, end);
};

const loopUiReviewDownloadFileName = (review: ProjectLoopUiReviewRecord, imageDataUrl: string): string => {
  const base = trimUnderscores(review.pageName.replace(/[^\w.-]+/g, "_")) || "screenshot";
  return `${base}-round-${String(review.round)}${imageDataUrlExtension(imageDataUrl)}`;
};

const LoopUiReviewCard = ({
  review,
  busy,
  onDecision,
}: {
  review: ProjectLoopUiReviewRecord;
  busy: boolean;
  onDecision: (reviewId: string, decision: "approve" | "request-changes", feedback: string) => Promise<void>;
}) => {
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageMissing, setImageMissing] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.buildwarden
      .getProjectLoopUiReviewImage(review.id)
      .then((dataUrl) => {
        if (!disposed) {
          setImageDataUrl(dataUrl);
          setImageMissing(dataUrl === null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setImageMissing(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [review.id]);

  const decided = review.status !== "pending";
  const decisionLabel = LOOP_UI_REVIEW_DECISION_LABELS[review.status] ?? null;

  const submit = async (decision: "approve" | "request-changes") => {
    setSubmitting(true);
    try {
      await onDecision(review.id, decision, feedback);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ImageIcon className="h-4 w-4 shrink-0 text-[var(--ec-warning)]" />
          <span className="truncate text-sm font-medium text-zinc-100">{review.pageName}</span>
          <span className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-[10px] text-zinc-400">
            round {review.round}
          </span>
        </div>
        {decisionLabel ? (
          <span
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[11px]",
              review.status === "approved" || review.status === "ai-approved"
                ? "border-[var(--ec-success-ring)] bg-[var(--ec-success-soft)] text-[var(--ec-success)]"
                : "border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] text-[var(--ec-danger)]",
            )}
          >
            {decisionLabel}
          </span>
        ) : null}
      </div>
      {review.description ? <p className="mt-1 text-xs text-zinc-500">{review.description}</p> : null}
      <div className="mt-2 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
        {imageDataUrl ? (
          <button
            type="button"
            className="block w-full cursor-zoom-in outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-400"
            title={`Open ${review.pageName} full size`}
            aria-label={`Open ${review.pageName} full size`}
            onClick={() => setLightboxOpen(true)}
          >
            <img src={imageDataUrl} alt={`Screenshot of ${review.pageName}`} className="max-h-[420px] w-full object-contain" />
          </button>
        ) : (
          <div className="flex h-32 items-center justify-center text-xs text-zinc-600">
            {imageMissing ? "Screenshot is no longer available." : "Loading screenshot..."}
          </div>
        )}
      </div>
      {lightboxOpen && imageDataUrl ? (
        <ImageLightbox
          imageUrl={imageDataUrl}
          title={`${review.pageName} (round ${String(review.round)})`}
          downloadFileName={loopUiReviewDownloadFileName(review, imageDataUrl)}
          onClose={() => setLightboxOpen(false)}
        />
      ) : null}
      {review.feedback ? (
        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-300">
          {review.feedback}
        </p>
      ) : null}
      {!decided ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Optional for approval; required when requesting changes: what should look different on this page?"
            className="min-h-[56px] text-xs"
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={busy || submitting} onClick={() => void submit("approve")}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Approve page
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || submitting || !feedback.trim()}
              onClick={() => void submit("request-changes")}
            >
              <MessageSquareWarning className="mr-1.5 h-3.5 w-3.5" />
              Request changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const LoopDetailView = ({
  loopId,
  busy,
  onBack,
  onOpenRun,
  onLoopsChanged,
}: {
  loopId: string;
  busy: boolean;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
  onLoopsChanged: () => void | Promise<void>;
}) => {
  const [detail, setDetail] = useState<ProjectLoopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [expandedIterationIds, setExpandedIterationIds] = useState<Record<string, boolean>>({});
  const reloadTimerRef = useRef<number | null>(null);

  const reloadDetail = useCallback(async () => {
    try {
      setDetail(await window.buildwarden.getProjectLoopDetail(loopId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the loop.");
    }
  }, [loopId]);

  useEffect(() => {
    void reloadDetail();
    const unsubscribe = window.buildwarden.onProjectLoopChanged((payload) => {
      if (payload.loopId !== loopId) {
        return;
      }
      if (reloadTimerRef.current !== null) {
        return;
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void reloadDetail();
      }, 250);
    });
    return () => {
      unsubscribe();
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [loopId, reloadDetail]);

  const runAction = useCallback(
    async (action: () => Promise<void>, options?: { reloadAfter?: boolean }) => {
      setActionPending(true);
      setError(null);
      try {
        await action();
        if (options?.reloadAfter !== false) {
          await reloadDetail();
        }
        await onLoopsChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The loop action failed.");
      } finally {
        setActionPending(false);
      }
    },
    [onLoopsChanged, reloadDetail],
  );

  const handleUiDecision = useCallback(
    async (reviewId: string, decision: "approve" | "request-changes", feedback: string) => {
      setError(null);
      try {
        await window.buildwarden.respondToProjectLoopUiReview(reviewId, {
          decision,
          feedback: feedback.trim() || undefined,
        });
        await reloadDetail();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The review could not be submitted.");
      }
    },
    [reloadDetail],
  );

  if (!detail) {
    return (
      <Card className="flex min-h-[240px] items-center justify-center p-8">
        {error ? <p className="text-sm text-rose-300">{error}</p> : <Loader2 className="h-8 w-8 animate-spin text-cyan-400" />}
      </Card>
    );
  }

  const { loop, iterations, events, uiReviews, runs } = detail;
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const pendingReviews = uiReviews.filter((review) => review.status === "pending");
  const isActive = ACTIVE_LOOP_STATUSES.has(loop.status);
  const visibleEvents = showAllEvents ? events : events.slice(-14);
  const mergedCount = iterations.filter((iteration) => iteration.status === "merged").length;

  return (
    <div className="space-y-3 pb-2">
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-8 w-8 shrink-0 px-0" onClick={onBack} title="Back to loops">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            {isActive ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cyan-400" /> : <RefreshCw className="h-4 w-4 shrink-0 text-cyan-400" />}
            <h3 className="truncate text-sm font-medium text-zinc-100">{loop.name}</h3>
            <StatusPill kind="loop" status={loop.status} />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isActive ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || actionPending}
                onClick={() => void runAction(() => window.buildwarden.cancelProjectLoop(loop.id))}
              >
                <Square className="mr-1.5 h-3.5 w-3.5" />
                Cancel loop
              </Button>
            ) : null}
            {!isActive && loop.status !== "completed" ? (
              <Button
                type="button"
                size="sm"
                disabled={busy || actionPending}
                onClick={() => void runAction(() => window.buildwarden.resumeProjectLoop(loop.id))}
              >
                <Play className="mr-1.5 h-3.5 w-3.5" />
                Resume
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-zinc-500 hover:text-rose-200"
              disabled={busy || actionPending}
              onClick={() => {
                if (window.confirm("Delete this loop, its runs, and its screenshots? Created PRs/MRs stay on the Git host.")) {
                  // The loop is gone after this action; reloading its detail would just fail.
                  void runAction(
                    async () => {
                      await window.buildwarden.deleteProjectLoop(loop.id);
                      onBack();
                    },
                    { reloadAfter: false },
                  );
                }
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
          <span>
            Target <span className="font-mono text-zinc-300">{loop.baseBranch}</span>
          </span>
          <span>{MERGE_POLICY_OPTIONS.find((option) => option.value === loop.mergePolicy)?.label}</span>
          <span>UI: {UI_POLICY_OPTIONS.find((option) => option.value === loop.uiChangePolicy)?.label}</span>
          <span>Review: {PR_REVIEW_POLICY_OPTIONS.find((option) => option.value === loop.prReviewPolicy)?.label ?? "No automatic review"}</span>
          <span>
            {mergedCount}/{iterations.length || "?"} PRs merged
          </span>
          <span>{new Date(loop.createdAt).toLocaleString()}</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950/50 px-2.5 py-1.5 text-xs text-zinc-400">
          {loop.prompt}
        </p>
        {loop.planSummary ? <p className="mt-2 text-xs text-zinc-500">{loop.planSummary}</p> : null}
        {loop.errorMessage ? <p className="mt-2 text-xs text-rose-300">{loop.errorMessage}</p> : null}
        {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
      </Card>

      {pendingReviews.length > 0 ? (
        <Card className="border-[var(--ec-warning)]/40 p-3">
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-[var(--ec-warning)]" />
            <h4 className="text-sm font-medium text-zinc-100">
              UI approval required ({pendingReviews.length} page{pendingReviews.length === 1 ? "" : "s"})
            </h4>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            The loop pauses until every page is approved. Requesting changes sends your feedback back to the implementation agent.
          </p>
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            {pendingReviews.map((review) => (
              <LoopUiReviewCard key={review.id} review={review} busy={busy || actionPending} onDecision={handleUiDecision} />
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="p-3">
        <div className="flex items-center gap-2">
          <GitMerge className="h-4 w-4 text-cyan-400" />
          <h4 className="text-sm font-medium text-zinc-100">Plan &amp; pull requests</h4>
        </div>
        <div className="mt-2 space-y-2">
          {iterations.length === 0 ? (
            <p className="text-xs text-zinc-500">The planning agent has not produced the iteration plan yet.</p>
          ) : (
            iterations.map((iteration) => {
              const run = iteration.runId ? runsById.get(iteration.runId) : undefined;
              const iterationReviews = uiReviews.filter((review) => review.iterationId === iteration.id && review.status !== "pending");
              const isExpanded = expandedIterationIds[iteration.id] ?? false;
              return (
                <div key={iteration.id} className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                  <div
                    className="flex cursor-pointer flex-wrap items-center justify-between gap-2"
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedIterationIds((current) => ({ ...current, [iteration.id]: !isExpanded }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpandedIterationIds((current) => ({ ...current, [iteration.id]: !isExpanded }));
                      }
                    }}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                        {iteration.iterationIndex + 1}
                      </span>
                      <span className="truncate text-sm text-zinc-100">{iteration.title}</span>
                      <StatusPill kind="iteration" status={iteration.status} />
                      <span className="text-zinc-600">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {iteration.prUrl ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-zinc-400 hover:text-cyan-200"
                          onClick={(event) => {
                            event.stopPropagation();
                            void window.buildwarden.openExternalUrl(iteration.prUrl ?? "");
                          }}
                        >
                          <GitPullRequest className="mr-1 h-3.5 w-3.5" />
                          {iteration.prNumber ? `#${iteration.prNumber}` : "PR"}
                        </Button>
                      ) : null}
                      {run ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-zinc-400 hover:text-cyan-200"
                          title="Open the agent run output"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenRun(run.id);
                          }}
                        >
                          <ExternalLink className="mr-1 h-3.5 w-3.5" />
                          Agent output
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="mt-2 space-y-2 border-t border-zinc-800/70 pt-2">
                      <p className="whitespace-pre-wrap break-words text-xs text-zinc-400">{iteration.objective}</p>
                      {iteration.branchName ? (
                        <p className="font-mono text-[11px] text-zinc-500">
                          {iteration.branchName} → {iteration.targetBranch ?? "?"}
                        </p>
                      ) : null}
                      {iteration.errorMessage ? <p className="text-xs text-rose-300">{iteration.errorMessage}</p> : null}
                      {iterationReviews.length > 0 ? (
                        <div className="grid gap-2 xl:grid-cols-2">
                          {iterationReviews.map((review) => (
                            <LoopUiReviewCard key={review.id} review={review} busy={busy || actionPending} onDecision={handleUiDecision} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </Card>

      <Card className="p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-cyan-400" />
            <h4 className="text-sm font-medium text-zinc-100">Activity</h4>
          </div>
          {events.length > visibleEvents.length || showAllEvents ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setShowAllEvents((v) => !v)}>
              {showAllEvents ? "Show recent" : `Show all (${events.length})`}
            </Button>
          ) : null}
        </div>
        <div className="mt-2 space-y-1.5">
          {visibleEvents.length === 0 ? (
            <p className="text-xs text-zinc-500">No activity yet.</p>
          ) : (
            visibleEvents.map((event) => (
              <div key={event.id} className={cn("rounded-lg border px-2.5 py-1.5 text-sm leading-relaxed", eventToneClass(event.role))}>
                <div className="mb-0.5 flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {eventRoleIcon(event.role)}
                    <span className="truncate">{event.label}</span>
                  </span>
                  <span className="shrink-0 font-normal normal-case tracking-normal text-zinc-600">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="whitespace-pre-wrap break-words text-xs text-zinc-300">{event.content}</div>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
};

export const ProjectLoopsTab = ({
  project,
  modelOptions,
  branchOptions,
  busy,
  availability,
  onOpenRun,
  onLoopsChanged,
}: ProjectLoopsTabProps) => {
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null);
  const [loopListSection, setLoopListSection] = useState<LoopListSection>("open");
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [runnerModelId, setRunnerModelId] = useState("");
  const [reviewModelId, setReviewModelId] = useState("");
  const [mergePolicy, setMergePolicy] = useState<ProjectLoopMergePolicy>("wait-for-approval");
  const [uiChangePolicy, setUiChangePolicy] = useState<ProjectLoopUiChangePolicy>("manual-approval");
  const [prReviewPolicy, setPrReviewPolicy] = useState<ProjectLoopPrReviewPolicy>("none");
  const [uiReviewInstructions, setUiReviewInstructions] = useState("");
  const [baseBranch, setBaseBranch] = useState(project.project.defaultBranch);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const localModelOptions = useMemo(
    () => modelOptions.filter((option) => isLoopCapableProviderType(option.providerType)),
    [modelOptions],
  );
  const effectiveRunnerModelId =
    runnerModelId && localModelOptions.some((option) => option.id === runnerModelId)
      ? runnerModelId
      : (localModelOptions[0]?.id ?? "");
  const loops = useMemo(
    () => [...project.loops].sort((left, right) => right.loop.createdAt.localeCompare(left.loop.createdAt)),
    [project.loops],
  );
  // "Merged" = the loop completed, i.e. all of its PRs were merged. Failed
  // and in-progress loops stay under "Open"; cancelled loops have their own bucket.
  const mergedLoops = useMemo(() => loops.filter((item) => item.loop.status === "completed"), [loops]);
  const cancelledLoops = useMemo(() => loops.filter((item) => item.loop.status === "cancelled"), [loops]);
  const openLoops = useMemo(
    () => loops.filter((item) => item.loop.status !== "completed" && item.loop.status !== "cancelled"),
    [loops],
  );
  let visibleLoops = cancelledLoops;
  if (loopListSection === "open") {
    visibleLoops = openLoops;
  } else if (loopListSection === "merged") {
    visibleLoops = mergedLoops;
  }
  const selectedLoop = selectedLoopId ? loops.find((item) => item.loop.id === selectedLoopId) ?? null : null;

  useEffect(() => {
    if (selectedLoopId && !project.loops.some((item) => item.loop.id === selectedLoopId)) {
      setSelectedLoopId(null);
    }
  }, [project.loops, selectedLoopId]);

  // The tab stays mounted when the selected project changes; reset the draft so
  // e.g. a base branch from the previous repo cannot leak into the next loop.
  useEffect(() => {
    setSelectedLoopId(null);
    setLoopListSection("open");
    setFormOpen(false);
    setName("");
    setPrompt("");
    setUiReviewInstructions("");
    setBaseBranch(project.project.defaultBranch);
    setCreateError(null);
  }, [project.project.id, project.project.defaultBranch]);

  const normalizedBranchOptions = branchOptions.filter(Boolean);

  const submitLoop = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const loop = await window.buildwarden.createProjectLoop({
        projectId: project.project.id,
        name: name.trim() || prompt.trim().slice(0, 80),
        prompt: prompt.trim(),
        runnerModelId: effectiveRunnerModelId,
        reviewModelId: reviewModelId || null,
        mergePolicy,
        uiChangePolicy,
        prReviewPolicy,
        uiReviewInstructions: uiReviewInstructions.trim() || null,
        baseBranch: baseBranch || project.project.defaultBranch,
      });
      setName("");
      setPrompt("");
      setUiReviewInstructions("");
      setFormOpen(false);
      await onLoopsChanged();
      setSelectedLoopId(loop.id);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "The loop could not be started.");
    } finally {
      setCreating(false);
    }
  };

  if (availability && !availability.available) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
      <Card className="p-6 text-center">
        <RefreshCw className="mx-auto h-6 w-6 text-cyan-400" />
        <p className="mt-3 text-sm font-medium text-zinc-100">Loops are not available for this project yet</p>
        <p className="mx-auto mt-2 max-w-md text-xs text-zinc-500">
          {loopUnavailableReasonText(availability)}
        </p>
      </Card>
      </div>
    );
  }

  if (selectedLoop) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <LoopDetailView
          loopId={selectedLoop.loop.id}
          busy={busy}
          onBack={() => setSelectedLoopId(null)}
          onOpenRun={onOpenRun}
          onLoopsChanged={onLoopsChanged}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <RefreshCw className="h-4 w-4 text-cyan-400" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-zinc-100">Loops</h3>
                <BetaBadge />
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">
                Describe a feature or fix; the loop plans it, implements it PR by PR, waits for merges, and addresses review comments - fully in the background.
              </p>
            </div>
          </div>
          <Button type="button" className="h-9" onClick={() => setFormOpen((open) => !open)}>
            {formOpen ? <X className="mr-2 h-4 w-4" /> : <Rocket className="mr-2 h-4 w-4" />}
            {formOpen ? "Close" : "New loop"}
          </Button>
        </div>

        {formOpen ? (
          <div className="px-4 py-4">
            <div className="grid gap-3 lg:grid-cols-2">
              <label className="space-y-1.5 lg:col-span-2">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">What should be built or fixed?</span>
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Describe the feature or fix. The loop plans it, splits it into PRs when useful, and implements them one by one."
                  className="min-h-[96px]"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Name (optional)</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Defaults to the prompt" />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Target branch</span>
                <Select
                  value={baseBranch || project.project.defaultBranch}
                  onValueChange={setBaseBranch}
                  options={(normalizedBranchOptions.length ? normalizedBranchOptions : [project.project.defaultBranch]).map((branch) => ({
                    value: branch,
                    label: branch,
                  }))}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Implementation model (local providers only)</span>
                <Select
                  value={effectiveRunnerModelId}
                  onValueChange={setRunnerModelId}
                  options={
                    localModelOptions.length
                      ? localModelOptions.map((option) => ({ value: option.id, label: option.label }))
                      : [{ value: "", label: "No Codex CLI / Claude Code model configured" }]
                  }
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Review model (optional)</span>
                <Select
                  value={reviewModelId}
                  onValueChange={setReviewModelId}
                  options={[
                    { value: "", label: "Same as implementation model" },
                    ...localModelOptions.map((option) => ({ value: option.id, label: option.label })),
                  ]}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Merging</span>
                <Select
                  value={mergePolicy}
                  onValueChange={(value) => setMergePolicy(value as ProjectLoopMergePolicy)}
                  options={MERGE_POLICY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  }))}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">UI changes</span>
                <Select
                  value={uiChangePolicy}
                  onValueChange={(value) => setUiChangePolicy(value as ProjectLoopUiChangePolicy)}
                  options={UI_POLICY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  }))}
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">PR code review</span>
                <Select
                  value={prReviewPolicy}
                  onValueChange={(value) => setPrReviewPolicy(value as ProjectLoopPrReviewPolicy)}
                  options={PR_REVIEW_POLICY_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    description: option.description,
                  }))}
                />
              </label>
              {uiChangePolicy !== "auto" ? (
                <label className="space-y-1.5 lg:col-span-2">
                  <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">Screenshot notes for the agent (optional)</span>
                  <Textarea
                    value={uiReviewInstructions}
                    onChange={(event) => setUiReviewInstructions(event.target.value)}
                    placeholder="e.g. how to start the app, which viewport size to use, test credentials. The agent figures out screenshot capture itself; these notes are simply added to its prompt."
                    className="min-h-[56px] text-xs"
                  />
                </label>
              ) : null}
            </div>
            {createError ? <p className="mt-2 text-xs text-rose-300">{createError}</p> : null}
            <div className="mt-3 flex items-center justify-end">
              <Button
                type="button"
                className="h-10"
                disabled={busy || creating || !prompt.trim() || !effectiveRunnerModelId}
                onClick={() => void submitLoop()}
              >
                {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}
                Start loop
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-cyan-400" />
            <h3 className="text-sm font-medium text-zinc-100">Loop runs</h3>
          </div>
          {loops.length > 0 ? (
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
              {(
                [
                  { section: "open" as const, label: "Open", Icon: RefreshCw, count: openLoops.length },
                  { section: "merged" as const, label: "Merged", Icon: GitMerge, count: mergedLoops.length },
                  { section: "cancelled" as const, label: "Cancelled", Icon: X, count: cancelledLoops.length },
                ]
              ).map(({ section, label, Icon, count }) => (
                <button
                  key={section}
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition",
                    loopListSection === section
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-200",
                  )}
                  aria-pressed={loopListSection === section}
                  onClick={() => setLoopListSection(section)}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                  <span className="rounded-full border border-zinc-700/70 bg-zinc-900/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                    {count}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="mt-3 space-y-2">
          {loops.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-10 text-center text-sm text-zinc-500">
              No loops yet. Start one and BuildWarden plans, implements, opens PRs, waits for merges, and addresses review comments on its own.
            </div>
          ) : null}
          {loops.length > 0 && visibleLoops.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800/70 bg-zinc-950/30 px-3 py-2 text-xs text-zinc-600">
              {LOOP_LIST_EMPTY_MESSAGES[loopListSection]}
            </p>
          ) : null}
          {visibleLoops.map((item) => (
            <LoopListRow key={item.loop.id} item={item} onSelect={setSelectedLoopId} />
          ))}
        </div>
      </Card>
      </div>

      <div className="shrink-0 pt-3">
        <LoopsExplainer />
      </div>
    </div>
  );
};
