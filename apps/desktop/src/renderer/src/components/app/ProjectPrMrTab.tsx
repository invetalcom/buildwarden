import type {
  ProjectForgeActivityItem,
  ProjectForgeAuthStatus,
  ProjectForgeCommitSummary,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectForgeReviewThread,
  ProjectPrMrDiffComment,
  ProjectPrMrDiffResult,
  ProviderType,
  RunDiffReviewFinding,
  RunDiffReviewResult,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  ChevronDown,
  CheckCircle2,
  Columns2,
  ClipboardList,
  Eye,
  ExternalLink,
  FileText,
  GitPullRequest,
  Info,
  KeyRound,
  Loader2,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Rows2,
  Search,
  Sparkles,
  SquarePen,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { ActivityRichText } from "../ui/activity-rich-text";
import { DiffReviewPanel, type DiffReviewPanelState } from "./diff-review-panel";
import { AgentLogRow, AgentWorklog, type AgentWorklogTone } from "./agent-worklog";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import {
  GitDiffPreview,
  type DiffLineCommentTarget,
  type DiffPreviewFileSummary,
  type DiffPreviewManualComment,
  type GitDiffPreviewHandle,
} from "./git-diff-preview";
import { countChangedFilesInDiff } from "./git-diff-utils";
import {
  buildPrMrFileNavItems,
  buildRemoteDiffComments,
  buildReviewThreadCodeLines,
  normalizeRequestDetailTab,
  pathsMatch,
  type DraftDiffComment,
  type RequestDetailTab,
  type ReviewThreadCodeLine,
} from "./project-pr-mr-review-helpers";

interface ProjectPrMrTabProps {
  projectId: string;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  initialRequest?: { url: string; requestId: number } | null;
  onOpenProjectSettings: () => void;
}

const requestStateOptions: Array<{ id: ProjectForgeRequestState; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
];

const REQUEST_PREFETCH_LIMIT = 5;
const REQUEST_LIST_WIDTH_STORAGE_KEY = "buildwarden:project-pr-mr-request-list-width";
const DEFAULT_REQUEST_LIST_WIDTH = 288;
const MIN_REQUEST_LIST_WIDTH = 220;
const MAX_REQUEST_LIST_WIDTH = 520;

const clampRequestListWidth = (width: number) => Math.min(MAX_REQUEST_LIST_WIDTH, Math.max(MIN_REQUEST_LIST_WIDTH, Math.round(width)));

const readStoredRequestListWidth = () => {
  try {
    const raw = window.localStorage.getItem(REQUEST_LIST_WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_REQUEST_LIST_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? clampRequestListWidth(parsed) : DEFAULT_REQUEST_LIST_WIDTH;
  } catch {
    return DEFAULT_REQUEST_LIST_WIDTH;
  }
};

const writeStoredRequestListWidth = (width: number) => {
  try {
    window.localStorage.setItem(REQUEST_LIST_WIDTH_STORAGE_KEY, String(clampRequestListWidth(width)));
  } catch {
    // Local storage can be unavailable in constrained webviews; resizing should still work for the session.
  }
};

const emptyReviewPanel = (): DiffReviewPanelState => ({ result: null, busy: false, error: null });

const formatShortDate = (value: string | null) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const formatActivityDate = (value: string | null) => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const providerLabel = (provider: "github" | "gitlab") => (provider === "gitlab" ? "MR" : "PR");

const requestDiffCacheKey = (url: string, commitSha?: string | null) => `${url.trim()}\0${commitSha?.trim() || "all"}`;

const commitTitleForActivity = (commit: ProjectForgeCommitSummary | null | undefined, fallbackSha: string) =>
  commit?.title?.trim() || fallbackSha.slice(0, 12);

const requestStateTone = (state: string) => {
  if (state === "merged") {
    return "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]";
  }
  if (state === "closed") {
    return "border-rose-500/30 bg-rose-500/[0.08] text-rose-200";
  }
  return "border-cyan-500/30 bg-cyan-500/[0.08] text-cyan-100";
};

const activityKindTone = (kind: ProjectForgeActivityItem["kind"]) => {
  if (kind === "review") return "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]";
  if (kind === "diff-comment") return "border-cyan-500/25 bg-cyan-500/[0.08] text-cyan-100";
  if (kind === "state") return "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200";
  if (kind === "event") return "border-zinc-700 bg-zinc-800/45 text-zinc-300";
  return "border-blue-500/25 bg-blue-500/[0.08] text-blue-100";
};

const formatReviewBody = (review: RunDiffReviewResult): string => {
  const lines = [
    "## BuildWarden AI review",
    "",
    `**${review.scoreLabel}:** ${String(review.score)}/100`,
    "",
    review.summary,
  ];

  if (review.strengths.length > 0) {
    lines.push("", "### Strengths", ...review.strengths.map((strength) => `- ${strength}`));
  }

  if (review.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of review.findings) {
      const location = [finding.filePath, finding.lineReference].filter(Boolean).join(" - ");
      lines.push(`- **${finding.priority.toUpperCase()}** ${finding.title}${location ? ` (${location})` : ""}`);
      lines.push(`  ${finding.detail}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  } else {
    lines.push("", "### Findings", "- No concrete findings were generated.");
  }

  if (review.nextSteps.length > 0) {
    lines.push("", "### Suggested next steps", ...review.nextSteps.map((step) => `- ${step}`));
  }

  return lines.join("\n");
};

type ProjectPrMrMeta = { provider: "github" | "gitlab"; number: number; baseRef: string };
type ProjectPrMrSessionState = {
  prUrl: string;
  baseBranch: string;
  diffText: string;
  meta: ProjectPrMrMeta | null;
  requestState: ProjectForgeRequestState;
  requestItems: ProjectForgeRequestSummary[];
  requestRepoLabel: string;
  requestProvider: "github" | "gitlab" | null;
  selectedRequest: ProjectForgeRequestSummary | null;
  requestDetails: ProjectForgeRequestDetailsResult | null;
  activeDetailTab: RequestDetailTab;
  selectedCommitSha: string | null;
  diffViewType: "unified" | "split";
  hideWhitespaceChanges: boolean;
  activeDiffFilePath: string | null;
  diffFileQuery: string;
  detailsCache: Map<string, ProjectForgeRequestDetailsResult>;
  diffCache: Map<string, ProjectPrMrDiffResult>;
};

const projectPrMrSessionCache = new Map<string, ProjectPrMrSessionState>();

const hasProjectPrMrSessionData = (session: ProjectPrMrSessionState) =>
  session.requestItems.length > 0 || session.prUrl.trim().length > 0 || session.diffText.trim().length > 0 || Boolean(session.requestDetails);

const getProjectPrMrSession = (projectId: string) => {
  const cached = projectPrMrSessionCache.get(projectId) ?? null;
  return cached && hasProjectPrMrSessionData(cached) ? cached : null;
};

const toSubmittedDiffComment = (comment: DraftDiffComment): ProjectPrMrDiffComment => ({
  oldPath: comment.oldPath,
  newPath: comment.newPath,
  side: comment.side,
  oldLineNumber: comment.oldLineNumber,
  newLineNumber: comment.newLineNumber,
  changeType: comment.changeType,
  body: comment.body,
});

const toDiffLineCommentTarget = (comment: DraftDiffComment): DiffLineCommentTarget => ({
  oldPath: comment.oldPath,
  newPath: comment.newPath,
  side: comment.side,
  oldLineNumber: comment.oldLineNumber,
  newLineNumber: comment.newLineNumber,
  changeType: comment.changeType,
  displayPath: comment.displayPath,
  lineLabel: comment.lineLabel,
  changeKey: comment.id,
});

const formatFindingDraftCommentBody = (finding: RunDiffReviewFinding): string => {
  const lines = [finding.title, "", finding.detail];
  if (finding.recommendation) {
    lines.push(`Suggestion: ${finding.recommendation}`);
  }
  return lines.join("\n").trim();
};

const formatAppErrorMessage = (error: unknown, fallback: string) => {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
};

export const ProjectPrMrTab = ({ projectId, modelOptions, defaultModelId, initialRequest = null, onOpenProjectSettings }: ProjectPrMrTabProps) => {
  const initialSession = getProjectPrMrSession(projectId);
  const [prUrl, setPrUrl] = useState(() => initialSession?.prUrl ?? "");
  const [baseBranch, setBaseBranch] = useState(() => initialSession?.baseBranch ?? "");
  const [diffText, setDiffText] = useState(() => initialSession?.diffText ?? "");
  const [meta, setMeta] = useState<ProjectPrMrMeta | null>(() => initialSession?.meta ?? null);
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewModelId, setReviewModelId] = useState(defaultModelId);
  const [reviewPanel, setReviewPanel] = useState<DiffReviewPanelState>(emptyReviewPanel);
  const [requestState, setRequestState] = useState<ProjectForgeRequestState>(() => initialSession?.requestState ?? "open");
  const [requestItems, setRequestItems] = useState<ProjectForgeRequestSummary[]>(() => initialSession?.requestItems ?? []);
  const [requestRepoLabel, setRequestRepoLabel] = useState(() => initialSession?.requestRepoLabel ?? "");
  const [requestProvider, setRequestProvider] = useState<"github" | "gitlab" | null>(() => initialSession?.requestProvider ?? null);
  const [forgeAuthStatus, setForgeAuthStatus] = useState<ProjectForgeAuthStatus | null>(null);
  const [forgeAuthStatusBusy, setForgeAuthStatusBusy] = useState(false);
  const [forgeAuthStatusError, setForgeAuthStatusError] = useState<string | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<ProjectForgeRequestSummary | null>(() => initialSession?.selectedRequest ?? null);
  const [requestDetails, setRequestDetails] = useState<ProjectForgeRequestDetailsResult | null>(() => initialSession?.requestDetails ?? null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [postBusy, setPostBusy] = useState(false);
  const [postMessage, setPostMessage] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [replyThreadText, setReplyThreadText] = useState("");
  const [threadActionBusyId, setThreadActionBusyId] = useState<string | null>(null);
  const [confirmResolveThreadId, setConfirmResolveThreadId] = useState<string | null>(null);
  const [activeCommentTarget, setActiveCommentTarget] = useState<DiffLineCommentTarget | null>(null);
  const [draftCommentText, setDraftCommentText] = useState("");
  const [editingDraftCommentId, setEditingDraftCommentId] = useState<string | null>(null);
  const [draftComments, setDraftComments] = useState<DraftDiffComment[]>([]);
  const [reviewDraftMode, setReviewDraftMode] = useState(false);
  const [manualSubmitBusy, setManualSubmitBusy] = useState(false);
  const [singleSubmitBusy, setSingleSubmitBusy] = useState(false);
  const [aiReviewMenuOpen, setAiReviewMenuOpen] = useState(false);
  const gitDiffPanelRef = useRef<GitDiffPreviewHandle>(null);
  const aiReviewMenuAnchorRef = useRef<HTMLDivElement>(null);
  const [allDiffFilesExpanded, setAllDiffFilesExpanded] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<RequestDetailTab>(() => normalizeRequestDetailTab(initialSession?.activeDetailTab));
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(() => initialSession?.selectedCommitSha ?? null);
  const [diffViewType, setDiffViewType] = useState<"unified" | "split">(() => initialSession?.diffViewType ?? "unified");
  const [hideWhitespaceChanges, setHideWhitespaceChanges] = useState(() => initialSession?.hideWhitespaceChanges ?? false);
  const [activeDiffFilePath, setActiveDiffFilePath] = useState<string | null>(() => initialSession?.activeDiffFilePath ?? null);
  const [diffFileQuery, setDiffFileQuery] = useState(() => initialSession?.diffFileQuery ?? "");
  const [parsedDiffFiles, setParsedDiffFiles] = useState<DiffPreviewFileSummary[]>([]);
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
  const requestDetailsCacheRef = useRef(initialSession?.detailsCache ?? new Map<string, ProjectForgeRequestDetailsResult>());
  const requestDetailsInFlightRef = useRef(new Map<string, Promise<ProjectForgeRequestDetailsResult>>());
  const requestDiffCacheRef = useRef(initialSession?.diffCache ?? new Map<string, ProjectPrMrDiffResult>());
  const requestDiffInFlightRef = useRef(new Map<string, Promise<ProjectPrMrDiffResult>>());
  const requestPreloadGenerationRef = useRef(0);
  const activeRequestUrlRef = useRef(initialSession?.selectedRequest?.url ?? initialSession?.prUrl.trim() ?? "");
  const hydratedProjectIdRef = useRef(projectId);
  const [requestListWidth, setRequestListWidth] = useState(readStoredRequestListWidth);
  const [requestListCollapsed, setRequestListCollapsed] = useState(false);
  const [fileNavigatorCollapsed, setFileNavigatorCollapsed] = useState(false);
  const [isRequestListResizing, setIsRequestListResizing] = useState(false);
  const requestListLayoutRef = useRef<HTMLDivElement>(null);
  const requestListResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const requestListWidthRef = useRef(requestListWidth);
  const requestListPendingWidthRef = useRef(requestListWidth);
  const requestListResizeFrameRef = useRef<number | null>(null);

  const clearDraftEditor = useCallback(() => {
    setActiveCommentTarget(null);
    setDraftCommentText("");
    setEditingDraftCommentId(null);
  }, []);

  const clearRequestPreloadCaches = useCallback(() => {
    requestPreloadGenerationRef.current += 1;
    requestDetailsCacheRef.current.clear();
    requestDetailsInFlightRef.current.clear();
    requestDiffCacheRef.current.clear();
    requestDiffInFlightRef.current.clear();
  }, []);

  useEffect(() => {
    if (hydratedProjectIdRef.current !== projectId) {
      return;
    }

    const nextSession = {
      prUrl,
      baseBranch,
      diffText,
      meta,
      requestState,
      requestItems,
      requestRepoLabel,
      requestProvider,
      selectedRequest,
      requestDetails,
      activeDetailTab,
      selectedCommitSha,
      diffViewType,
      hideWhitespaceChanges,
      activeDiffFilePath,
      diffFileQuery,
      detailsCache: requestDetailsCacheRef.current,
      diffCache: requestDiffCacheRef.current,
    };

    if (hasProjectPrMrSessionData(nextSession)) {
      projectPrMrSessionCache.set(projectId, nextSession);
    } else {
      projectPrMrSessionCache.delete(projectId);
    }
  }, [
    activeDetailTab,
    activeDiffFilePath,
    baseBranch,
    diffFileQuery,
    diffText,
    diffViewType,
    hideWhitespaceChanges,
    meta,
    prUrl,
    projectId,
    requestDetails,
    requestItems,
    requestProvider,
    requestRepoLabel,
    requestState,
    selectedRequest,
    selectedCommitSha,
  ]);

  useEffect(() => {
    setReviewModelId(defaultModelId);
  }, [defaultModelId, projectId]);

  useEffect(() => {
    requestListWidthRef.current = requestListWidth;
    requestListPendingWidthRef.current = requestListWidth;
  }, [requestListWidth]);

  const scheduleRequestListWidthUpdate = useCallback((width: number) => {
    const nextWidth = clampRequestListWidth(width);
    requestListPendingWidthRef.current = nextWidth;
    requestListWidthRef.current = nextWidth;

    if (requestListResizeFrameRef.current !== null) return;

    requestListResizeFrameRef.current = window.requestAnimationFrame(() => {
      requestListResizeFrameRef.current = null;
      requestListLayoutRef.current?.style.setProperty("--pr-mr-request-list-width", `${requestListPendingWidthRef.current}px`);
    });
  }, []);

  useEffect(() => {
    if (!isRequestListResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      const start = requestListResizeStartRef.current;
      if (!start) return;
      scheduleRequestListWidthUpdate(start.width + event.clientX - start.x);
    };

    const stopResizing = () => {
      const nextWidth = requestListWidthRef.current;
      if (requestListResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(requestListResizeFrameRef.current);
        requestListResizeFrameRef.current = null;
      }
      requestListLayoutRef.current?.style.setProperty("--pr-mr-request-list-width", `${nextWidth}px`);
      setIsRequestListResizing(false);
      requestListResizeStartRef.current = null;
      setRequestListWidth(nextWidth);
      writeStoredRequestListWidth(nextWidth);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResizing);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResizing);
      if (requestListResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(requestListResizeFrameRef.current);
        requestListResizeFrameRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isRequestListResizing, scheduleRequestListWidthUpdate]);

  const requestListLayoutStyle = useMemo(
    () =>
      ({
        "--pr-mr-request-list-width": `${requestListWidth}px`,
      }) as CSSProperties,
    [requestListWidth],
  );

  const startRequestListResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    requestListResizeStartRef.current = { x: event.clientX, width: requestListWidth };
    requestListWidthRef.current = requestListWidth;
    setIsRequestListResizing(true);
  };

  useEffect(() => {
    if (modelOptions.some((option) => option.id === reviewModelId)) {
      return;
    }
    setReviewModelId(modelOptions[0]?.id ?? "");
  }, [modelOptions, reviewModelId]);

  const reviewModelSelectOptions = useMemo(
    () =>
      modelOptions.map((option) => ({
        value: option.id,
        label: option.label,
        description: option.modelId,
      })),
    [modelOptions],
  );

  useEffect(() => {
    if (!aiReviewMenuOpen) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAiReviewMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [aiReviewMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    setForgeAuthStatus(null);
    setForgeAuthStatusError(null);
    setForgeAuthStatusBusy(true);
    void window.buildwarden
      .getProjectForgeAuthStatus(projectId)
      .then((status) => {
        if (!cancelled) {
          setForgeAuthStatus(status);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setForgeAuthStatusError(formatAppErrorMessage(error, "Could not read Git hosting token status."));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setForgeAuthStatusBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (hydratedProjectIdRef.current === projectId) {
      return;
    }

    const cached = getProjectPrMrSession(projectId);
    requestPreloadGenerationRef.current += 1;
    requestDetailsInFlightRef.current.clear();
    requestDiffInFlightRef.current.clear();

    if (cached) {
      requestDetailsCacheRef.current = cached.detailsCache;
      requestDiffCacheRef.current = cached.diffCache;
      activeRequestUrlRef.current = cached.selectedRequest?.url ?? cached.prUrl.trim();
      setRequestState(cached.requestState);
      setRequestItems(cached.requestItems);
      setRequestRepoLabel(cached.requestRepoLabel);
      setRequestProvider(cached.requestProvider);
      setSelectedRequest(cached.selectedRequest);
      setRequestDetails(cached.requestDetails);
      setPrUrl(cached.prUrl);
      setBaseBranch(cached.baseBranch);
      setDiffText(cached.diffText);
      setMeta(cached.meta);
      setActiveDetailTab(normalizeRequestDetailTab(cached.activeDetailTab));
      setSelectedCommitSha(cached.selectedCommitSha ?? null);
      setDiffViewType(cached.diffViewType ?? "unified");
      setHideWhitespaceChanges(cached.hideWhitespaceChanges ?? false);
      setActiveDiffFilePath(cached.activeDiffFilePath ?? null);
      setDiffFileQuery(cached.diffFileQuery ?? "");
    } else {
      requestDetailsCacheRef.current.clear();
      requestDiffCacheRef.current.clear();
      activeRequestUrlRef.current = "";
      setRequestState("open");
      setRequestItems([]);
      setRequestRepoLabel("");
      setRequestProvider(null);
      setSelectedRequest(null);
      setRequestDetails(null);
      setPrUrl("");
      setBaseBranch("");
      setDiffText("");
      setMeta(null);
      setActiveDetailTab("conversation");
      setSelectedCommitSha(null);
      setDiffViewType("unified");
      setHideWhitespaceChanges(false);
      setActiveDiffFilePath(null);
      setDiffFileQuery("");
    }

    hydratedProjectIdRef.current = projectId;
    setDetailsBusy(false);
    setLoadBusy(false);
    setListBusy(false);
    setManualSubmitBusy(false);
    setSingleSubmitBusy(false);
    setDetailsError(null);
    setLoadError(null);
    setListError(null);
    setPostMessage(null);
    setPostError(null);
    clearDraftEditor();
    setDraftComments([]);
    setReviewDraftMode(false);
    setConfirmResolveThreadId(null);
    setParsedDiffFiles([]);
    setHighlightedCommentId(null);
    setReviewPanel(emptyReviewPanel());
  }, [clearDraftEditor, projectId]);

  const diffChangedFileCount = useMemo(() => (diffText.trim() ? countChangedFilesInDiff(diffText) : 0), [diffText]);
  const reviewBusy = reviewPanel.busy;
  const hasDiff = diffText.trim().length > 0;
  const hasReviewState = reviewPanel.busy || Boolean(reviewPanel.result) || Boolean(reviewPanel.error);
  const activeUrl = selectedRequest?.url ?? prUrl.trim();
  const activeBaseBranch = selectedRequest?.targetBranch ?? baseBranch.trim();
  const activeKind = selectedRequest ? providerLabel(selectedRequest.provider) : meta ? providerLabel(meta.provider) : "PR/MR";
  const draftedReviewFindingKeys = useMemo(
    () => new Set(draftComments.map((comment) => comment.aiFindingKey).filter((key): key is string => Boolean(key))),
    [draftComments],
  );
  const visibleRequestDetails = requestDetails?.request.url === activeUrl ? requestDetails : null;
  const overviewRequest = visibleRequestDetails?.request ?? selectedRequest;
  const canUseForgeApi = forgeAuthStatus?.hasToken === true;

  useEffect(() => {
    activeRequestUrlRef.current = activeUrl.trim();
  }, [activeUrl]);

  const timelineActivity = useMemo(() => visibleRequestDetails?.activity ?? [], [visibleRequestDetails]);
  const reviewThreadByCommentId = useMemo(() => {
    const map = new Map<string, ProjectForgeReviewThread>();
    for (const thread of visibleRequestDetails?.reviewThreads ?? []) {
      for (const comment of thread.comments) {
        map.set(comment.id, thread);
      }
    }
    return map;
  }, [visibleRequestDetails]);
  const findReviewThreadForActivity = useCallback(
    (item: ProjectForgeActivityItem) => {
      const exact = reviewThreadByCommentId.get(item.id);
      if (exact) {
        return exact;
      }
      if (item.kind !== "diff-comment" || !item.path || !item.line) {
        return null;
      }
      return (
        visibleRequestDetails?.reviewThreads.find((thread) => {
          const line = thread.side === "old" ? thread.oldLineNumber : thread.newLineNumber;
          return line === item.line && pathsMatch(thread.path, item.path);
        }) ?? null
      );
    },
    [reviewThreadByCommentId, visibleRequestDetails],
  );
  const conversationActivity = useMemo(
    () =>
      timelineActivity.filter((item) => {
        if (item.kind !== "diff-comment") {
          return true;
        }
        const thread = findReviewThreadForActivity(item);
        return !thread || thread.comments[0]?.id === item.id;
      }),
    [findReviewThreadForActivity, timelineActivity],
  );
  const remoteDiffComments = useMemo<DiffPreviewManualComment[]>(
    () => buildRemoteDiffComments(visibleRequestDetails),
    [visibleRequestDetails],
  );
  const diffCommentTargets = useMemo<DiffPreviewManualComment[]>(
    () => [...remoteDiffComments, ...draftComments],
    [draftComments, remoteDiffComments],
  );
  const loadedOrReportedFileCount = diffChangedFileCount || visibleRequestDetails?.request.changedFiles || 0;
  const totalActivityCount = visibleRequestDetails?.activity.length ?? visibleRequestDetails?.request.commentCount ?? 0;
  const commitCount = visibleRequestDetails?.commits.length ?? 0;
  const shouldShowForgeTokenHint = forgeAuthStatus?.hasToken === false;
  const handleParsedDiffFilesChange = useCallback((files: DiffPreviewFileSummary[]) => {
    setParsedDiffFiles(files);
  }, []);

  const fileNavItems = useMemo(
    () => buildPrMrFileNavItems(visibleRequestDetails, parsedDiffFiles, draftComments),
    [draftComments, parsedDiffFiles, visibleRequestDetails],
  );

  const resetLoadedDiff = useCallback(() => {
    setDiffText("");
    setMeta(null);
    setLoadError(null);
    setReviewPanel(emptyReviewPanel());
    setAiReviewMenuOpen(false);
    setAllDiffFilesExpanded(false);
    setSelectedCommitSha(null);
    setActiveDiffFilePath(null);
    setDiffFileQuery("");
    setParsedDiffFiles([]);
    setHighlightedCommentId(null);
    setPostMessage(null);
    setPostError(null);
    setReplyThreadId(null);
    setReplyThreadText("");
    setThreadActionBusyId(null);
    setConfirmResolveThreadId(null);
    clearDraftEditor();
    setDraftComments([]);
    setReviewDraftMode(false);
  }, [clearDraftEditor]);

  const applyDiffResult = useCallback((result: ProjectPrMrDiffResult) => {
    setDiffText(result.diff);
    setMeta({ provider: result.provider, number: result.number, baseRef: result.baseRef });
  }, []);

  const fetchRequestDetails = useCallback(
    (targetUrl: string): Promise<ProjectForgeRequestDetailsResult> => {
      const url = targetUrl.trim();
      if (!url) {
        return Promise.reject(new Error("Enter a PR/MR URL first."));
      }

      const cached = requestDetailsCacheRef.current.get(url);
      if (cached) {
        return Promise.resolve(cached);
      }

      const inFlight = requestDetailsInFlightRef.current.get(url);
      if (inFlight) {
        return inFlight;
      }

      const generation = requestPreloadGenerationRef.current;
      const request = window.buildwarden
        .getProjectForgeRequestDetails(projectId, { prUrl: url })
        .then((result) => {
          if (requestPreloadGenerationRef.current === generation) {
            requestDetailsCacheRef.current.set(url, result);
          }
          return result;
        })
        .catch((error) => {
          const message = formatAppErrorMessage(error, "Could not load PR/MR description and activity.");
          throw new Error(message);
        })
        .finally(() => {
          if (requestDetailsInFlightRef.current.get(url) === request) {
            requestDetailsInFlightRef.current.delete(url);
          }
        });

      requestDetailsInFlightRef.current.set(url, request);
      return request;
    },
    [projectId],
  );

  const fetchRequestDiff = useCallback(
    (targetUrl: string, targetBaseBranch?: string, commitSha?: string | null): Promise<ProjectPrMrDiffResult> => {
      const url = targetUrl.trim();
      if (!url) {
        return Promise.reject(new Error("Enter a PR/MR URL or select a request first."));
      }
      const sha = commitSha?.trim() || null;

      if (!canUseForgeApi && !sha) {
        return window.buildwarden.fetchProjectPrMrDiff(projectId, {
          prUrl: url,
          baseBranch: targetBaseBranch?.trim() || undefined,
        });
      }

      const cacheKey = requestDiffCacheKey(url, sha);
      const cached = requestDiffCacheRef.current.get(cacheKey);
      if (cached) {
        return Promise.resolve(cached);
      }

      const inFlight = requestDiffInFlightRef.current.get(cacheKey);
      if (inFlight) {
        return inFlight;
      }

      const generation = requestPreloadGenerationRef.current;
      const request = window.buildwarden
        .fetchProjectPrMrDiff(projectId, {
          prUrl: url,
          baseBranch: targetBaseBranch?.trim() || undefined,
          commitSha: sha ?? undefined,
        })
        .then((result) => {
          if (requestPreloadGenerationRef.current === generation) {
            requestDiffCacheRef.current.set(cacheKey, result);
          }
          return result;
        })
        .catch((error) => {
          const message = formatAppErrorMessage(error, "Could not load the PR/MR diff.");
          throw new Error(message);
        })
        .finally(() => {
          if (requestDiffInFlightRef.current.get(cacheKey) === request) {
            requestDiffInFlightRef.current.delete(cacheKey);
          }
        });

      requestDiffInFlightRef.current.set(cacheKey, request);
      return request;
    },
    [canUseForgeApi, projectId],
  );

  const loadRequestDetails = useCallback(
    async (targetUrl: string, options: { silent?: boolean } = {}) => {
      const url = targetUrl.trim();
      if (!url) {
        if (!options.silent) {
          setRequestDetails(null);
        }
        return;
      }
      const cached = requestDetailsCacheRef.current.get(url);
      if (cached) {
        if (!options.silent && activeRequestUrlRef.current === url) {
          setRequestDetails(cached);
          setDetailsError(null);
        }
        return;
      }
      if (!options.silent) {
        setDetailsBusy(true);
        setDetailsError(null);
      }
      try {
        const result = await fetchRequestDetails(url);
        if (!options.silent && activeRequestUrlRef.current === url) {
          setRequestDetails(result);
        }
      } catch (error) {
        if (!options.silent && activeRequestUrlRef.current === url) {
          setRequestDetails(null);
          setDetailsError(formatAppErrorMessage(error, "Could not load PR/MR description and activity."));
        }
      } finally {
        if (!options.silent && activeRequestUrlRef.current === url) {
          setDetailsBusy(false);
        }
      }
    },
    [fetchRequestDetails],
  );

  const selectRequest = (request: ProjectForgeRequestSummary) => {
    activeRequestUrlRef.current = request.url;
    setSelectedRequest(request);
    setPrUrl(request.url);
    setBaseBranch(request.targetBranch);
    resetLoadedDiff();
    setActiveDetailTab("conversation");
    const cachedDetails = requestDetailsCacheRef.current.get(request.url);
    if (cachedDetails) {
      setRequestDetails(cachedDetails);
      setDetailsError(null);
    } else {
      setRequestDetails(null);
      void loadRequestDetails(request.url);
    }

    const cachedDiff = requestDiffCacheRef.current.get(requestDiffCacheKey(request.url));
    if (cachedDiff) {
      applyDiffResult(cachedDiff);
      setLoadError(null);
      return;
    }

    if (canUseForgeApi) {
      void fetchRequestDiff(request.url, request.targetBranch)
        .then((result) => {
          if (activeRequestUrlRef.current === request.url) {
            applyDiffResult(result);
            setLoadError(null);
          }
        })
        .catch(() => {
          /* Prefetch errors surface when the user explicitly opens Files changed. */
        });
    }
  };

  const loadRequests = async () => {
    if (!canUseForgeApi) {
      setListError("Add a Git hosting access token in Project Settings before fetching PRs/MRs.");
      return;
    }
    setListBusy(true);
    setListError(null);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.listProjectForgeRequests(projectId, { state: requestState });
      clearRequestPreloadCaches();
      setRequestItems(result.items);
      setRequestRepoLabel(result.repoLabel);
      setRequestProvider(result.provider);
      if (result.items.length > 0) {
        selectRequest(result.items[0]);
      } else {
        setSelectedRequest(null);
        setRequestDetails(null);
        resetLoadedDiff();
      }
    } catch (error) {
      setListError(formatAppErrorMessage(error, "Could not fetch PRs/MRs from the hosting API."));
    } finally {
      setListBusy(false);
    }
  };

  const loadDiff = async (options: { commitSha?: string | null } = {}) => {
    const targetUrl = activeUrl.trim();
    if (!targetUrl) {
      setLoadError("Enter a PR/MR URL or select a request first.");
      return;
    }
    const commitSha = options.commitSha?.trim() || null;
    setActiveDetailTab("files");
    setAiReviewMenuOpen(false);
    setSelectedCommitSha(commitSha);
    setLoadBusy(true);
    setLoadError(null);
    setMeta(null);
    setDiffText("");
    setActiveDiffFilePath(null);
    setDiffFileQuery("");
    setParsedDiffFiles([]);
    setHighlightedCommentId(null);
    setReviewPanel(emptyReviewPanel());
    setPostMessage(null);
    setPostError(null);
    setReplyThreadId(null);
    setReplyThreadText("");
    setThreadActionBusyId(null);
    setConfirmResolveThreadId(null);
    clearDraftEditor();
    try {
      if (canUseForgeApi) {
        void loadRequestDetails(targetUrl);
      } else {
        setRequestDetails(null);
        setDetailsError(null);
      }
      const result = await fetchRequestDiff(targetUrl, activeBaseBranch.trim() || undefined, commitSha);
      setPrUrl(targetUrl);
      applyDiffResult(result);
    } catch (error) {
      setLoadError(formatAppErrorMessage(error, "Could not load the PR/MR diff."));
    } finally {
      setLoadBusy(false);
    }
  };

  const loadManualRequest = async () => {
    const targetUrl = prUrl.trim();
    if (!targetUrl) {
      setDetailsError("Enter a PR/MR URL first.");
      return;
    }
    setSelectedRequest(null);
    setRequestDetails(null);
    setDetailsError(null);
    resetLoadedDiff();
    setPrUrl(targetUrl);
    activeRequestUrlRef.current = targetUrl;
    await loadDiff();
  };

  useEffect(() => {
    const targetUrl = initialRequest?.url.trim() ?? "";
    if (!targetUrl) {
      return;
    }

    activeRequestUrlRef.current = targetUrl;
    setSelectedRequest(null);
    setPrUrl(targetUrl);
    setBaseBranch("");
    setActiveDetailTab("conversation");
    resetLoadedDiff();

    if (canUseForgeApi) {
      void loadRequestDetails(targetUrl);
    }
  }, [canUseForgeApi, initialRequest?.requestId, initialRequest?.url, loadRequestDetails, resetLoadedDiff]);

  const preloadRequestData = useCallback(
    (request: ProjectForgeRequestSummary, generation: number) => {
      if (!canUseForgeApi) {
        return;
      }
      const url = request.url.trim();
      if (!url) {
        return;
      }

      void Promise.allSettled([fetchRequestDetails(url), fetchRequestDiff(url, request.targetBranch)]).then(() => {
        if (requestPreloadGenerationRef.current !== generation || activeRequestUrlRef.current !== url) {
          return;
        }

        const cachedDetails = requestDetailsCacheRef.current.get(url);
        if (cachedDetails) {
          setRequestDetails(cachedDetails);
          setDetailsError(null);
          setDetailsBusy(false);
        }

        const cachedDiff = requestDiffCacheRef.current.get(requestDiffCacheKey(url));
        if (cachedDiff) {
          applyDiffResult(cachedDiff);
          setLoadError(null);
        }
      });
    },
    [applyDiffResult, canUseForgeApi, fetchRequestDetails, fetchRequestDiff],
  );

  useEffect(() => {
    if (!canUseForgeApi || requestItems.length === 0) {
      return;
    }
    const generation = requestPreloadGenerationRef.current;
    for (const request of requestItems.slice(0, REQUEST_PREFETCH_LIMIT)) {
      preloadRequestData(request, generation);
    }
  }, [canUseForgeApi, preloadRequestData, requestItems]);

  const loadCurrentFilesDiffIfNeeded = () => {
    if (!hasDiff && activeUrl.trim() && !loadBusy) {
      void loadDiff({ commitSha: selectedCommitSha ?? null });
    }
  };

  const showFiles = () => {
    setActiveDetailTab("files");
    loadCurrentFilesDiffIfNeeded();
  };

  const startReviewMode = () => {
    setReviewDraftMode(true);
    setActiveDetailTab("files");
    setPostMessage(null);
    setPostError(null);
    loadCurrentFilesDiffIfNeeded();
  };

  const selectCommitDiff = (commitSha: string) => {
    const sha = commitSha.trim();
    if (!sha || loadBusy) {
      return;
    }
    void loadDiff({ commitSha: sha });
  };

  const runPrMrReview = async () => {
    if (!hasDiff) {
      setReviewPanel((current) => ({
        ...current,
        error: "Load files changed before running AI review.",
      }));
      return;
    }
    setAiReviewMenuOpen(false);
    setReviewPanel((current) => ({
      ...current,
      busy: true,
      error: null,
    }));
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.analyzeProjectPrMrDiff(projectId, {
        prUrl: activeUrl.trim(),
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
        error: formatAppErrorMessage(error, "Could not analyze the diff."),
      }));
    }
  };

  const postReview = async (event: "comment" | "approve") => {
    if (event === "comment" && !reviewPanel.result) {
      setPostError("Run the AI review before posting a review comment.");
      return;
    }
    setPostBusy(true);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.postProjectPrMrReview(projectId, {
        prUrl: activeUrl.trim(),
        body: reviewPanel.result ? formatReviewBody(reviewPanel.result) : "",
        event,
      });
      setPostMessage(result.message);
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not update the PR/MR."));
    } finally {
      setPostBusy(false);
    }
  };

  const saveDraftDiffComment = (draftBody: string) => {
    const body = draftBody.trim();
    if (!activeCommentTarget || !body) {
      return;
    }
    if (editingDraftCommentId) {
      setDraftComments((current) =>
        current.map((comment) =>
          comment.id === editingDraftCommentId
            ? {
                ...comment,
                oldPath: activeCommentTarget.oldPath,
                newPath: activeCommentTarget.newPath,
                side: activeCommentTarget.side,
                oldLineNumber: activeCommentTarget.oldLineNumber,
                newLineNumber: activeCommentTarget.newLineNumber,
                changeType: activeCommentTarget.changeType,
                body,
                displayPath: activeCommentTarget.displayPath,
                lineLabel: activeCommentTarget.lineLabel,
              }
            : comment,
        ),
      );
    } else {
      setDraftComments((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          oldPath: activeCommentTarget.oldPath,
          newPath: activeCommentTarget.newPath,
          side: activeCommentTarget.side,
          oldLineNumber: activeCommentTarget.oldLineNumber,
          newLineNumber: activeCommentTarget.newLineNumber,
          changeType: activeCommentTarget.changeType,
          body,
          displayPath: activeCommentTarget.displayPath,
          lineLabel: activeCommentTarget.lineLabel,
        },
      ]);
    }
    setReviewDraftMode(true);
    clearDraftEditor();
    setPostMessage(null);
    setPostError(null);
  };

  const editDraftDiffComment = (commentId: string) => {
    const comment = draftComments.find((entry) => entry.id === commentId);
    if (!comment) {
      return;
    }
    setActiveCommentTarget(toDiffLineCommentTarget(comment));
    setDraftCommentText(comment.body);
    setEditingDraftCommentId(comment.id);
    setPostMessage(null);
    setPostError(null);
  };

  const removeDraftDiffComment = (commentId: string) => {
    setDraftComments((current) => current.filter((entry) => entry.id !== commentId));
    if (editingDraftCommentId === commentId) {
      clearDraftEditor();
    }
    setPostMessage(null);
    setPostError(null);
  };

  const draftAiFindingComment = (target: DiffLineCommentTarget, finding: RunDiffReviewFinding, findingKey: string) => {
    const existingComment = draftComments.find((comment) => comment.aiFindingKey === findingKey);
    if (existingComment) {
      editDraftDiffComment(existingComment.id);
      return;
    }
    const id = crypto.randomUUID();
    const body = formatFindingDraftCommentBody(finding);
    setDraftComments((current) => [
      ...current,
      {
        id,
        oldPath: target.oldPath,
        newPath: target.newPath,
        side: target.side,
        oldLineNumber: target.oldLineNumber,
        newLineNumber: target.newLineNumber,
        changeType: target.changeType,
        body,
        displayPath: target.displayPath,
        lineLabel: target.lineLabel,
        aiFindingKey: findingKey,
      },
    ]);
    setActiveCommentTarget(target);
    setDraftCommentText(body);
    setEditingDraftCommentId(id);
    setReviewDraftMode(true);
    setPostMessage(null);
    setPostError(null);
  };

  const submitDraftDiffComments = async () => {
    const url = activeUrl.trim();
    if (!url || draftComments.length === 0) {
      return;
    }
    setManualSubmitBusy(true);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.submitProjectPrMrComments(projectId, {
        prUrl: url,
        body: `BuildWarden submitted ${String(draftComments.length)} draft diff comment${draftComments.length === 1 ? "" : "s"}.`,
        mode: "review",
        comments: draftComments.map(toSubmittedDiffComment),
      });
      setDraftComments([]);
      setReviewDraftMode(false);
      clearDraftEditor();
      setPostMessage(result.message);
      if (url) {
        requestDetailsCacheRef.current.delete(url);
        void loadRequestDetails(url);
      }
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not submit the draft diff comments."));
    } finally {
      setManualSubmitBusy(false);
    }
  };

  const submitSingleDiffComment = async (draftBody: string) => {
    const body = draftBody.trim();
    const url = activeUrl.trim();
    if (!activeCommentTarget || !body || !url) {
      return;
    }
    setSingleSubmitBusy(true);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.submitProjectPrMrComments(projectId, {
        prUrl: url,
        mode: "single",
        comments: [
          {
            oldPath: activeCommentTarget.oldPath,
            newPath: activeCommentTarget.newPath,
            side: activeCommentTarget.side,
            oldLineNumber: activeCommentTarget.oldLineNumber,
            newLineNumber: activeCommentTarget.newLineNumber,
            changeType: activeCommentTarget.changeType,
            body,
          },
        ],
      });
      clearDraftEditor();
      setPostMessage(result.message);
      requestDetailsCacheRef.current.delete(url);
      void loadRequestDetails(url);
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not submit the diff comment."));
    } finally {
      setSingleSubmitBusy(false);
    }
  };

  const refreshActiveRequestDetails = useCallback(() => {
    const url = activeUrl.trim();
    if (!url) {
      return;
    }
    requestDetailsCacheRef.current.delete(url);
    void loadRequestDetails(url);
  }, [activeUrl, loadRequestDetails]);

  const submitThreadReply = async (thread: ProjectForgeReviewThread) => {
    const body = replyThreadText.trim();
    const url = activeUrl.trim();
    if (!body || !url) {
      return;
    }
    setThreadActionBusyId(`reply:${thread.id}`);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.replyProjectPrMrReviewThread(projectId, {
        prUrl: url,
        threadId: thread.providerThreadId,
        replyToCommentId: thread.replyToCommentId,
        body,
      });
      setReplyThreadId(null);
      setReplyThreadText("");
      setPostMessage(result.message);
      refreshActiveRequestDetails();
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not reply to the review thread."));
    } finally {
      setThreadActionBusyId(null);
    }
  };

  const toggleThreadResolved = async (thread: ProjectForgeReviewThread) => {
    const url = activeUrl.trim();
    if (!url) {
      return;
    }
    const nextResolved = thread.resolved !== true;
    setThreadActionBusyId(`resolve:${thread.id}`);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.resolveProjectPrMrReviewThread(projectId, {
        prUrl: url,
        threadId: thread.providerThreadId,
        resolved: nextResolved,
      });
      setPostMessage(result.message);
      refreshActiveRequestDetails();
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not update the review thread."));
    } finally {
      setConfirmResolveThreadId(null);
      setThreadActionBusyId(null);
    }
  };

  const prLoadHelp =
    "Paste a GitHub PR or GitLab MR link, or fetch requests from the hosting API. Files changed loads the diff without running AI review.";

  const conversationItemTone = (item: ProjectForgeActivityItem): AgentWorklogTone => {
    if (item.kind === "diff-comment") {
      return "diff";
    }
    if (item.kind === "review") {
      return "request";
    }
    if (item.commitSha) {
      return "tools";
    }
    if (item.kind === "comment") {
      return "answer";
    }
    return "status";
  };

  const conversationItemLabel = (item: ProjectForgeActivityItem) => {
    if (item.kind === "diff-comment") {
      return "Comment";
    }
    if (item.commitSha) {
      return "Commit";
    }
    if (item.kind === "review") {
      return "Review";
    }
    if (item.kind === "comment") {
      return "Note";
    }
    return "Event";
  };

  const renderThreadCodeLines = (lines: ReviewThreadCodeLine[]) => {
    if (lines.length === 0) {
      return (
        <p className="px-1 py-1 text-[10px] text-zinc-600">
          Code context is not available for this thread yet.
        </p>
      );
    }
    return (
      <div className="overflow-hidden rounded-md bg-zinc-950/65 font-mono text-[10px] ring-1 ring-inset ring-zinc-800/70">
        {lines.map((line) => (
          <div
            key={line.key}
            className={cn(
              "grid grid-cols-[3.25rem_3.25rem_1rem_minmax(0,1fr)] items-start border-b border-zinc-900/70 last:border-b-0",
              line.type === "add" && "bg-emerald-500/[0.07]",
              line.type === "delete" && "bg-rose-500/[0.07]",
              line.type === "hunk" && "bg-cyan-500/[0.07] text-cyan-200",
              line.highlighted && "ring-1 ring-inset ring-cyan-300/50",
            )}
          >
            <span className="select-none px-1.5 py-0.5 text-right text-zinc-600">{line.oldLineNumber ?? ""}</span>
            <span className="select-none border-l border-zinc-900/80 px-1.5 py-0.5 text-right text-zinc-600">{line.newLineNumber ?? ""}</span>
            <span
              className={cn(
                "select-none border-l border-zinc-900/80 px-1 py-0.5 text-center",
                line.type === "add" && "text-emerald-300",
                line.type === "delete" && "text-rose-300",
                line.type === "context" && "text-zinc-600",
                line.type === "hunk" && "text-cyan-300",
              )}
            >
              {line.type === "add" ? "+" : line.type === "delete" ? "-" : line.type === "hunk" ? "@" : ""}
            </span>
            <code className="min-w-0 whitespace-pre-wrap break-words border-l border-zinc-900/80 px-2 py-0.5 text-zinc-300">{line.content}</code>
          </div>
        ))}
      </div>
    );
  };

  const renderReviewThreadTimelineItem = (item: ProjectForgeActivityItem, thread: ProjectForgeReviewThread) => {
    const codeLines = buildReviewThreadCodeLines(thread, diffText);
    const isReplying = replyThreadId === thread.id;
    const busyReply = threadActionBusyId === `reply:${thread.id}`;
    const busyResolve = threadActionBusyId === `resolve:${thread.id}`;
    const confirmResolve = confirmResolveThreadId === thread.id;
    return (
      <AgentLogRow key={item.id} tone="diff" label="Comment" time={formatActivityDate(item.createdAt)}>
        <div className={cn("min-w-0 pr-2 py-0.5", thread.resolved && "opacity-80")}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-zinc-200">
                  {thread.comments[0]?.author?.username ?? item.author?.username ?? (item.provider === "gitlab" ? "GitLab" : "GitHub")}
                </span>
                <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", activityKindTone(item.kind))}>
                  Diff comment
                </span>
                {thread.resolved ? (
                  <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-1.5 py-px text-[8px] font-semibold uppercase text-zinc-400">
                    Closed
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
                {thread.path}:{String(thread.newLineNumber ?? thread.oldLineNumber ?? "")}
                {thread.commitSha ? ` ${thread.commitSha.slice(0, 8)}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[9px] text-zinc-600">{formatActivityDate(item.createdAt)}</span>
              {canUseForgeApi ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-6 px-2 text-[10px]",
                    thread.resolved
                      ? "text-zinc-400 hover:text-cyan-100"
                      : confirmResolve
                        ? "border border-amber-500/40 bg-amber-500/[0.08] text-amber-100 hover:bg-amber-500/[0.12] hover:text-amber-50"
                        : "text-zinc-500 hover:text-zinc-200",
                  )}
                  onClick={() => {
                    if (thread.resolved !== true && !confirmResolve) {
                      setConfirmResolveThreadId(thread.id);
                      setPostMessage(null);
                      setPostError(null);
                      return;
                    }
                    void toggleThreadResolved(thread);
                  }}
                  disabled={busyResolve}
                  title={thread.resolved ? "Reopen this thread" : confirmResolve ? "Confirm closing this thread" : "Close this thread as resolved"}
                >
                  {busyResolve ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
                  {thread.resolved ? "Reopen thread" : confirmResolve ? "Confirm close" : "Close thread"}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="mt-2">{renderThreadCodeLines(codeLines)}</div>
          <div className="mt-2 divide-y divide-zinc-800/70">
            {thread.comments.map((comment) => (
              <div key={comment.id} className="py-2 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-semibold text-zinc-200">{comment.author?.username ?? "Reviewer"}</span>
                  <span className="shrink-0 text-[9px] text-zinc-600">{formatActivityDate(comment.createdAt)}</span>
                </div>
                <ActivityRichText content={comment.body} compact className="mt-1 break-words text-zinc-300" />
              </div>
            ))}
          </div>
        {isReplying ? (
          <div className="mt-2 rounded-md border border-cyan-500/25 bg-cyan-500/[0.055] p-2">
            <textarea
              value={replyThreadText}
              onChange={(event) => setReplyThreadText(event.target.value)}
              className="h-16 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950/80 px-2 py-1.5 text-[11px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/70"
              placeholder="Reply to this thread..."
              autoFocus
            />
            <div className="mt-1.5 flex justify-end gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[10px] text-zinc-400"
                onClick={() => {
                  setReplyThreadId(null);
                  setReplyThreadText("");
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-[10px]"
                onClick={() => void submitThreadReply(thread)}
                disabled={!replyThreadText.trim() || busyReply}
              >
                {busyReply ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : null}
                Reply
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-6 px-2 text-[10px]"
              onClick={() => {
                setReplyThreadId(thread.id);
                setReplyThreadText("");
                setConfirmResolveThreadId(null);
                setPostMessage(null);
                setPostError(null);
              }}
              disabled={!canUseForgeApi || thread.resolved === true}
              title={canUseForgeApi ? "Reply to this thread" : "Replies require a Git hosting token"}
            >
              Reply
            </Button>
            {confirmResolve ? <span className="text-[9px] text-amber-200/80">Click Confirm close to resolve this thread.</span> : null}
          </div>
        )}
        </div>
      </AgentLogRow>
    );
  };

  const renderConversationActivityItem = (item: ProjectForgeActivityItem) => {
    const itemCommit = item.commitSha ? (visibleRequestDetails?.commits.find((commit) => commit.sha === item.commitSha) ?? null) : null;
    return (
      <AgentLogRow key={item.id} tone={conversationItemTone(item)} label={conversationItemLabel(item)} time={formatActivityDate(item.createdAt)}>
        <div className="min-w-0 pr-2 py-0.5">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold text-zinc-200">
                  {item.author?.username ?? (item.provider === "gitlab" ? "GitLab" : "GitHub")}
                </span>
                <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", activityKindTone(item.kind))}>
                  {item.kind}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
                {item.title}
                {item.path ? (
                  <span className="font-mono text-zinc-500">
                    {" "}
                    in {item.path}
                    {item.line ? `:${String(item.line)}` : ""}
                  </span>
                ) : null}
                {itemCommit ? (
                  <span className="font-mono text-zinc-500">
                    {" "}
                    {itemCommit.shortSha} {commitTitleForActivity(itemCommit, itemCommit.sha)}
                  </span>
                ) : item.commitSha ? (
                  <span className="font-mono text-zinc-500"> {item.commitSha.slice(0, 12)}</span>
                ) : null}
              </p>
            </div>
            <span className="shrink-0 text-[9px] text-zinc-600">{formatActivityDate(item.createdAt)}</span>
          </div>
          {item.body ? <ActivityRichText content={item.body} compact className="mt-1.5 break-words text-zinc-300" /> : null}
        </div>
      </AgentLogRow>
    );
  };

  const renderOverviewCard = () => {
    if (!overviewRequest && !detailsBusy && !detailsError) {
      return null;
    }

    const details = visibleRequestDetails?.request ?? null;
    const description = details?.description?.trim() || "";
    const labels = details?.labels ?? [];
    const authorName = details?.authorUser?.username ?? overviewRequest?.author ?? "Unknown author";
    const avatarFallback = authorName.slice(0, 2).toUpperCase();

    return (
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/35 p-0">
        <AgentWorklog className="agent-worklog-density--comfortable app-scrollbar min-h-0 flex-1 overflow-y-auto">
          <AgentLogRow tone="prompt" label="Opened" time={formatActivityDate(details?.createdAt ?? overviewRequest?.updatedAt ?? null)}>
            <div className="min-w-0 pr-2 py-0.5">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {details?.authorUser?.avatarUrl ? (
                      <img src={details.authorUser.avatarUrl} alt="" className="h-5 w-5 shrink-0 rounded-full bg-zinc-900" />
                    ) : (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[9px] font-semibold text-zinc-400">
                        {avatarFallback}
                      </span>
                    )}
                    <span className="text-[11px] font-semibold text-zinc-100">{authorName}</span>
                    <span className="text-[10px] text-zinc-500">opened this {activeKind}</span>
                    {details?.createdAt ? <span className="text-[10px] text-zinc-600">{formatActivityDate(details.createdAt)}</span> : null}
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-zinc-500">
                    <span>{details?.changedFiles != null ? `${String(details.changedFiles)} files` : `${String(loadedOrReportedFileCount)} files`}</span>
                    {details?.additions != null || details?.deletions != null ? (
                      <span>
                        <span className="text-emerald-300">+{String(details.additions ?? 0)}</span>{" "}
                        <span className="text-rose-300">-{String(details.deletions ?? 0)}</span>
                      </span>
                    ) : null}
                    <span>{String(conversationActivity.length)} events</span>
                    {detailsBusy ? (
                      <span className="inline-flex items-center gap-1 text-zinc-500">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        loading
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {labels.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {labels.map((label) => (
                    <span key={label} className="rounded-full border border-zinc-700/80 bg-zinc-900/55 px-1.5 py-px text-[9px] text-zinc-300">
                      {label}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 max-w-none break-words text-[12px] leading-relaxed text-zinc-300">
                {description ? <ActivityRichText content={description} compact /> : <p className="text-xs text-zinc-600">No description provided.</p>}
              </div>
              {detailsError ? <p className="mt-2 text-[10px] text-rose-300">{detailsError}</p> : null}
              {visibleRequestDetails?.warnings.length ? (
                <div className="mt-2 space-y-1">
                  {visibleRequestDetails.warnings.map((warning) => (
                    <p key={warning} className="text-[10px] text-amber-200/90">
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          </AgentLogRow>

          {conversationActivity.length > 0 ? (
            conversationActivity.map((item) => {
              const thread = item.kind === "diff-comment" ? findReviewThreadForActivity(item) : null;
              return thread ? renderReviewThreadTimelineItem(item, thread) : renderConversationActivityItem(item);
            })
          ) : (
            <AgentLogRow tone="status" label="Timeline" time={null}>
              <p className="py-1 text-xs text-zinc-600">{detailsBusy ? "Loading activity..." : "No timeline events were returned."}</p>
            </AgentLogRow>
          )}
        </AgentWorklog>
      </Card>
    );
  };

  const renderForgeTokenHintCard = () => (
    <Card className="flex min-h-0 flex-1 items-center justify-center overflow-hidden border-[var(--ec-accent-ring)] bg-[linear-gradient(135deg,var(--ec-accent-soft),var(--ec-success-soft))] p-4">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[var(--ec-panel-soft)] text-[var(--ec-accent)] ring-1 ring-[var(--ec-accent-ring)]">
          <KeyRound className="h-5 w-5" aria-hidden />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
          <h3 className="text-sm font-semibold text-[var(--ec-text)]">Add a Git Access Token to unlock full PR/MR review</h3>
          <span className="rounded-full bg-[var(--ec-success-soft)] px-1.5 py-px text-[8px] font-semibold uppercase text-[var(--ec-success)] ring-1 ring-[var(--ec-success-ring)]">
            More features
          </span>
        </div>
        <p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-[var(--ec-muted)]">
          Right now BuildWarden can only load a manually pasted PR/MR URL. Save a GitHub or GitLab token for this project to fetch requests from the repo,
          show commits and remote review threads, and post comments or approvals.
        </p>
        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {["Fetch request list", "Browse commits", "Show review threads", "Post reviews"].map((feature) => (
            <span
              key={feature}
              className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1 text-[10px] font-medium text-[var(--ec-muted)]"
            >
              {feature}
            </span>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-4 h-8 border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-3 text-xs text-[var(--ec-accent)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]"
          onClick={onOpenProjectSettings}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          Open Project Settings
        </Button>
      </div>
    </Card>
  );

  const renderFileNavigator = () => {
    const normalizedQuery = diffFileQuery.replace(/\\/g, "/").replace(/^a\//, "").replace(/^b\//, "").trim().toLowerCase();
    const visibleFiles = normalizedQuery
      ? fileNavItems.filter((file) => file.path.toLowerCase().includes(normalizedQuery) || (file.oldPath?.toLowerCase().includes(normalizedQuery) ?? false))
      : fileNavItems;

    if (fileNavItems.length === 0) {
      return null;
    }

    if (fileNavigatorCollapsed) {
      return (
        <aside className="flex min-h-0 flex-col items-center overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/65 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-zinc-400 hover:bg-zinc-900 hover:text-cyan-100"
            onClick={() => setFileNavigatorCollapsed(false)}
            title="Show file list"
            aria-label="Show file list"
          >
            <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <span className="mt-1 rounded-full bg-cyan-500/15 px-1.5 py-px font-mono text-[9px] text-cyan-100" title={`${String(fileNavItems.length)} changed files`}>
            {String(fileNavItems.length)}
          </span>
        </aside>
      );
    }

    return (
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/65">
        <div className="border-b border-zinc-800 p-1.5">
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" aria-hidden />
              <Input
                value={diffFileQuery}
                onChange={(event) => {
                  setDiffFileQuery(event.target.value);
                  setActiveDiffFilePath(null);
                  setHighlightedCommentId(null);
                }}
                placeholder="Filter files"
                className="h-7 pl-7 pr-2 text-[11px]"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 border border-zinc-800 bg-zinc-950/80 text-zinc-500 hover:bg-zinc-900 hover:text-cyan-100"
              onClick={() => setFileNavigatorCollapsed(true)}
              title="Hide file list"
              aria-label="Hide file list"
            >
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          <button
            type="button"
            className={cn(
              "mt-1.5 flex h-7 w-full items-center justify-between rounded px-2 text-left text-[11px] transition",
              !activeDiffFilePath && !diffFileQuery.trim() ? "bg-cyan-500/[0.12] text-cyan-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
            onClick={() => {
              setActiveDiffFilePath(null);
              setDiffFileQuery("");
              setHighlightedCommentId(null);
            }}
          >
            <span>All files</span>
            <span className="font-mono text-[9px] text-zinc-500">{String(fileNavItems.length)}</span>
          </button>
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-1.5">
          {visibleFiles.length > 0 ? (
            visibleFiles.map((file) => {
              const selected = activeDiffFilePath ? pathsMatch(file.path, activeDiffFilePath) : false;
              return (
                <button
                  key={file.key}
                  type="button"
                  className={cn(
                    "mb-1 flex w-full min-w-0 flex-col rounded border p-1.5 text-left transition last:mb-0",
                    selected
                      ? "border-cyan-500/45 bg-cyan-500/[0.09] shadow-[inset_2px_0_0_rgba(34,211,238,0.8)]"
                      : "border-zinc-800 bg-zinc-900/35 hover:border-zinc-700 hover:bg-zinc-900/60",
                  )}
                  onClick={() => {
                    setActiveDiffFilePath(file.path);
                    setDiffFileQuery("");
                    setHighlightedCommentId(null);
                  }}
                >
                  <span className="flex min-w-0 items-center justify-between gap-1.5">
                    <span className="truncate font-mono text-[10px] text-zinc-200">{file.path}</span>
                    <span className="shrink-0 rounded border border-zinc-700 px-1 py-px text-[8px] uppercase text-zinc-500">{file.status}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px]">
                    {file.additions != null ? <span className="font-mono text-emerald-300">+{String(file.additions)}</span> : null}
                    {file.deletions != null ? <span className="font-mono text-rose-300">-{String(file.deletions)}</span> : null}
                    {file.commentCount > 0 ? (
                      <span className="rounded-full bg-cyan-500/15 px-1.5 py-px text-cyan-100">{String(file.commentCount)} comment</span>
                    ) : null}
                    {file.draftCount > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-amber-100">{String(file.draftCount)} draft</span>
                    ) : null}
                    {!file.patchAvailable ? <span className="text-zinc-600">no patch</span> : null}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="rounded border border-dashed border-zinc-800 p-2 text-[11px] text-zinc-600">No files match the filter.</p>
          )}
        </div>
      </aside>
    );
  };

  const renderFilesChangedToolbar = () => {
    if (!diffText.trim()) {
      return null;
    }

    const reviewModeActive = reviewDraftMode || draftComments.length > 0;
    const nextDiffViewType = diffViewType === "unified" ? "split" : "unified";
    const DiffViewIcon = diffViewType === "unified" ? Rows2 : Columns2;
    const diffViewLabel = diffViewType === "unified" ? "Unified diff view" : "Split diff view";
    const nextDiffViewLabel = nextDiffViewType === "unified" ? "unified" : "split";

    return (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
        {selectedCommitSha ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-zinc-400" onClick={() => void loadDiff({ commitSha: null })}>
            All changes
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 border border-zinc-800 bg-zinc-950/80 p-0 text-[var(--ec-accent)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]"
          title={`${diffViewLabel}. Click to switch to ${nextDiffViewLabel} view.`}
          aria-label={`${diffViewLabel}. Switch to ${nextDiffViewLabel} view.`}
          onClick={() => setDiffViewType(nextDiffViewType)}
        >
          <DiffViewIcon className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <label
          className="flex h-7 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950/80 px-2 text-[10px] text-zinc-400"
          title="Hide line changes where only whitespace differs."
        >
          <input
            type="checkbox"
            checked={hideWhitespaceChanges}
            onChange={(event) => setHideWhitespaceChanges(event.target.checked)}
            className="h-3 w-3 accent-cyan-500"
          />
          Ignore whitespace
        </label>
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
        <div ref={aiReviewMenuAnchorRef} className="relative">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              "h-8 border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-2 text-[10px] font-semibold text-[var(--ec-accent)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]",
              aiReviewMenuOpen && "bg-[var(--ec-accent-soft)] text-[var(--ec-accent-strong)]",
            )}
            onClick={() => setAiReviewMenuOpen((open) => !open)}
            disabled={!hasDiff}
            title="Choose a model and start an AI review."
            aria-haspopup="dialog"
            aria-expanded={aiReviewMenuOpen}
          >
            {reviewBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />}
            AI review
            <ChevronDown className={cn("ml-0.5 h-3.5 w-3.5 transition", aiReviewMenuOpen && "rotate-180")} aria-hidden />
          </Button>
        </div>
        <AnchorDropdownPortal
          open={aiReviewMenuOpen}
          anchorRef={aiReviewMenuAnchorRef}
          align="end"
          placement="bottom"
          widthPx={292}
          onClose={() => setAiReviewMenuOpen(false)}
          className="glass-popover overflow-hidden rounded-md border border-[var(--ec-accent-ring)] bg-zinc-950/95 p-2 shadow-xl"
        >
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ec-accent)]">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              AI review
            </div>
            <div>
              <span className="mb-1 block text-[10px] font-medium text-zinc-500">Model</span>
              <div className="app-scrollbar max-h-44 space-y-1 overflow-y-auto pr-0.5" role="listbox" aria-label="AI review model">
                {reviewModelSelectOptions.length > 0 ? (
                  reviewModelSelectOptions.map((option) => {
                    const selected = option.value === reviewModelId;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition",
                          selected
                            ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                            : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:border-[var(--ec-accent-ring)] hover:bg-[var(--ec-accent-soft)]",
                        )}
                        onClick={() => setReviewModelId(option.value)}
                        disabled={reviewBusy}
                      >
                        <Sparkles className={cn("h-3.5 w-3.5 shrink-0", selected ? "text-[var(--ec-accent)]" : "text-zinc-500")} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-semibold">{option.label}</span>
                          {option.description ? <span className="block truncate text-[9px] text-zinc-500">{option.description}</span> : null}
                        </span>
                        {selected ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden /> : null}
                      </button>
                    );
                  })
                ) : (
                  <p className="rounded-md border border-dashed border-zinc-800 px-2 py-2 text-[11px] text-zinc-500">No review models configured.</p>
                )}
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              className="h-8 w-full px-2 text-[11px]"
              onClick={() => void runPrMrReview()}
              disabled={reviewBusy || !hasDiff || !reviewModelId.trim()}
            >
              {reviewBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Start AI review
            </Button>
          </div>
        </AnchorDropdownPortal>
        {canUseForgeApi ? (
          reviewModeActive ? (
            <div
              className="flex h-8 items-center overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/[0.07] shadow-[inset_2px_0_0_rgba(245,158,11,0.62)]"
              title="Manual review: collect line comments as drafts, then submit them together."
            >
              <span
                className="flex h-full shrink-0 items-center gap-1 border-r border-amber-500/20 px-2 text-[10px] font-semibold text-amber-100"
                title="Review comments are kept as drafts until the review is submitted."
              >
                <ClipboardList className="h-3.5 w-3.5" aria-hidden />
                Drafts
                <span className="rounded-full bg-amber-300/15 px-1.5 py-px font-mono text-[9px] text-amber-50">{String(draftComments.length)}</span>
              </span>
              {reviewDraftMode && draftComments.length === 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 rounded-none border-r border-amber-500/20 px-2 text-[10px] text-amber-200/80 hover:bg-amber-500/[0.12] hover:text-amber-50"
                  onClick={() => {
                    setReviewDraftMode(false);
                    clearDraftEditor();
                  }}
                >
                  Stop
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 rounded-none px-2 text-[10px] font-semibold text-amber-100 hover:bg-amber-500/[0.14] hover:text-amber-50"
                onClick={() => void submitDraftDiffComments()}
                disabled={manualSubmitBusy || draftComments.length === 0 || !activeUrl.trim()}
              >
                {manualSubmitBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <SquarePen className="mr-1 h-3.5 w-3.5" aria-hidden />}
                Submit
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 border border-amber-500/30 bg-amber-500/[0.08] px-2 text-[10px] font-semibold text-amber-100 hover:bg-amber-500/[0.14] hover:text-amber-50"
              onClick={startReviewMode}
              disabled={!activeUrl.trim()}
              title="Start a manual review and batch line comments as drafts."
            >
              <SquarePen className="mr-1 h-3.5 w-3.5" aria-hidden />
              Draft review
            </Button>
          )
        ) : null}
        {!overviewRequest && canUseForgeApi ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2 text-[10px]"
              onClick={() => void postReview("comment")}
              disabled={postBusy || !reviewPanel.result || !activeUrl.trim()}
            >
              {postBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <MessageSquarePlus className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Comment
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2 text-[10px] text-emerald-200"
              onClick={() => void postReview("approve")}
              disabled={postBusy || !activeUrl.trim()}
            >
              {postBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Approve
            </Button>
          </>
        ) : null}
      </div>
    );
  };

  const renderDiffCard = () => {
    if (!diffText.trim()) {
      return null;
    }
    const fileNavigator = renderFileNavigator();
    const reviewModeActive = reviewDraftMode || draftComments.length > 0;

    return (
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
        {!overviewRequest ? <div className="shrink-0 border-b border-zinc-800/80 px-2 py-1.5">{renderFilesChangedToolbar()}</div> : null}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden px-2 pb-2 pt-1.5">
          {!overviewRequest && postMessage ? <p className="shrink-0 text-[9px] text-emerald-300">{postMessage}</p> : null}
          {!overviewRequest && postError ? <p className="shrink-0 text-[9px] text-rose-300">{postError}</p> : null}
          {hasReviewState ? (
            <div className="app-scrollbar max-h-[34%] min-h-0 w-full min-w-0 overflow-y-auto overscroll-y-contain">
              <DiffReviewPanel
                state={reviewPanel}
                onRun={() => void runPrMrReview()}
                disabled={reviewBusy || !hasDiff}
                compact
                defaultExpanded={Boolean(reviewPanel.error) || Boolean(reviewPanel.result)}
              />
            </div>
          ) : null}
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-2 overflow-hidden",
              fileNavigator
                ? fileNavigatorCollapsed
                  ? "grid-cols-[2.25rem_minmax(0,1fr)]"
                  : "lg:grid-cols-[minmax(12rem,17rem)_minmax(0,1fr)]"
                : "lg:grid-cols-1",
            )}
          >
            {fileNavigator}
            <GitDiffPreview
              ref={gitDiffPanelRef}
              diffText={diffText}
              fillContainer
              className="min-h-0 flex-1"
              emptyMessage="No changes in this range."
              activityEmphasis
              viewType={diffViewType}
              wordDiff
              hideWhitespaceChanges={hideWhitespaceChanges}
              filePathQuery={activeDiffFilePath ? "" : diffFileQuery}
              activeFilePath={activeDiffFilePath}
              highlightedCommentId={highlightedCommentId}
              reviewFindings={reviewPanel.result?.findings ?? null}
              manualCommentTargets={diffCommentTargets}
              activeCommentTarget={activeCommentTarget}
              draftCommentText={draftCommentText}
              draftCommentSaveLabel={editingDraftCommentId ? "Save draft" : "Add to review"}
              singleCommentSaveLabel="Add single comment"
              singleCommentBusy={singleSubmitBusy}
              editingDraftCommentId={editingDraftCommentId}
              draftedReviewFindingKeys={draftedReviewFindingKeys}
              onAddDiffComment={
                canUseForgeApi
                  ? (target) => {
                      setActiveCommentTarget(target);
                      setDraftCommentText("");
                      setEditingDraftCommentId(null);
                      setHighlightedCommentId(null);
                      setPostMessage(null);
                      setPostError(null);
                    }
                  : undefined
              }
              onSaveDraftComment={saveDraftDiffComment}
              onSaveSingleComment={canUseForgeApi && !editingDraftCommentId && !reviewModeActive ? (value) => void submitSingleDiffComment(value) : undefined}
              onCancelDraftComment={clearDraftEditor}
              onEditDraftComment={canUseForgeApi ? editDraftDiffComment : undefined}
              onRemoveDraftComment={canUseForgeApi ? removeDraftDiffComment : undefined}
              onDraftReviewFinding={canUseForgeApi ? draftAiFindingComment : undefined}
              onParsedFilesChange={handleParsedDiffFilesChange}
              defaultCollapsedFileSections={false}
              virtualizeFileSections
              onAllFilesExpandedChange={setAllDiffFilesExpanded}
            />
          </div>
        </div>
      </Card>
    );
  };

  const renderCommitsCard = () => {
    const commits = visibleRequestDetails?.commits ?? [];

    if (!canUseForgeApi) {
      return (
        <Card className="flex min-h-0 flex-1 items-center justify-center border-zinc-800/80 bg-zinc-950/30 p-4">
          <div className="max-w-md text-center">
            <p className="text-sm font-semibold text-zinc-100">Commits need a hosting token</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Add a GitHub or GitLab token in Project Settings to browse commit lists, commit diffs, and remote review threads.
            </p>
          </div>
        </Card>
      );
    }

    if (detailsBusy && commits.length === 0) {
      return (
        <Card className="flex min-h-0 flex-1 items-center justify-center border-zinc-800/80 bg-zinc-950/30 p-4">
          <span className="inline-flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Loading commits
          </span>
        </Card>
      );
    }

    return (
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-zinc-100">Commits</p>
            <p className="mt-0.5 text-[10px] text-zinc-500">Select one commit to inspect only that diff.</p>
          </div>
          <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-[10px]" onClick={() => void loadDiff({ commitSha: null })}>
            All changes
          </Button>
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {commits.length > 0 ? (
            <div className="space-y-1.5">
              {commits.map((commit) => {
                const selected = selectedCommitSha === commit.sha;
                return (
                  <div
                    key={commit.sha}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-md border p-2 text-left transition",
                      selected
                        ? "border-cyan-500/50 bg-cyan-500/[0.09] shadow-[inset_2px_0_0_rgba(34,211,238,0.85)]"
                        : "border-zinc-800 bg-zinc-900/35 hover:border-zinc-700 hover:bg-zinc-900/65",
                    )}
                  >
                    <button type="button" className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => selectCommitDiff(commit.sha)}>
                      <span className="mt-0.5 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-cyan-100">
                        {commit.shortSha}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-zinc-100">{commit.title || commit.shortSha}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                          <span>{commit.authorUser?.username ?? commit.authorName ?? "Unknown author"}</span>
                          <span>{formatActivityDate(commit.committedAt ?? commit.authoredAt)}</span>
                          {commit.commentCount ? <span>{String(commit.commentCount)} comments</span> : null}
                        </span>
                      </span>
                    </button>
                    {commit.url ? (
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
                        title="Open commit"
                        onClick={(event) => {
                          event.stopPropagation();
                          void window.buildwarden.openExternalUrl(commit.url ?? "");
                        }}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-zinc-800 p-3 text-xs text-zinc-600">
              {detailsError ? "Commit data could not be loaded for this request." : "No commits were returned for this request."}
            </p>
          )}
        </div>
      </Card>
    );
  };

  const renderRequestHeader = () => {
    if (!overviewRequest) {
      return null;
    }

    return (
      <Card className="shrink-0 overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
        <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", requestStateTone(overviewRequest.state))}>
                {overviewRequest.state}
              </span>
              <span className="font-mono text-[10px] text-zinc-500">
                {providerLabel(overviewRequest.provider)} #{String(overviewRequest.number)}
              </span>
              {overviewRequest.draft ? <span className="text-[10px] text-amber-200">draft</span> : null}
            </div>
            <p className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-zinc-100">{overviewRequest.title}</p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
              {overviewRequest.sourceBranch || "head"} -&gt; {overviewRequest.targetBranch || "base"}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2 text-[10px]"
              onClick={() => void window.buildwarden.openExternalUrl(overviewRequest.url)}
              title="Open in browser"
            >
              <ExternalLink className="mr-1 h-3.5 w-3.5" aria-hidden />
              Open
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 px-2 text-[10px] text-emerald-200"
              onClick={() => void postReview("approve")}
              disabled={postBusy || !activeUrl.trim()}
            >
              {postBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Approve
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-zinc-800/80 px-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <button
              type="button"
              className={cn(
                "flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition",
                activeDetailTab === "conversation" ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
              )}
              onClick={() => setActiveDetailTab("conversation")}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              Conversation
              <span className="rounded-full bg-zinc-800 px-1.5 py-px font-mono text-[10px] text-zinc-400">{String(totalActivityCount)}</span>
            </button>
            <button
              type="button"
              className={cn(
                "flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition",
                activeDetailTab === "commits" ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
                !canUseForgeApi && "cursor-not-allowed opacity-60 hover:text-zinc-500",
              )}
              onClick={() => {
                if (canUseForgeApi) {
                  setActiveDetailTab("commits");
                }
              }}
              disabled={!canUseForgeApi}
              title={canUseForgeApi ? "View commits" : "Commits require a Git hosting token"}
            >
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden />
              Commits
              {commitCount > 0 ? (
                <span className="rounded-full bg-zinc-800 px-1.5 py-px font-mono text-[10px] text-zinc-400">{String(commitCount)}</span>
              ) : null}
            </button>
            <button
              type="button"
              className={cn(
                "flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition",
                activeDetailTab === "files" ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
              )}
              onClick={showFiles}
            >
              {loadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
              Files changed
              {loadedOrReportedFileCount > 0 ? (
                <span className="rounded-full bg-zinc-800 px-1.5 py-px font-mono text-[10px] text-zinc-400">
                  {String(loadedOrReportedFileCount)}
                </span>
              ) : null}
            </button>
          </div>
          {activeDetailTab === "files" && diffText.trim() ? <div className="ml-auto flex min-w-0 items-center">{renderFilesChangedToolbar()}</div> : null}
        </div>
        {postMessage ? <p className="border-t border-zinc-800/80 px-3 py-1 text-[9px] text-emerald-300">{postMessage}</p> : null}
        {postError ? <p className="border-t border-zinc-800/80 px-3 py-1 text-[9px] text-rose-300">{postError}</p> : null}
      </Card>
    );
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-2", diffText.trim() || requestItems.length > 0 ? "overflow-hidden" : "")}>
      <Card className="shrink-0 border-zinc-800/80 bg-zinc-950/40 p-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <GitPullRequest className="h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
            <h2 className="text-xs font-semibold text-zinc-100">Pull / merge requests</h2>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-zinc-500 transition hover:bg-zinc-800/80 hover:text-zinc-300"
              title={prLoadHelp}
              aria-label="How PR and MR loading works"
            >
              <Info className="h-3.5 w-3.5" aria-hidden />
            </button>
            {requestProvider ? (
              <span className="text-[9px] text-zinc-500">
                {requestProvider === "gitlab" ? "GitLab" : "GitHub"} - <span className="font-mono text-zinc-400">{requestRepoLabel}</span>
              </span>
            ) : null}
            {meta ? (
              <span className="text-[9px] text-zinc-500">
                {activeKind} #{meta.number} - <span className="font-mono text-zinc-400">{meta.baseRef}</span>
                {diffChangedFileCount > 0 ? (
                  <span className="text-zinc-600">
                    {" "}
                    - {String(diffChangedFileCount)} file{diffChangedFileCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-end justify-end gap-1.5">
            {canUseForgeApi ? (
              <>
                <label className="flex items-end gap-1.5">
                  <span className="pb-1 text-[9px] font-medium uppercase tracking-wide text-zinc-500">State</span>
                  <Select
                    value={requestState}
                    onValueChange={(value) => setRequestState(value as ProjectForgeRequestState)}
                    options={requestStateOptions.map((option) => ({ value: option.id, label: option.label }))}
                    disabled={listBusy}
                    className="w-28"
                    triggerClassName="h-7 rounded-md px-2 text-[11px]"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-[11px]"
                  onClick={() => void loadRequests()}
                  disabled={listBusy}
                >
                  {listBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />}
                  Fetch
                </Button>
              </>
            ) : null}
            {meta && !reviewModelId.trim() ? (
              <span className="pb-1 text-[9px] text-amber-200/85">Select a model, then reload for inline comments</span>
            ) : null}
          </div>
        </div>

        {!canUseForgeApi ? (
          <div className="mt-1.5 grid gap-1.5 xl:grid-cols-[minmax(18rem,1fr)_8rem_auto] xl:items-end">
            <label className="min-w-0 space-y-0.5">
              <span className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">PR / MR URL</span>
              <Input
                value={prUrl}
                onChange={(event) => {
                  setSelectedRequest(null);
                  setRequestDetails(null);
                  setDetailsError(null);
                  setPrUrl(event.target.value);
                  setActiveDetailTab("conversation");
                }}
                placeholder="https://github.com/org/repo/pull/123 or GitLab .../-/merge_requests/456"
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
              onClick={() => void loadManualRequest()}
              disabled={loadBusy || !prUrl.trim()}
            >
              {loadBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Load URL
            </Button>
          </div>
        ) : null}

        {forgeAuthStatusBusy ? <p className="mt-1 text-[9px] text-zinc-500">Checking Git hosting token status...</p> : null}
        {forgeAuthStatusError ? <p className="mt-1 text-[9px] text-amber-200">{forgeAuthStatusError}</p> : null}
        {canUseForgeApi && listError ? <p className="mt-1 text-[9px] text-rose-300">{listError}</p> : null}
        {loadError ? <p className="mt-1 text-[9px] text-rose-300">{loadError}</p> : null}
      </Card>

      <div
        ref={requestListLayoutRef}
        className={cn(
          "min-h-0 flex-1",
          requestItems.length > 0
            ? cn(
                "grid overflow-hidden gap-2",
                requestListCollapsed ? "grid-cols-[2.25rem_minmax(0,1fr)]" : "lg:grid-cols-[var(--pr-mr-request-list-width)_minmax(0,1fr)]",
              )
            : "flex flex-col",
        )}
        style={requestItems.length > 0 ? requestListLayoutStyle : undefined}
      >
        {requestItems.length > 0 ? (
          requestListCollapsed ? (
            <Card className="flex min-h-0 flex-col items-center overflow-hidden border-zinc-800/80 bg-zinc-950/40 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-zinc-400 hover:bg-zinc-900 hover:text-cyan-100"
                onClick={() => setRequestListCollapsed(false)}
                title="Show request list"
                aria-label="Show request list"
              >
                <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <span className="mt-1 rounded-full bg-cyan-500/15 px-1.5 py-px font-mono text-[9px] text-cyan-100" title={`${String(requestItems.length)} requests`}>
                {String(requestItems.length)}
              </span>
            </Card>
          ) : (
            <Card className="relative flex min-h-0 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-2 py-1.5">
                <p className="text-[11px] font-semibold text-zinc-100">Requests</p>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="font-mono text-[9px] text-zinc-500">{String(requestItems.length)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-zinc-500 hover:bg-zinc-900 hover:text-cyan-100"
                    onClick={() => setRequestListCollapsed(true)}
                    title="Hide request list"
                    aria-label="Hide request list"
                  >
                    <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="app-scrollbar max-h-72 min-h-0 flex-1 overflow-y-auto p-1.5 lg:max-h-none">
                {requestItems.map((request) => {
                  const selected = selectedRequest?.url === request.url;
                  return (
                    <button
                      key={`${request.provider}-${String(request.number)}`}
                      type="button"
                      className={cn(
                        "mb-1.5 flex w-full min-w-0 flex-col rounded-md border p-2 text-left transition last:mb-0",
                        selected
                          ? "border-cyan-500/50 bg-cyan-500/[0.09] shadow-[inset_2px_0_0_rgba(34,211,238,0.85)]"
                          : "border-zinc-800/80 bg-zinc-900/45 hover:border-zinc-700 hover:bg-zinc-900/70",
                      )}
                      onClick={() => selectRequest(request)}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", requestStateTone(request.state))}>
                          {request.state}
                        </span>
                        <span className="font-mono text-[9px] text-zinc-500">#{String(request.number)}</span>
                        {request.draft ? <span className="text-[9px] text-amber-200">draft</span> : null}
                      </span>
                      <span className="mt-1 line-clamp-2 text-[11px] font-medium leading-snug text-zinc-100">{request.title}</span>
                      <span className="mt-1 truncate font-mono text-[9px] text-zinc-500">
                        {request.sourceBranch || "head"} -&gt; {request.targetBranch || "base"}
                      </span>
                      <span className="mt-0.5 truncate text-[9px] text-zinc-600">
                        {[request.author, formatShortDate(request.updatedAt)].filter(Boolean).join(" - ")}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div
                className={cn(
                  "absolute right-0 top-0 hidden h-full w-1.5 cursor-col-resize transition lg:block",
                  isRequestListResizing ? "bg-cyan-400/45" : "bg-transparent hover:bg-cyan-400/25",
                )}
                onMouseDown={startRequestListResize}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize request list"
                title="Resize request list"
              />
            </Card>
          )
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          {renderRequestHeader()}

          {activeDetailTab === "conversation" ? (
            (renderOverviewCard() ?? (shouldShowForgeTokenHint ? renderForgeTokenHintCard() : null))
          ) : activeDetailTab === "commits" ? (
            renderCommitsCard()
          ) : !hasDiff ? (
            <Card className="flex min-h-0 flex-1 items-center justify-center border-zinc-800/80 bg-zinc-950/30 p-4">
              <div className="max-w-md text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/25 bg-cyan-500/[0.07] text-cyan-200">
                  <Eye className="h-4 w-4" aria-hidden />
                </div>
                <p className="mt-3 text-sm font-semibold text-zinc-100">Files changed are not loaded yet</p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Load the diff without running AI. Once it is visible, click any line to add a single comment or batch a review comment.
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-8 px-3 text-[11px]"
                    onClick={() => void loadDiff()}
                    disabled={loadBusy || !activeUrl.trim()}
                  >
                    {loadBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="mr-1 h-3.5 w-3.5" aria-hidden />}
                    Load files changed
                  </Button>
                  {canUseForgeApi ? (
                    <Button type="button" size="sm" className="h-8 px-3 text-[11px]" onClick={startReviewMode} disabled={loadBusy || !activeUrl.trim()}>
                      <MessageSquarePlus className="mr-1 h-3.5 w-3.5" aria-hidden />
                      Start review
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ) : (
            renderDiffCard()
          )}
        </div>
      </div>
    </div>
  );
};
