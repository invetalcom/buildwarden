import type {
  ProjectForgeActivityItem,
  ProjectForgeAuthStatus,
  ProjectForgeRequestDetailsResult,
  ProjectForgeRequestState,
  ProjectForgeRequestSummary,
  ProjectPrMrDiffComment,
  ProjectPrMrDiffResult,
  ProviderType,
  RunDiffReviewFinding,
  RunDiffReviewResult,
  UnifiedProviderFamily,
} from "@buildwarden/shared";
import {
  Bot,
  CheckCircle2,
  Eye,
  ExternalLink,
  FileText,
  GitPullRequest,
  Info,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
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
import { ComposerSelect } from "./RunComposer";
import { GitDiffPreview, type DiffLineCommentTarget, type DiffPreviewManualComment, type GitDiffPreviewHandle } from "./git-diff-preview";
import { countChangedFilesInDiff } from "./git-diff-utils";

interface ProjectPrMrTabProps {
  projectId: string;
  modelOptions: Array<{ id: string; label: string; modelId: string; providerType: ProviderType; providerFamily: UnifiedProviderFamily | null }>;
  defaultModelId: string;
  initialRequest?: { url: string; requestId: number } | null;
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

const requestStateTone = (state: string) => {
  if (state === "merged") {
    return "border-violet-500/30 bg-violet-500/[0.12] text-violet-200";
  }
  if (state === "closed") {
    return "border-rose-500/30 bg-rose-500/[0.08] text-rose-200";
  }
  return "border-cyan-500/30 bg-cyan-500/[0.08] text-cyan-100";
};

const activityKindTone = (kind: ProjectForgeActivityItem["kind"]) => {
  if (kind === "review") return "border-violet-500/25 bg-violet-500/[0.08] text-violet-200";
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

type DraftDiffComment = ProjectPrMrDiffComment & {
  id: string;
  displayPath: string;
  lineLabel: string;
  aiFindingKey?: string;
};

type RequestDetailTab = "overview" | "changes";
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

export const ProjectPrMrTab = ({ projectId, modelOptions, defaultModelId, initialRequest = null }: ProjectPrMrTabProps) => {
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
  const [activeCommentTarget, setActiveCommentTarget] = useState<DiffLineCommentTarget | null>(null);
  const [draftCommentText, setDraftCommentText] = useState("");
  const [editingDraftCommentId, setEditingDraftCommentId] = useState<string | null>(null);
  const [draftComments, setDraftComments] = useState<DraftDiffComment[]>([]);
  const [manualSubmitBusy, setManualSubmitBusy] = useState(false);
  const gitDiffPanelRef = useRef<GitDiffPreviewHandle>(null);
  const [allDiffFilesExpanded, setAllDiffFilesExpanded] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<RequestDetailTab>(() => initialSession?.activeDetailTab ?? "overview");
  const requestDetailsCacheRef = useRef(initialSession?.detailsCache ?? new Map<string, ProjectForgeRequestDetailsResult>());
  const requestDetailsInFlightRef = useRef(new Map<string, Promise<ProjectForgeRequestDetailsResult>>());
  const requestDiffCacheRef = useRef(initialSession?.diffCache ?? new Map<string, ProjectPrMrDiffResult>());
  const requestDiffInFlightRef = useRef(new Map<string, Promise<ProjectPrMrDiffResult>>());
  const requestPreloadGenerationRef = useRef(0);
  const activeRequestUrlRef = useRef(initialSession?.selectedRequest?.url ?? initialSession?.prUrl.trim() ?? "");
  const hydratedProjectIdRef = useRef(projectId);
  const [requestListWidth, setRequestListWidth] = useState(readStoredRequestListWidth);
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
    baseBranch,
    diffText,
    meta,
    prUrl,
    projectId,
    requestDetails,
    requestItems,
    requestProvider,
    requestRepoLabel,
    requestState,
    selectedRequest,
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
      setActiveDetailTab(cached.activeDetailTab);
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
      setActiveDetailTab("overview");
    }

    hydratedProjectIdRef.current = projectId;
    setDetailsBusy(false);
    setLoadBusy(false);
    setListBusy(false);
    setManualSubmitBusy(false);
    setDetailsError(null);
    setLoadError(null);
    setListError(null);
    setPostMessage(null);
    setPostError(null);
    clearDraftEditor();
    setDraftComments([]);
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
  const remoteDiffComments = useMemo<DiffPreviewManualComment[]>(
    () =>
      (visibleRequestDetails?.activity ?? [])
        .filter((item) => item.kind === "diff-comment" && item.path?.trim() && item.line && (item.body?.trim() || item.title.trim()))
        .map((item) => {
          const path = item.path ?? "";
          const line = item.line ?? null;
          const body = item.body?.trim() || item.title;
          return {
            id: `remote-${item.id}`,
            oldPath: path,
            newPath: path,
            side: "new" as const,
            oldLineNumber: null,
            newLineNumber: line,
            changeType: "insert" as const,
            body,
            displayPath: path,
            lineLabel: `${path}:${String(line)} new`,
            author: item.author?.username ?? null,
            createdAt: item.createdAt,
            title: item.title,
            remote: true,
            resolved: item.resolved,
          };
        }),
    [visibleRequestDetails],
  );
  const diffCommentTargets = useMemo<DiffPreviewManualComment[]>(
    () => [...remoteDiffComments, ...draftComments],
    [draftComments, remoteDiffComments],
  );
  const loadedOrReportedFileCount = diffChangedFileCount || visibleRequestDetails?.request.changedFiles || 0;
  const totalActivityCount = visibleRequestDetails?.activity.length ?? visibleRequestDetails?.request.commentCount ?? 0;

  const resetLoadedDiff = useCallback(() => {
    setDiffText("");
    setMeta(null);
    setLoadError(null);
    setReviewPanel(emptyReviewPanel());
    setAllDiffFilesExpanded(false);
    setPostMessage(null);
    setPostError(null);
    clearDraftEditor();
    setDraftComments([]);
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
    (targetUrl: string, targetBaseBranch?: string): Promise<ProjectPrMrDiffResult> => {
      const url = targetUrl.trim();
      if (!url) {
        return Promise.reject(new Error("Enter a PR/MR URL or select a request first."));
      }

      if (!canUseForgeApi) {
        return window.buildwarden.fetchProjectPrMrDiff(projectId, {
          prUrl: url,
          baseBranch: targetBaseBranch?.trim() || undefined,
        });
      }

      const cached = requestDiffCacheRef.current.get(url);
      if (cached) {
        return Promise.resolve(cached);
      }

      const inFlight = requestDiffInFlightRef.current.get(url);
      if (inFlight) {
        return inFlight;
      }

      const generation = requestPreloadGenerationRef.current;
      const request = window.buildwarden
        .fetchProjectPrMrDiff(projectId, {
          prUrl: url,
          baseBranch: targetBaseBranch?.trim() || undefined,
        })
        .then((result) => {
          if (requestPreloadGenerationRef.current === generation) {
            requestDiffCacheRef.current.set(url, result);
          }
          return result;
        })
        .catch((error) => {
          const message = formatAppErrorMessage(error, "Could not load the PR/MR diff.");
          throw new Error(message);
        })
        .finally(() => {
          if (requestDiffInFlightRef.current.get(url) === request) {
            requestDiffInFlightRef.current.delete(url);
          }
        });

      requestDiffInFlightRef.current.set(url, request);
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
    setActiveDetailTab("overview");
    const cachedDetails = requestDetailsCacheRef.current.get(request.url);
    if (cachedDetails) {
      setRequestDetails(cachedDetails);
      setDetailsError(null);
    } else {
      setRequestDetails(null);
      void loadRequestDetails(request.url);
    }

    const cachedDiff = requestDiffCacheRef.current.get(request.url);
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
          /* Prefetch errors surface when the user explicitly opens Changes. */
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

  const loadDiff = async () => {
    const targetUrl = activeUrl.trim();
    if (!targetUrl) {
      setLoadError("Enter a PR/MR URL or select a request first.");
      return;
    }
    setActiveDetailTab("changes");
    setLoadBusy(true);
    setLoadError(null);
    setMeta(null);
    setDiffText("");
    setReviewPanel(emptyReviewPanel());
    setPostMessage(null);
    setPostError(null);
    clearDraftEditor();
    setDraftComments([]);
    try {
      if (canUseForgeApi) {
        void loadRequestDetails(targetUrl);
      } else {
        setRequestDetails(null);
        setDetailsError(null);
      }
      const result = await fetchRequestDiff(targetUrl, activeBaseBranch.trim() || undefined);
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
    setActiveDetailTab("overview");
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

        const cachedDiff = requestDiffCacheRef.current.get(url);
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

  const showChanges = () => {
    setActiveDetailTab("changes");
    if (!hasDiff && activeUrl.trim() && !loadBusy) {
      void loadDiff();
    }
  };

  const runPrMrReview = async () => {
    if (!hasDiff) {
      setReviewPanel((current) => ({
        ...current,
        error: "View changes before running AI review.",
      }));
      return;
    }
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
    setPostMessage(null);
    setPostError(null);
  };

  const submitDraftDiffComments = async () => {
    setManualSubmitBusy(true);
    setPostMessage(null);
    setPostError(null);
    try {
      const result = await window.buildwarden.submitProjectPrMrComments(projectId, {
        prUrl: activeUrl.trim(),
        body: `BuildWarden submitted ${String(draftComments.length)} draft diff comment${draftComments.length === 1 ? "" : "s"}.`,
        comments: draftComments.map(toSubmittedDiffComment),
      });
      setDraftComments([]);
      clearDraftEditor();
      setPostMessage(result.message);
    } catch (error) {
      setPostError(formatAppErrorMessage(error, "Could not submit the draft diff comments."));
    } finally {
      setManualSubmitBusy(false);
    }
  };

  const prLoadHelp =
    "Paste a GitHub PR or GitLab MR link, or fetch requests from the hosting API. View changes loads the diff without running AI review.";

  const renderOverviewCard = () => {
    if (!overviewRequest && !detailsBusy && !detailsError) {
      return null;
    }

    const details = visibleRequestDetails?.request ?? null;
    const description = details?.description?.trim() || "";
    const labels = details?.labels ?? [];

    return (
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-cyan-300" aria-hidden />
            <p className="text-xs font-semibold text-zinc-100">Overview</p>
            {details ? (
              <span className="font-mono text-[10px] text-zinc-500">
                {details.changedFiles != null ? `${String(details.changedFiles)} files` : "diff summary pending"}
                {details.additions != null || details.deletions != null ? (
                  <>
                    {" "}
                    <span className="text-emerald-300">+{String(details.additions ?? 0)}</span>{" "}
                    <span className="text-rose-300">-{String(details.deletions ?? 0)}</span>
                  </>
                ) : null}
              </span>
            ) : null}
          </div>
          {detailsBusy ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Loading activity
            </span>
          ) : null}
        </div>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
          <section className="min-w-0">
            <div className="flex min-w-0 items-start gap-2">
              {details?.authorUser?.avatarUrl ? (
                <img src={details.authorUser.avatarUrl} alt="" className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-zinc-900" />
              ) : (
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] text-zinc-400">
                  {(details?.authorUser?.username ?? overviewRequest?.author)?.slice(0, 2).toUpperCase() ?? "PR"}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-semibold text-zinc-100">{details?.authorUser?.username ?? overviewRequest?.author ?? "Unknown author"}</span>
                  <span className="text-[10px] text-zinc-500">opened this {activeKind}</span>
                  {details?.createdAt ? <span className="text-[10px] text-zinc-600">{formatActivityDate(details.createdAt)}</span> : null}
                </div>
                {labels.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {labels.map((label) => (
                      <span key={label} className="rounded-full border border-zinc-700 bg-zinc-900/80 px-1.5 py-0.5 text-[9px] text-zinc-300">
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/70">
                  {description ? (
                    <div className="app-scrollbar max-h-80 overflow-y-auto break-words p-2 text-zinc-300">
                      <ActivityRichText content={description} compact />
                    </div>
                  ) : (
                    <p className="p-2 text-xs text-zinc-600">No description provided.</p>
                  )}
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
            </div>
          </section>

          <section className="mt-3 border-t border-zinc-800/80 pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
                <p className="text-xs font-semibold text-zinc-100">Timeline</p>
              </div>
              <span className="font-mono text-[10px] text-zinc-500">{String(timelineActivity.length)}</span>
            </div>
            {timelineActivity.length > 0 ? (
              <div className="space-y-2">
                {timelineActivity.map((item) => (
                  <article key={item.id} className="rounded-md border border-zinc-800 bg-zinc-950/55 p-2">
                    <div className="flex min-w-0 items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-semibold text-zinc-200">
                            {item.author?.username ?? (item.provider === "gitlab" ? "GitLab" : "GitHub")}
                          </span>
                          <span className={cn("rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase", activityKindTone(item.kind))}>
                            {item.kind}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-zinc-400">
                          {item.title}
                          {item.path ? (
                            <span className="font-mono text-zinc-500">
                              {" "}
                              in {item.path}
                              {item.line ? `:${String(item.line)}` : ""}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <span className="shrink-0 text-[9px] text-zinc-600">{formatActivityDate(item.createdAt)}</span>
                    </div>
                    {item.body ? <ActivityRichText content={item.body} compact className="mt-2 break-words text-zinc-300" /> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-dashed border-zinc-800 p-3 text-xs text-zinc-600">
                {detailsBusy ? "Loading activity..." : "No timeline events were returned."}
              </p>
            )}
          </section>
        </div>
      </Card>
    );
  };

  const renderDiffCard = () => {
    if (!diffText.trim()) {
      return null;
    }

    return (
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
        <div className="shrink-0 border-b border-zinc-800/80 px-2 py-1.5" title="Merge base to PR/MR head via local git fetch.">
          <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium leading-none text-zinc-100">Diff</p>
              <p className="mt-0.5 hidden text-[9px] leading-tight text-zinc-500 sm:block">
                {canUseForgeApi ? "Click a diff line to draft a comment - AI review is optional" : "Loaded via git fetch without hosting API details"}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
              <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide text-zinc-500" title="Reviewer simulator">
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
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-[10px]"
                onClick={() => void runPrMrReview()}
                disabled={reviewBusy || !hasDiff || !reviewModelId.trim()}
              >
                {reviewBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Bot className="mr-1 h-3.5 w-3.5" aria-hidden />}
                AI review
              </Button>
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
              {draftComments.length > 0 ? (
                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/[0.08] px-2 py-1 text-[9px] font-medium text-cyan-100">
                  {String(draftComments.length)} draft{draftComments.length === 1 ? "" : "s"}
                </span>
              ) : null}
              {canUseForgeApi ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2 text-[10px]"
                  onClick={() => void submitDraftDiffComments()}
                  disabled={manualSubmitBusy || draftComments.length === 0 || !activeUrl.trim()}
                >
                  {manualSubmitBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <MessageSquarePlus className="mr-1 h-3.5 w-3.5" aria-hidden />}
                  Submit drafts
                </Button>
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
                    {postBusy ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <MessageSquarePlus className="mr-1 h-3.5 w-3.5" aria-hidden />
                    )}
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
                    {postBusy ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    )}
                    Approve
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        </div>
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
            manualCommentTargets={diffCommentTargets}
            activeCommentTarget={activeCommentTarget}
            draftCommentText={draftCommentText}
            draftCommentSaveLabel={editingDraftCommentId ? "Save draft" : "Add draft"}
            editingDraftCommentId={editingDraftCommentId}
            draftedReviewFindingKeys={draftedReviewFindingKeys}
            onAddDiffComment={
              canUseForgeApi
                ? (target) => {
                    setActiveCommentTarget(target);
                    setDraftCommentText("");
                    setEditingDraftCommentId(null);
                    setPostMessage(null);
                    setPostError(null);
                  }
                : undefined
            }
            onSaveDraftComment={saveDraftDiffComment}
            onCancelDraftComment={clearDraftEditor}
            onEditDraftComment={canUseForgeApi ? editDraftDiffComment : undefined}
            onRemoveDraftComment={canUseForgeApi ? removeDraftDiffComment : undefined}
            onDraftReviewFinding={canUseForgeApi ? draftAiFindingComment : undefined}
            defaultCollapsedFileSections={false}
            onAllFilesExpandedChange={setAllDiffFilesExpanded}
          />
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
        <div className="flex items-center gap-3 border-t border-zinc-800/80 px-3">
          <button
            type="button"
            className={cn(
              "flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition",
              activeDetailTab === "overview" ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
            onClick={() => setActiveDetailTab("overview")}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            Overview
            <span className="rounded-full bg-zinc-800 px-1.5 py-px font-mono text-[10px] text-zinc-400">{String(totalActivityCount)}</span>
          </button>
          <button
            type="button"
            className={cn(
              "flex h-9 items-center gap-1.5 border-b-2 px-0.5 text-xs font-medium transition",
              activeDetailTab === "changes" ? "border-cyan-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300",
            )}
            onClick={showChanges}
          >
            {loadBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
            Changes
            {loadedOrReportedFileCount > 0 ? (
              <span className="rounded-full bg-zinc-800 px-1.5 py-px font-mono text-[10px] text-zinc-400">
                {String(loadedOrReportedFileCount)}
              </span>
            ) : null}
          </button>
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
                  setActiveDetailTab("overview");
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
            ? "grid overflow-hidden gap-2 lg:grid-cols-[var(--pr-mr-request-list-width)_minmax(0,1fr)]"
            : "flex flex-col",
        )}
        style={requestItems.length > 0 ? requestListLayoutStyle : undefined}
      >
        {requestItems.length > 0 ? (
          <Card className="relative flex min-h-0 flex-col overflow-hidden border-zinc-800/80 bg-zinc-950/40 p-0">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-2 py-1.5">
              <p className="text-[11px] font-semibold text-zinc-100">Requests</p>
              <span className="font-mono text-[9px] text-zinc-500">{String(requestItems.length)}</span>
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
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          {renderRequestHeader()}

          {activeDetailTab === "overview" ? (
            renderOverviewCard()
          ) : !hasDiff ? (
            <Card className="flex min-h-0 flex-1 items-center justify-center border-zinc-800/80 bg-zinc-950/30 p-4">
              <div className="max-w-md text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/25 bg-cyan-500/[0.07] text-cyan-200">
                  <Eye className="h-4 w-4" aria-hidden />
                </div>
                <p className="mt-3 text-sm font-semibold text-zinc-100">Changes are not loaded yet</p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  Use View changes to load the diff without running AI. Once the diff is visible, click any line to draft a manual comment.
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="mt-3 h-8 px-3 text-[11px]"
                  onClick={() => void loadDiff()}
                  disabled={loadBusy || !activeUrl.trim()}
                >
                  {loadBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="mr-1 h-3.5 w-3.5" aria-hidden />}
                  View changes
                </Button>
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
