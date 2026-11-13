import {
  buildForgeIssueChatPrompt,
  buildForgeIssueContextAttachment,
  buildForgeIssueRunPrompt,
  PROJECT_FORGE_ISSUE_SAVED_FILTER_LIMIT,
  type ChatSummary,
  type CreateProjectForgeIssueInput,
  type ForgeIssueReference,
  type ProjectForgeIssueAccess,
  type ProjectForgeIssueAssistKind,
  type ProjectForgeIssueAutomationSettings,
  type ProjectForgeIssueDetailsResult,
  type ProjectForgeIssueMetadataResult,
  type ProjectForgeIssuePreferences,
  type ProjectForgeIssueSummary,
  type ProjectForgeIssueTriageResult,
  type ProjectForgeIssueWorkLink,
  type ProjectForgeIssuesUnavailable,
  type ProjectForgeProvider,
  type ProjectTaskSummary,
  type RunListItem,
  type RunMode,
  type UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import { CircleDot, KeyRound, Loader2, PanelLeftOpen, Plus, RefreshCw, Settings, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatAppErrorMessage } from "../../lib/app-error-message";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ProjectIssueDetail } from "./ProjectIssueDetail";
import { AskIssueDialog, CreateIssueDialog, IssueAutomationDialog, StartIssueRunDialog, type StartIssueRunsInput } from "./ProjectIssueDialogs";
import { IssueFilterBar } from "./ProjectIssueFilters";
import { ProjectIssueList } from "./ProjectIssueList";
import { useForgeListWidth } from "./project-forge-list-width";
import { createIssueImageLoader } from "./project-issue-images";
import { IssueAvatar, IssueLabelSwatch, type IssuePickerOption } from "./project-issue-parts";
import {
  DEFAULT_ISSUE_FILTERS,
  describeIssueAccess,
  groupLinksByIssue,
  issueUnavailableTitle,
  newSavedFilterKey,
  readSeenIssues,
  searchIssues,
  summarizeIssueWork,
  writeSeenIssues,
  type ForgeIssueChatRequest,
  type ForgeIssueRunRequest,
  type IssueFilters,
  type IssueWorkSummary,
} from "./project-issues-model";

export interface ProjectIssuesTabProps {
  projectId: string;
  baseBranch: string;
  runs: readonly RunListItem[];
  tasks: readonly ProjectTaskSummary[];
  chats: readonly ChatSummary[];
  modelOptions: ReadonlyArray<{ id: string; label: string }>;
  defaultModelId: string;
  preferences: ProjectForgeIssuePreferences;
  /** The switch between PRs and issues, shown at the start of the header. */
  headerLead?: ReactNode;
  /** Issue to open, e.g. from a notification. A new `requestId` reopens the same issue. */
  initialIssue?: { number: number; requestId: number } | null;
  onIssueCountChange?: (count: { count: number; more: boolean } | null) => void;
  /** Reports the Git host once the first list has loaded. */
  onProviderChange?: (provider: ProjectForgeProvider | null) => void;
  onSavePreferences: (preferences: ProjectForgeIssuePreferences) => Promise<void>;
  onStartIssueRuns: (requests: ForgeIssueRunRequest[], options: { modelId: string; mode: RunMode }) => Promise<void>;
  onAskIssue: (request: ForgeIssueChatRequest) => Promise<void>;
  /** Called after a task was created so the snapshot can refresh. */
  onWorkChanged: () => void | Promise<void>;
  onOpenProjectSettings: () => void;
  onSelectRun: (runId: string) => void;
  onOpenChat: (chatId: string) => void;
  onOpenTaskBoard: () => void;
  /** Opens a pull or merge request in the PR view of this page. */
  onOpenRequest: (url: string) => void;
}

type DialogState =
  | { kind: "run"; issues: ProjectForgeIssueSummary[] }
  | { kind: "ask"; issue: ProjectForgeIssueSummary }
  | { kind: "create" }
  | { kind: "automation" };

/** What the user was looking at, kept while the app runs so leaving and reopening the page restores it. */
const issueSessions = new Map<string, { filters: IssueFilters; search: string; selectedNumber: number | null }>();

const referenceOf = (projectId: string, issue: ProjectForgeIssueSummary): ForgeIssueReference => ({
  projectId,
  provider: issue.provider,
  number: issue.number,
  url: issue.url,
  title: issue.title,
});

const contextAttachment = (details: ProjectForgeIssueDetailsResult) =>
  buildForgeIssueContextAttachment({
    repoLabel: details.repoLabel,
    issue: details.issue,
    timeline: details.timeline,
    linkedRequests: details.linkedRequests,
    subIssues: details.subIssues,
  });

export const ProjectIssuesTab = ({
  projectId,
  baseBranch,
  runs,
  tasks,
  chats,
  modelOptions,
  defaultModelId,
  preferences,
  headerLead,
  initialIssue = null,
  onIssueCountChange,
  onProviderChange,
  onSavePreferences,
  onStartIssueRuns,
  onAskIssue,
  onWorkChanged,
  onOpenProjectSettings,
  onSelectRun,
  onOpenChat,
  onOpenTaskBoard,
  onOpenRequest,
}: ProjectIssuesTabProps) => {
  const buildwarden = useBuildWardenClient();
  const restored = issueSessions.get(projectId);
  const [filters, setFilters] = useState<IssueFilters>(restored?.filters ?? DEFAULT_ISSUE_FILTERS);
  const [search, setSearch] = useState(restored?.search ?? "");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(initialIssue?.number ?? restored?.selectedNumber ?? null);
  const [list, setList] = useState<{ items: ProjectForgeIssueSummary[]; hasMore: boolean; page: number }>({ items: [], hasMore: false, page: 1 });
  const [host, setHost] = useState<{ provider: ProjectForgeProvider; repoLabel: string } | null>(null);
  const [access, setAccess] = useState<ProjectForgeIssueAccess | null>(null);
  const [unavailable, setUnavailable] = useState<ProjectForgeIssuesUnavailable | null>(null);
  const [links, setLinks] = useState<ProjectForgeIssueWorkLink[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailsByNumber, setDetailsByNumber] = useState<Record<number, ProjectForgeIssueDetailsResult>>({});
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<ProjectForgeIssueMetadataResult | null>(null);
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => new Set());
  const [seen, setSeen] = useState(() => readSeenIssues(projectId));
  const [collapsed, setCollapsed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assistBusy, setAssistBusy] = useState<ProjectForgeIssueAssistKind | null>(null);
  const [assistModelId, setAssistModelId] = useState(defaultModelId);
  const [assistResults, setAssistResults] = useState<Record<number, { summary?: string; triage?: ProjectForgeIssueTriageResult }>>({});
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const listRequest = useRef(0);
  const detailsRequest = useRef(0);
  /** Per issue: the most recent details request, to tell an outdated answer from the current one. */
  const latestDetailsRequest = useRef(new Map<number, number>());
  const metadataRequested = useRef(false);
  const dialogActionActive = useRef(false);
  const listWidth = useForgeListWidth();

  const hasToken = access?.mode === "token";
  const { capabilities } = buildwarden;
  const canWriteHost = capabilities.gitMutations;

  /** Pictures in issues are fetched by the app itself, because the Git host only serves them to a signed-in reader. */
  const loadImage = useMemo(
    () => createIssueImageLoader(async (url, issueNumber) => (await buildwarden.getProjectForgeIssueImage(projectId, { url, issueNumber })).dataUrl),
    [buildwarden, projectId],
  );

  const hostProvider = host?.provider ?? null;
  useEffect(() => {
    onProviderChange?.(hostProvider);
  }, [hostProvider, onProviderChange]);

  useEffect(() => {
    issueSessions.set(projectId, { filters, search, selectedNumber });
  }, [filters, projectId, search, selectedNumber]);

  useEffect(() => {
    if (!modelOptions.some((option) => option.id === assistModelId)) setAssistModelId(defaultModelId);
  }, [assistModelId, defaultModelId, modelOptions]);

  const loadIssues = useCallback(
    async (options: { refresh?: boolean; page?: number } = {}) => {
      const requestId = ++listRequest.current;
      const page = options.page ?? 1;
      setListBusy(true);
      setListError(null);
      try {
        const result = await buildwarden.listProjectForgeIssues(projectId, {
          state: filters.state,
          labels: filters.labels,
          assignee: filters.assignee || undefined,
          milestone: filters.milestone || undefined,
          sort: filters.sort,
          page,
          refresh: options.refresh,
        });
        if (requestId !== listRequest.current) return;
        setHost({ provider: result.provider, repoLabel: result.repoLabel });
        setAccess(result.access);
        setUnavailable(result.unavailable);
        setLinks(result.links);
        setList((current) => {
          if (page === 1) return { items: result.items, hasMore: result.hasMore, page: 1 };
          const known = new Set(current.items.map((issue) => issue.number));
          return { items: [...current.items, ...result.items.filter((issue) => !known.has(issue.number))], hasMore: result.hasMore, page };
        });
      } catch (caught) {
        if (requestId === listRequest.current) setListError(formatAppErrorMessage(caught, "Could not load issues."));
      } finally {
        if (requestId === listRequest.current) setListBusy(false);
      }
    },
    [buildwarden, filters, projectId],
  );

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const markSeen = useCallback(
    (issueNumber: number, updatedAt: string | null) => {
      setSeen((current) => {
        const next = { ...current, [String(issueNumber)]: updatedAt ?? new Date().toISOString() };
        writeSeenIssues(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  const loadDetails = useCallback(
    async (issueNumber: number, refresh = false): Promise<ProjectForgeIssueDetailsResult | null> => {
      const requestId = ++detailsRequest.current;
      latestDetailsRequest.current.set(issueNumber, requestId);
      setDetailsBusy(true);
      setDetailsError(null);
      try {
        const result = await buildwarden.getProjectForgeIssueDetails(projectId, { issueNumber, refresh });
        // An earlier request for the same issue can finish after a later one, e.g. after the refresh that follows
        // a comment. Its answer is outdated and must not replace the newer conversation.
        if (latestDetailsRequest.current.get(issueNumber) !== requestId) return result;
        setDetailsByNumber((current) => ({ ...current, [issueNumber]: result }));
        setAccess(result.access);
        setLinks((current) => [...current.filter((link) => link.issueNumber !== issueNumber), ...result.links]);
        markSeen(issueNumber, result.issue.updatedAt);
        return result;
      } catch (caught) {
        if (requestId === detailsRequest.current) setDetailsError(formatAppErrorMessage(caught, "Could not load this issue."));
        return null;
      } finally {
        if (requestId === detailsRequest.current) setDetailsBusy(false);
      }
    },
    [buildwarden, markSeen, projectId],
  );

  useEffect(() => {
    if (selectedNumber !== null) void loadDetails(selectedNumber);
  }, [loadDetails, selectedNumber]);

  const initialRequestId = initialIssue?.requestId;
  const initialNumber = initialIssue?.number;
  const handledInitialRequest = useRef(initialRequestId);
  useEffect(() => {
    if (initialRequestId === undefined || initialNumber === undefined || handledInitialRequest.current === initialRequestId) return;
    handledInitialRequest.current = initialRequestId;
    setSelectedNumber(initialNumber);
    void loadDetails(initialNumber, true);
  }, [initialNumber, initialRequestId, loadDetails]);

  const requestMetadata = useCallback(() => {
    // Without a token every request counts against a small budget, so filter options come from the loaded issues instead.
    if (metadataRequested.current || !hasToken) return;
    metadataRequested.current = true;
    setMetadataBusy(true);
    void buildwarden
      .getProjectForgeIssueMetadata(projectId)
      .then(setMetadata)
      .catch((caught: unknown) => {
        metadataRequested.current = false;
        setError(formatAppErrorMessage(caught, "Could not load labels and milestones."));
      })
      .finally(() => setMetadataBusy(false));
  }, [buildwarden, hasToken, projectId]);

  const visibleIssues = useMemo(() => searchIssues(list.items, search), [list.items, search]);
  const selectedDetails = selectedNumber !== null ? (detailsByNumber[selectedNumber] ?? null) : null;
  const selectedIssue = selectedNumber !== null ? (list.items.find((issue) => issue.number === selectedNumber) ?? selectedDetails?.issue ?? null) : null;

  const known = useMemo(() => ({ runs, chats, tasks }), [chats, runs, tasks]);
  const workByIssue = useMemo(() => {
    const result = new Map<number, IssueWorkSummary>();
    for (const issueNumber of groupLinksByIssue(links).keys()) result.set(issueNumber, summarizeIssueWork(issueNumber, links, known));
    return result;
  }, [known, links]);
  const selectedWork = useMemo<IssueWorkSummary>(
    () => (selectedNumber !== null ? workByIssue.get(selectedNumber) : undefined) ?? { runs: [], chats: [], tasks: [], activeRun: false },
    [selectedNumber, workByIssue],
  );

  const issueCount = unavailable || list.items.length === 0 ? null : list.items.length;
  const issueCountMore = list.hasMore;
  useEffect(() => {
    onIssueCountChange?.(issueCount === null ? null : { count: issueCount, more: issueCountMore });
  }, [issueCount, issueCountMore, onIssueCountChange]);

  const applyIssue = useCallback((issue: ProjectForgeIssueSummary) => {
    setList((current) => ({ ...current, items: current.items.map((entry) => (entry.number === issue.number ? issue : entry)) }));
  }, []);

  const runAction = async (fallback: string, action: () => Promise<string | void>): Promise<boolean> => {
    setActionBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result) setMessage(result);
      return true;
    } catch (caught) {
      setError(formatAppErrorMessage(caught, fallback));
      return false;
    } finally {
      setActionBusy(false);
    }
  };

  const updateIssue = (issueNumber: number, input: Omit<UpdateProjectForgeIssueInput, "issueNumber">) =>
    runAction("Could not update the issue.", async () => {
      const result = await buildwarden.updateProjectForgeIssue(projectId, { ...input, issueNumber });
      applyIssue(result.issue);
      await loadDetails(issueNumber, true);
      return result.message;
    });

  const commentIssue = (issueNumber: number, body: string) =>
    runAction("Could not post the comment.", async () => {
      const result = await buildwarden.commentProjectForgeIssue(projectId, { issueNumber, body });
      applyIssue(result.issue);
      await loadDetails(issueNumber, true);
      return result.message;
    });

  const assist = async (issueNumber: number, input: { kind: ProjectForgeIssueAssistKind; instructions?: string; runId?: string }): Promise<string | null> => {
    if (!assistModelId) {
      setError("Choose a model under AI assist first.");
      return null;
    }
    setAssistBusy(input.kind);
    setError(null);
    try {
      if (input.kind === "triage") requestMetadata();
      const result = await buildwarden.assistProjectForgeIssue(projectId, { issueNumber, modelId: assistModelId, ...input });
      if (result.kind === "summary") setAssistResults((current) => ({ ...current, [issueNumber]: { ...current[issueNumber], summary: result.text } }));
      if (result.kind === "triage" && result.triage) {
        const { triage } = result;
        setAssistResults((current) => ({ ...current, [issueNumber]: { ...current[issueNumber], triage } }));
      }
      return result.kind === "reply" ? result.text : null;
    } catch (caught) {
      setError(formatAppErrorMessage(caught, "The model could not help with this issue."));
      return null;
    } finally {
      setAssistBusy(null);
    }
  };

  /**
   * The issue with its conversation, as context for a run, chat, or task. Details opened earlier are reused
   * only while the list does not show a newer version of the issue; otherwise they are fetched again.
   */
  const ensureDetails = async (issueNumber: number): Promise<ProjectForgeIssueDetailsResult> => {
    const cached = detailsByNumber[issueNumber];
    const listedUpdatedAt = list.items.find((issue) => issue.number === issueNumber)?.updatedAt;
    if (cached && (!listedUpdatedAt || (cached.issue.updatedAt ?? "") >= listedUpdatedAt)) return cached;
    const result = await buildwarden.getProjectForgeIssueDetails(projectId, { issueNumber, refresh: cached !== undefined });
    setDetailsByNumber((current) => ({ ...current, [issueNumber]: result }));
    return result;
  };

  const runDialogAction = async (fallback: string, action: () => Promise<void>) => {
    // A second submission (a repeated shortcut, a double click) must not start the same work twice.
    if (dialogActionActive.current) return;
    dialogActionActive.current = true;
    setDialogBusy(true);
    setDialogError(null);
    try {
      await action();
      setDialog(null);
    } catch (caught) {
      setDialogError(formatAppErrorMessage(caught, fallback));
    } finally {
      dialogActionActive.current = false;
      setDialogBusy(false);
    }
  };

  const openDialog = (next: DialogState) => {
    setDialogError(null);
    if (next.kind === "create" || next.kind === "automation") requestMetadata();
    setDialog(next);
  };

  const startRuns = (issues: ProjectForgeIssueSummary[], input: StartIssueRunsInput) =>
    runDialogAction("Could not start the run.", async () => {
      const requests: ForgeIssueRunRequest[] = [];
      for (const issue of issues) {
        const details = await ensureDetails(issue.number);
        requests.push({
          issue: referenceOf(projectId, details.issue),
          prompt: issues.length === 1 && input.prompt?.trim() ? input.prompt : buildForgeIssueRunPrompt(details.issue, input.intent),
          attachments: [contextAttachment(details)],
        });
      }
      await onStartIssueRuns(requests, { modelId: input.modelId, mode: input.intent === "investigate" ? "plan" : "code" });
      setChecked(new Set());
      setMessage(requests.length === 1 ? `Run started for #${String(requests[0]?.issue.number ?? "")}.` : `${String(requests.length)} runs started.`);
      void loadIssues();
    });

  const askIssue = (issue: ProjectForgeIssueSummary, input: { modelId: string; question: string }) =>
    runDialogAction("Could not open the chat.", async () => {
      const details = await ensureDetails(issue.number);
      await onAskIssue({
        issue: referenceOf(projectId, details.issue),
        prompt: buildForgeIssueChatPrompt(details.issue, input.question),
        modelId: input.modelId,
        attachments: [contextAttachment(details)],
      });
    });

  const createIssue = (input: CreateProjectForgeIssueInput) =>
    runDialogAction("Could not create the issue.", async () => {
      const result = await buildwarden.createProjectForgeIssue(projectId, input);
      setMessage(result.message);
      setSelectedNumber(result.issue.number);
      await loadIssues({ refresh: true });
    });

  const saveAutomation = (automation: ProjectForgeIssueAutomationSettings) =>
    runDialogAction("Could not save the label trigger.", () => onSavePreferences({ ...preferences, automation }));

  const addTask = (issueNumber: number) =>
    runAction("Could not add the issue to the Task Board.", async () => {
      const details = await ensureDetails(issueNumber);
      await buildwarden.createProjectTask(projectId, {
        title: `#${String(details.issue.number)} ${details.issue.title}`.slice(0, 200),
        prompt: buildForgeIssueRunPrompt(details.issue, "implement"),
        attachments: [contextAttachment(details)],
        forgeIssue: referenceOf(projectId, details.issue),
      });
      await onWorkChanged();
      void loadIssues();
      return "Added to the Task Board. The task is marked done when the issue closes.";
    });

  const savePreferences = (next: ProjectForgeIssuePreferences) => {
    setError(null);
    void onSavePreferences(next).catch((caught: unknown) => setError(formatAppErrorMessage(caught, "Could not save the view.")));
  };

  const toggleChecked = (issueNumber: number) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(issueNumber)) next.delete(issueNumber);
      else next.add(issueNumber);
      return next;
    });

  const changeFilters = (patch: Partial<IssueFilters>) => {
    setChecked(new Set());
    setFilters((current) => ({ ...current, ...patch }));
  };

  const labelFilterOptions = useMemo<IssuePickerOption[]>(() => {
    const byName = new Map<string, { color: string | null; description: string | null }>();
    for (const label of metadata?.labels ?? list.items.flatMap((issue) => issue.labels)) byName.set(label.name, label);
    for (const name of filters.labels) if (!byName.has(name)) byName.set(name, { color: null, description: null });
    return [...byName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, label]) => ({ value: name, label: name, description: label.description, leading: <IssueLabelSwatch color={label.color} /> }));
  }, [filters.labels, list.items, metadata?.labels]);

  const assigneeFilterOptions = useMemo<IssuePickerOption[]>(() => {
    const users = new Map((metadata?.assignees ?? list.items.flatMap((issue) => issue.assignees)).map((user) => [user.username, user]));
    return [
      { value: "", label: "Anyone" },
      ...(access?.viewer ? [{ value: "@me", label: "Assigned to me", description: access.viewer }] : []),
      { value: "none", label: "Unassigned" },
      ...[...users.values()]
        .sort((left, right) => left.username.localeCompare(right.username))
        .map((user) => ({ value: user.username, label: user.username, description: user.name, leading: <IssueAvatar user={user} size="sm" /> })),
    ];
  }, [access?.viewer, list.items, metadata?.assignees]);

  const milestoneFilterOptions = useMemo<IssuePickerOption[]>(() => {
    const titles = new Set<string>(
      metadata?.milestones.map((milestone) => milestone.title) ?? list.items.flatMap((issue) => (issue.milestone ? [issue.milestone.title] : [])),
    );
    if (filters.milestone) titles.add(filters.milestone);
    return [{ value: "", label: "Any milestone" }, ...[...titles].sort((left, right) => left.localeCompare(right)).map((title) => ({ value: title, label: title }))];
  }, [filters.milestone, list.items, metadata?.milestones]);

  const accessChip = describeIssueAccess(unavailable ? null : access);
  const automation = preferences.automation;
  const providerName = host?.provider === "gitlab" ? "GitLab" : "GitHub";
  const canCreate = canWriteHost && hasToken && (access?.canWrite ?? false);

  const renderUnavailable = (reason: ProjectForgeIssuesUnavailable) => {
    const tokenFix = reason.reason === "needs-token" || reason.reason === "token-rejected" || reason.reason === "token-lacks-permission";
    return (
      <Card className="flex min-h-0 flex-1 items-center justify-center overflow-hidden border-[var(--ec-border)] bg-[var(--ec-panel)] p-4">
        <div className="max-w-md text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]">
            {tokenFix ? <KeyRound className="h-4 w-4" aria-hidden /> : <CircleDot className="h-4 w-4" aria-hidden />}
          </div>
          <p className="mt-3 text-sm font-semibold text-[var(--ec-text)]">{issueUnavailableTitle(reason.reason)}</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--ec-muted)]">{reason.message}</p>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {tokenFix ? (
              <Button type="button" size="sm" className="h-8 px-3 text-[11px]" onClick={onOpenProjectSettings}>
                <Settings className="mr-1 h-3.5 w-3.5" aria-hidden />
                Open Project Settings
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="secondary" className="h-8 px-3 text-[11px]" onClick={() => void loadIssues({ refresh: true })} disabled={listBusy}>
              {listBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Try again
            </Button>
          </div>
        </div>
      </Card>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <Card className="shrink-0 border-[var(--ec-border)] bg-[var(--ec-panel)] p-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {headerLead}
            {host ? (
              <span className="min-w-0 truncate text-[10px] text-[var(--ec-muted)]">
                {providerName} · <span className="font-mono">{host.repoLabel}</span>
              </span>
            ) : null}
            {accessChip ? (
              <span
                className={cn(
                  "rounded border px-1.5 py-px text-[9px] font-medium",
                  accessChip.tone === "warning"
                    ? "border-[var(--ec-warning-ring)] bg-[var(--ec-warning-soft)] text-[var(--ec-warning)]"
                    : "border-[var(--ec-border)] bg-[var(--ec-panel-soft)] text-[var(--ec-muted)]",
                )}
                title={accessChip.title}
              >
                {accessChip.label}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
              onClick={() => void loadIssues({ refresh: true })}
              disabled={listBusy}
              title="Fetch the issues again from the Git host"
              aria-label="Fetch issues again"
            >
              {listBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
            </Button>
            {capabilities.runMutations && capabilities.settings ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={cn("h-7 w-7", automation?.enabled ? "text-[var(--ec-accent)] hover:text-[var(--ec-accent)]" : "text-[var(--ec-muted)] hover:text-[var(--ec-text)]")}
                onClick={() => openDialog({ kind: "automation" })}
                title={automation?.enabled ? `Runs start automatically for issues labelled "${automation.label}"` : "Start runs automatically from a label"}
                aria-label="Start runs from a label"
              >
                <Zap className={cn("h-3.5 w-3.5", automation?.enabled && "fill-current")} aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="ml-1.5 h-7 shrink-0 px-2.5 text-[11px]"
              onClick={() => openDialog({ kind: "create" })}
              disabled={!canCreate}
              title={canCreate ? "Create a new issue" : "Creating issues needs a Git hosting access token"}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              New issue
            </Button>
          </div>
        </div>
        {listError ? <p className="mt-1 text-[9px] text-[var(--ec-danger)]">{listError}</p> : null}
        {!selectedIssue && message ? <p className="mt-1 text-[9px] text-[var(--ec-success)]">{message}</p> : null}
        {!selectedIssue && error ? <p className="mt-1 text-[9px] text-[var(--ec-danger)]">{error}</p> : null}
      </Card>

      {unavailable ? (
        renderUnavailable(unavailable)
      ) : (
        <div
          className={cn(
            "grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-2 overflow-hidden lg:grid-rows-1",
            collapsed ? "grid-cols-[2.25rem_minmax(0,1fr)] grid-rows-1" : "lg:grid-cols-[var(--pr-mr-request-list-width)_minmax(0,1fr)]",
          )}
          style={listWidth.style}
        >
          {collapsed ? (
            <Card className="flex min-h-0 flex-col items-center overflow-hidden border-[var(--ec-border)] bg-[var(--ec-panel)] py-1.5">
              <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-accent-strong)]" onClick={() => setCollapsed(false)} title="Show issue list" aria-label="Show issue list">
                <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <span className="mt-1 rounded-full bg-[var(--ec-accent-soft)] px-1.5 py-px font-mono text-[9px] text-[var(--ec-accent)]" title={`${String(list.items.length)} issues`}>
                {String(list.items.length)}
              </span>
            </Card>
          ) : (
            <ProjectIssueList
              issues={visibleIssues}
              loadedCount={list.items.length}
              hasMore={list.hasMore}
              busy={listBusy}
              search={search}
              selectedNumber={selectedNumber}
              checkedNumbers={checked}
              seen={seen}
              workByIssue={workByIssue}
              canStartRuns={capabilities.runMutations}
              resizing={listWidth.resizing}
              filterBar={
                <IssueFilterBar
                  provider={host?.provider ?? null}
                  filters={filters}
                  busy={listBusy}
                  labelOptions={labelFilterOptions}
                  assigneeOptions={assigneeFilterOptions}
                  milestoneOptions={milestoneFilterOptions}
                  optionsBusy={metadataBusy}
                  labelsEmptyMessage={hasToken ? "This repository has no labels." : "No labels on the loaded issues."}
                  savedFilters={preferences.savedFilters}
                  canEditViews={capabilities.settings}
                  onChange={changeFilters}
                  onOpen={requestMetadata}
                  onSaveView={(name) =>
                    savePreferences({
                      ...preferences,
                      savedFilters: [...preferences.savedFilters, { key: newSavedFilterKey(), name, ...filters }].slice(-PROJECT_FORGE_ISSUE_SAVED_FILTER_LIMIT),
                    })
                  }
                  onDeleteView={(key) => savePreferences({ ...preferences, savedFilters: preferences.savedFilters.filter((entry) => entry.key !== key) })}
                />
              }
              onSearchChange={setSearch}
              onSelect={(issue) => {
                setMessage(null);
                setError(null);
                if (issue.number === selectedNumber) void loadDetails(issue.number);
                else setSelectedNumber(issue.number);
              }}
              onToggleChecked={toggleChecked}
              onClearChecked={() => setChecked(new Set())}
              onStartCheckedRuns={() => openDialog({ kind: "run", issues: list.items.filter((issue) => checked.has(issue.number)) })}
              onLoadMore={() => void loadIssues({ page: list.page + 1 })}
              onCollapse={() => setCollapsed(true)}
              onResizeStart={listWidth.startResize}
            />
          )}

          {selectedIssue ? (
            <ProjectIssueDetail
              key={selectedIssue.number}
              issue={selectedIssue}
              details={selectedDetails}
              detailsBusy={detailsBusy}
              detailsError={detailsError}
              access={access}
              metadata={metadata}
              metadataBusy={metadataBusy}
              work={selectedWork}
              modelOptions={modelOptions}
              assistModelId={assistModelId}
              capabilities={{ writes: canWriteHost, runs: capabilities.runMutations, chats: capabilities.chatMutations, tasks: capabilities.taskMutations }}
              actionBusy={actionBusy}
              assistBusy={assistBusy}
              message={message}
              error={error}
              commentDraft={drafts[selectedIssue.number] ?? ""}
              summary={assistResults[selectedIssue.number]?.summary ?? null}
              triage={assistResults[selectedIssue.number]?.triage ?? null}
              onCommentDraftChange={(value) =>
                setDrafts((current) => ({ ...current, [selectedIssue.number]: typeof value === "function" ? value(current[selectedIssue.number] ?? "") : value }))
              }
              onAssistModelChange={setAssistModelId}
              onDismissSummary={() => setAssistResults((current) => ({ ...current, [selectedIssue.number]: { ...current[selectedIssue.number], summary: undefined } }))}
              onDismissTriage={() => setAssistResults((current) => ({ ...current, [selectedIssue.number]: { ...current[selectedIssue.number], triage: undefined } }))}
              onRequestMetadata={requestMetadata}
              onRefresh={() => void loadDetails(selectedIssue.number, true)}
              onOpenExternal={(url) => void buildwarden.openExternalUrl(url)}
              onOpenSettings={onOpenProjectSettings}
              onUpdate={(input) => updateIssue(selectedIssue.number, input)}
              onComment={(body) => commentIssue(selectedIssue.number, body)}
              onAssist={(input) => assist(selectedIssue.number, input)}
              onAsk={() => openDialog({ kind: "ask", issue: selectedIssue })}
              onStartRun={() => openDialog({ kind: "run", issues: [selectedIssue] })}
              onAddTask={() => (selectedWork.tasks.length > 0 ? onOpenTaskBoard() : void addTask(selectedIssue.number))}
              onSelectRun={onSelectRun}
              onOpenChat={onOpenChat}
              onOpenTaskBoard={onOpenTaskBoard}
              onSelectIssue={setSelectedNumber}
              onOpenRequest={onOpenRequest}
              loadImage={loadImage}
            />
          ) : (
            <Card className="flex min-h-0 flex-1 items-center justify-center overflow-hidden border-[var(--ec-border)] bg-[var(--ec-panel)] p-4">
              <div className="max-w-sm text-center">
                <p className="text-sm font-semibold text-[var(--ec-text)]">{listBusy && list.items.length === 0 ? "Loading issues…" : "Select an issue to read it here"}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--ec-muted)]">
                  From an issue you can comment, ask a question in a chat, or start an agent run. The issue and its comments are handed over as context.
                </p>
              </div>
            </Card>
          )}
        </div>
      )}

      {dialog?.kind === "run" ? (
        <StartIssueRunDialog issues={dialog.issues} modelOptions={modelOptions} defaultModelId={assistModelId || defaultModelId} baseBranch={baseBranch} busy={dialogBusy} error={dialogError} onStart={(input) => void startRuns(dialog.issues, input)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "ask" ? (
        <AskIssueDialog issue={dialog.issue} modelOptions={modelOptions} defaultModelId={assistModelId || defaultModelId} busy={dialogBusy} error={dialogError} onAsk={(input) => void askIssue(dialog.issue, input)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "create" && host ? (
        <CreateIssueDialog provider={host.provider} metadata={metadata} metadataBusy={metadataBusy} canTriage={access?.canTriage ?? false} busy={dialogBusy} error={dialogError} onCreate={(input) => void createIssue(input)} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "automation" ? (
        <IssueAutomationDialog settings={automation} metadata={metadata} modelOptions={modelOptions} defaultModelId={defaultModelId} hasToken={hasToken} busy={dialogBusy} error={dialogError} onSave={(settings) => void saveAutomation(settings)} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
};
