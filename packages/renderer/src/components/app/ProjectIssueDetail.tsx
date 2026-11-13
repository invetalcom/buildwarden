import {
  absolutizeForgeIssueUploads,
  type ProjectForgeIssueAccess,
  type ProjectForgeIssueAssistKind,
  type ProjectForgeIssueCloseReason,
  type ProjectForgeIssueDetailsResult,
  type ProjectForgeIssueMetadataResult,
  type ProjectForgeIssueSummary,
  type ProjectForgeIssueTimelineItem,
  type ProjectForgeIssueTriageResult,
  type UpdateProjectForgeIssueInput,
} from "@buildwarden/shared";
import {
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  CircleSlash,
  ExternalLink,
  GitPullRequest,
  ListChecks,
  ListPlus,
  Loader2,
  Lock,
  MessagesSquare,
  Milestone,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Tag,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { ActivityRichText, type ActivityRichTextImage } from "../ui/activity-rich-text";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";
import { ProjectIssueImage, type IssueImageHost } from "./ProjectIssueImage";
import {
  IssueAvatar,
  IssueAvatarStack,
  IssueLabelChip,
  IssueLabelSwatch,
  IssuePickerPopover,
  IssueStateBadge,
  IssueStateIcon,
  type IssuePickerOption,
} from "./project-issue-parts";
import type { IssueImageLoader } from "./project-issue-images";
import { formatIssueAge, formatIssueDate, isActiveRunStatus, type IssueWorkSummary } from "./project-issues-model";
import { RUN_DISPLAY_STATUS_LABELS } from "./run-display-status";

type DetailTab = "conversation" | "linked";

export interface ProjectIssueDetailCapabilities {
  /** The client may change things on the Git host at all (always true on desktop). */
  writes: boolean;
  runs: boolean;
  chats: boolean;
  tasks: boolean;
}

export interface ProjectIssueDetailProps {
  issue: ProjectForgeIssueSummary;
  details: ProjectForgeIssueDetailsResult | null;
  detailsBusy: boolean;
  detailsError: string | null;
  access: ProjectForgeIssueAccess | null;
  metadata: ProjectForgeIssueMetadataResult | null;
  metadataBusy: boolean;
  work: IssueWorkSummary;
  modelOptions: ReadonlyArray<{ id: string; label: string }>;
  assistModelId: string;
  capabilities: ProjectIssueDetailCapabilities;
  actionBusy: boolean;
  assistBusy: ProjectForgeIssueAssistKind | null;
  message: string | null;
  error: string | null;
  commentDraft: string;
  summary: string | null;
  triage: ProjectForgeIssueTriageResult | null;
  /** Downloads an image shown in the issue through the host. */
  loadImage: IssueImageLoader;
  onCommentDraftChange: (value: string) => void;
  onAssistModelChange: (modelId: string) => void;
  onDismissSummary: () => void;
  onDismissTriage: () => void;
  onRequestMetadata: () => void;
  onRefresh: () => void;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
  onUpdate: (input: Omit<UpdateProjectForgeIssueInput, "issueNumber">) => Promise<boolean>;
  onComment: (body: string) => Promise<boolean>;
  /** Summary and triage results are stored by the caller; a reply draft is returned. */
  onAssist: (input: { kind: ProjectForgeIssueAssistKind; instructions?: string; runId?: string }) => Promise<string | null>;
  onAsk: () => void;
  onStartRun: () => void;
  onAddTask: () => void;
  onSelectRun: (runId: string) => void;
  onOpenChat: (chatId: string) => void;
  onOpenTaskBoard: () => void;
  onSelectIssue: (issueNumber: number) => void;
  onOpenRequest: (url: string) => void;
}

const TOKEN_HINT = "Needs a Git hosting access token";
const TRIAGE_HINT = "The saved token may not change labels, assignees, milestones, or the state of issues in this repository";
const REMOTE_HINT = "This remote session may not change the Git host";

const tabClass = (active: boolean) =>
  cn(
    "flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
    active ? "bg-[var(--ec-control)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
  );

const metaButtonClass = (editable: boolean) =>
  cn(
    "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 text-[10px] text-[var(--ec-muted)] transition-colors",
    editable ? "hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" : "cursor-default",
  );

const SectionTitle = ({ children, count }: Readonly<{ children: ReactNode; count?: number }>) => (
  <div className="flex items-center justify-between px-1 pb-1.5 pt-1">
    <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-muted)]">{children}</p>
    {count !== undefined ? <span className="font-mono text-[9px] text-[var(--ec-faint)]">{String(count)}</span> : null}
  </div>
);

const Reactions = ({ reactions }: Readonly<{ reactions: ReadonlyArray<{ content: string; count: number }> }>) =>
  reactions.length > 0 ? (
    <div className="mt-2 flex flex-wrap gap-1">
      {reactions.map((reaction) => (
        <span key={reaction.content} className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-1.5 py-px text-[10px] text-[var(--ec-muted)]">
          {reaction.content} {String(reaction.count)}
        </span>
      ))}
    </div>
  ) : null;

type RenderImage = (image: ActivityRichTextImage) => ReactNode;

const TimelineEntry = ({
  item,
  providerName,
  body,
  renderImage,
}: Readonly<{ item: ProjectForgeIssueTimelineItem; providerName: string; body: string; renderImage: RenderImage | undefined }>) => {
  const author = item.author?.username ?? providerName;
  if (item.kind === "event") {
    return (
      <div className="group flex items-center gap-3 border-b border-[var(--ec-border)] py-2 last:border-b-0">
        <span className="ml-3 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ec-control)] transition-colors group-hover:bg-[var(--ec-accent-strong)]" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[10px] text-[var(--ec-muted)]" title={item.title}>
          <span className="font-medium text-[var(--ec-text)]">{author}</span> {item.title}
        </p>
        <span className="shrink-0 text-[9px] text-[var(--ec-faint)]" title={formatIssueDate(item.createdAt)}>{formatIssueAge(item.createdAt)}</span>
      </div>
    );
  }
  return (
    <article className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 border-b border-[var(--ec-border)] py-3 last:border-b-0">
      <div className="pt-0.5">
        <IssueAvatar user={item.author} name={author} />
      </div>
      <div className="min-w-0 rounded-lg bg-[var(--ec-panel)] px-3 py-2.5 ring-1 ring-inset ring-[var(--ec-border)]">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="truncate text-[11px] font-semibold text-[var(--ec-text)]">{author}</span>
          <span className="shrink-0 text-[9px] text-[var(--ec-faint)]">
            {formatIssueDate(item.createdAt)}
            {item.updatedAt && item.createdAt && item.updatedAt !== item.createdAt ? " · edited" : ""}
          </span>
        </div>
        {body.trim() ? (
          <ActivityRichText content={body} compact className="mt-2 break-words text-[var(--ec-text)]" renderImage={renderImage} />
        ) : (
          <p className="mt-2 text-[11px] text-[var(--ec-faint)]">Empty comment.</p>
        )}
        <Reactions reactions={item.reactions} />
      </div>
    </article>
  );
};

export const ProjectIssueDetail = ({
  issue,
  details,
  detailsBusy,
  detailsError,
  access,
  metadata,
  metadataBusy,
  work,
  modelOptions,
  assistModelId,
  capabilities,
  actionBusy,
  assistBusy,
  message,
  error,
  commentDraft,
  summary,
  triage,
  loadImage,
  onCommentDraftChange,
  onAssistModelChange,
  onDismissSummary,
  onDismissTriage,
  onRequestMetadata,
  onRefresh,
  onOpenExternal,
  onOpenSettings,
  onUpdate,
  onComment,
  onAssist,
  onAsk,
  onStartRun,
  onAddTask,
  onSelectRun,
  onOpenChat,
  onOpenTaskBoard,
  onSelectIssue,
  onOpenRequest,
}: ProjectIssueDetailProps) => {
  const [tab, setTab] = useState<DetailTab>("conversation");
  const [openMenu, setOpenMenu] = useState<"labels" | "assignees" | "milestone" | "close" | "assist" | null>(null);
  const [labelDraft, setLabelDraft] = useState<string[]>([]);
  const [assigneeDraft, setAssigneeDraft] = useState<string[]>([]);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyInstructions, setReplyInstructions] = useState("");
  const labelsRef = useRef<HTMLButtonElement>(null);
  const assigneesRef = useRef<HTMLButtonElement>(null);
  const milestoneRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const assistRef = useRef<HTMLButtonElement>(null);

  const current = details?.issue ?? issue;
  const providerName = current.provider === "gitlab" ? "GitLab" : "GitHub";
  const requestWord = current.provider === "gitlab" ? "merge request" : "pull request";
  const hasToken = access?.mode === "token";
  const writeHint = !capabilities.writes ? REMOTE_HINT : !hasToken || !access?.canWrite ? TOKEN_HINT : null;
  const triageHint = writeHint ?? (access?.canTriage ? null : TRIAGE_HINT);
  const canComment = writeHint === null && !current.locked;
  const canTriage = triageHint === null;
  const busy = actionBusy || detailsBusy;

  const imageProvider = details?.provider ?? null;
  const imageBaseUrl = details?.webBaseUrl ?? null;
  const issueNumber = current.number;
  const imageHost = useMemo<IssueImageHost | null>(
    () => (imageProvider && imageBaseUrl ? { provider: imageProvider, webBaseUrl: imageBaseUrl, load: (url) => loadImage(url, issueNumber) } : null),
    [imageBaseUrl, imageProvider, issueNumber, loadImage],
  );
  const renderImage = useMemo<RenderImage | undefined>(
    () => (imageHost ? (image) => <ProjectIssueImage {...image} host={imageHost} /> : undefined),
    [imageHost],
  );
  /** GitLab writes uploads as project-relative paths, which Markdown rendering would drop. */
  const hostedMarkdown = useCallback(
    (markdown: string) => (imageProvider && imageBaseUrl ? absolutizeForgeIssueUploads(markdown, imageProvider, imageBaseUrl) : markdown),
    [imageBaseUrl, imageProvider],
  );

  const timeline = details?.timeline ?? [];
  const commentCount = timeline.filter((item) => item.kind === "comment").length;
  const linkedRequests = details?.linkedRequests ?? [];
  const linkedCount = linkedRequests.length + work.runs.length + work.chats.length + work.tasks.length;
  const reportableRuns = work.runs.filter(({ run }) => run !== null && !isActiveRunStatus(run.status));

  const labelOptions = useMemo<IssuePickerOption[]>(() => {
    const known = new Map((metadata?.labels ?? []).map((label) => [label.name, label]));
    for (const label of current.labels) if (!known.has(label.name)) known.set(label.name, label);
    return [...known.values()].map((label) => ({ value: label.name, label: label.name, description: label.description, leading: <IssueLabelSwatch color={label.color} /> }));
  }, [current.labels, metadata?.labels]);

  const assigneeOptions = useMemo<IssuePickerOption[]>(() => {
    const known = new Map((metadata?.assignees ?? []).map((user) => [user.username, user]));
    for (const user of current.assignees) if (!known.has(user.username)) known.set(user.username, user);
    return [...known.values()].map((user) => ({ value: user.username, label: user.username, description: user.name, leading: <IssueAvatar user={user} size="sm" /> }));
  }, [current.assignees, metadata?.assignees]);

  const milestoneOptions = useMemo<IssuePickerOption[]>(() => {
    const known = new Map((metadata?.milestones ?? []).map((milestone) => [milestone.number, milestone]));
    if (current.milestone && !known.has(current.milestone.number)) known.set(current.milestone.number, current.milestone);
    return [
      { value: "", label: "No milestone" },
      ...[...known.values()].map((milestone) => ({
        value: String(milestone.number),
        label: milestone.title,
        description: milestone.dueOn ? `Due ${milestone.dueOn.slice(0, 10)}` : null,
      })),
    ];
  }, [current.milestone, metadata?.milestones]);

  const openPicker = (menu: "labels" | "assignees" | "milestone") => {
    if (!canTriage) return;
    onRequestMetadata();
    setLabelDraft(current.labels.map((label) => label.name));
    setAssigneeDraft(current.assignees.map((user) => user.username));
    setOpenMenu((value) => (value === menu ? null : menu));
  };

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((entry) => right.includes(entry));

  const applyLabels = async () => {
    setOpenMenu(null);
    await onUpdate({ labels: labelDraft });
  };
  const applyAssignees = async () => {
    setOpenMenu(null);
    await onUpdate({ assignees: assigneeDraft });
  };
  const closeIssue = async (closeReason: ProjectForgeIssueCloseReason) => {
    setOpenMenu(null);
    await onUpdate({ state: "closed", closeReason });
  };

  const submitComment = async () => {
    const body = commentDraft.trim();
    if (!body) return;
    if (await onComment(body)) onCommentDraftChange("");
  };

  const draftReply = async (options: { runId?: string }) => {
    const text = await onAssist({ kind: "reply", instructions: replyInstructions.trim() || undefined, runId: options.runId });
    if (!text) return;
    onCommentDraftChange(commentDraft.trim() ? `${commentDraft.trim()}\n\n${text}` : text);
    setReplyOpen(false);
    setReplyInstructions("");
    setTab("conversation");
  };

  const renderHeader = () => (
    <section className="shrink-0 overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)]">
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <IssueStateBadge issue={current} />
            <span className="font-mono text-[10px] text-[var(--ec-muted)]">{providerName} #{String(current.number)}</span>
            {current.issueType ? <span className="rounded border border-[var(--ec-border)] px-1 py-px text-[8px] font-semibold uppercase text-[var(--ec-muted)]">{current.issueType}</span> : null}
            {current.confidential ? <span className="text-[9px] font-semibold uppercase text-[var(--ec-warning)]">confidential</span> : null}
            {current.locked ? (
              <span className="inline-flex items-center gap-0.5 text-[9px] text-[var(--ec-faint)]" title="The conversation is locked on the Git host">
                <Lock className="h-2.5 w-2.5" aria-hidden /> locked
              </span>
            ) : null}
            {detailsBusy ? <Loader2 className="h-3 w-3 animate-spin text-[var(--ec-muted)]" aria-label="Loading issue" /> : null}
          </div>
          <p className="mt-1 truncate text-sm font-semibold leading-snug text-[var(--ec-text)]" title={current.title}>{current.title}</p>
          <div className="-ml-1 mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <button
              ref={labelsRef}
              type="button"
              className={metaButtonClass(canTriage)}
              onClick={() => openPicker("labels")}
              title={canTriage ? "Edit labels" : (triageHint ?? undefined)}
              aria-label="Labels"
              aria-haspopup={canTriage ? "listbox" : undefined}
            >
              <Tag className="h-3 w-3 shrink-0" aria-hidden />
              {current.labels.length > 0 ? (
                <span className="flex min-w-0 flex-wrap gap-1">
                  {current.labels.map((label) => (
                    <IssueLabelChip key={label.name} label={label} />
                  ))}
                </span>
              ) : (
                <span className="text-[var(--ec-faint)]">No labels</span>
              )}
            </button>
            <button
              ref={assigneesRef}
              type="button"
              className={metaButtonClass(canTriage)}
              onClick={() => openPicker("assignees")}
              title={canTriage ? "Edit assignees" : (triageHint ?? undefined)}
              aria-label="Assignees"
              aria-haspopup={canTriage ? "listbox" : undefined}
            >
              <UserRound className="h-3 w-3 shrink-0" aria-hidden />
              {current.assignees.length > 0 ? (
                <>
                  <IssueAvatarStack users={current.assignees} max={4} />
                  <span className="truncate">{current.assignees.map((user) => user.username).join(", ")}</span>
                </>
              ) : (
                <span className="text-[var(--ec-faint)]">Unassigned</span>
              )}
            </button>
            <button
              ref={milestoneRef}
              type="button"
              className={metaButtonClass(canTriage)}
              onClick={() => openPicker("milestone")}
              title={canTriage ? "Change milestone" : (triageHint ?? undefined)}
              aria-label="Milestone"
              aria-haspopup={canTriage ? "listbox" : undefined}
            >
              <Milestone className="h-3 w-3 shrink-0" aria-hidden />
              {current.milestone ? <span className="truncate">{current.milestone.title}</span> : <span className="text-[var(--ec-faint)]">No milestone</span>}
            </button>
            {current.weight !== null ? <span className="px-1 text-[10px] text-[var(--ec-muted)]">Weight {String(current.weight)}</span> : null}
            {current.epic ? <span className="truncate px-1 text-[10px] text-[var(--ec-muted)]" title={`Epic: ${current.epic}`}>Epic: {current.epic}</span> : null}
            {current.taskProgress ? (
              <span className="px-1 font-mono text-[10px] text-[var(--ec-muted)]" title="Sub-issues or checklist items done">
                {String(current.taskProgress.completed)}/{String(current.taskProgress.total)} done
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={() => onOpenExternal(current.url)} title="Open in browser" aria-label="Open in browser">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onRefresh} disabled={detailsBusy} title="Reload this issue" aria-label="Reload this issue">
            <RefreshCw className={cn("h-3.5 w-3.5", detailsBusy && "animate-spin")} aria-hidden />
          </Button>
          {capabilities.tasks ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={onAddTask} disabled={busy || !details} title="Add this issue to the Task Board">
              <ListPlus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Task
            </Button>
          ) : null}
          {capabilities.chats ? (
            <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-[10px]" onClick={onAsk} disabled={busy || !details} title="Ask a question about this issue in a chat">
              <MessagesSquare className="mr-1 h-3.5 w-3.5" aria-hidden />
              Ask
            </Button>
          ) : null}
          {capabilities.runs ? (
            <Button type="button" size="sm" className="h-7 px-2.5 text-[10px]" onClick={onStartRun} disabled={busy || !details} title="Start an agent run for this issue">
              <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
              Start run
            </Button>
          ) : null}
          <span className="flex items-center border-l border-[var(--ec-border)] pl-1.5">
            {current.state === "open" ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={cn("h-7 border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-2 text-[10px] text-[var(--ec-danger)] hover:bg-[var(--ec-danger-soft)]", current.provider === "github" && "rounded-r-none border-r-0")}
                  onClick={() => void closeIssue("completed")}
                  disabled={busy || !canTriage}
                  title={canTriage ? "Close this issue as completed" : (triageHint ?? undefined)}
                >
                  <CircleCheck className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Close
                </Button>
                {current.provider === "github" ? (
                  <Button
                    ref={closeRef}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-l-none border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-1 text-[var(--ec-danger)] hover:bg-[var(--ec-danger-soft)]"
                    onClick={() => setOpenMenu((value) => (value === "close" ? null : "close"))}
                    disabled={busy || !canTriage}
                    aria-label="More ways to close"
                    aria-haspopup="menu"
                  >
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-[10px]"
                onClick={() => void onUpdate({ state: "open" })}
                disabled={busy || !canTriage}
                title={canTriage ? "Reopen this issue" : (triageHint ?? undefined)}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden />
                Reopen
              </Button>
            )}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-[var(--ec-border)] px-2 py-1">
        <div className="flex min-w-0 flex-wrap items-center gap-0.5" role="tablist" aria-label="Issue sections">
          <button type="button" role="tab" aria-selected={tab === "conversation"} className={tabClass(tab === "conversation")} onClick={() => setTab("conversation")}>
            Conversation
            <span className="font-mono text-[9px] text-[var(--ec-muted)]">{String(details ? commentCount : current.commentCount)}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "linked"} className={tabClass(tab === "linked")} onClick={() => setTab("linked")}>
            {work.activeRun ? <Loader2 className="h-3 w-3 animate-spin text-[var(--ec-accent)]" aria-hidden /> : null}
            Linked work
            {linkedCount > 0 ? <span className="font-mono text-[9px] text-[var(--ec-muted)]">{String(linkedCount)}</span> : null}
          </button>
        </div>
        <Button
          ref={assistRef}
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[10px] text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
          onClick={() => setOpenMenu((value) => (value === "assist" ? null : "assist"))}
          disabled={!details}
          aria-haspopup="menu"
        >
          {assistBusy === "summary" || assistBusy === "triage" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />}
          AI assist
          <ChevronDown className="ml-0.5 h-3 w-3" aria-hidden />
        </Button>
      </div>
      {message ? <p className="border-t border-[var(--ec-border)] px-3 py-1 text-[9px] text-[var(--ec-success)]">{message}</p> : null}
      {error ? <p className="border-t border-[var(--ec-border)] px-3 py-1 text-[9px] text-[var(--ec-danger)]">{error}</p> : null}

      <IssuePickerPopover
        open={openMenu === "labels"}
        anchorRef={labelsRef}
        onClose={() => setOpenMenu(null)}
        title="Labels"
        options={labelOptions}
        selected={labelDraft}
        onToggle={(value) => setLabelDraft((draft) => toggle(draft, value))}
        busy={metadataBusy}
        emptyMessage="This repository has no labels."
        footer={
          <Button type="button" size="xs" className="h-7 w-full text-[10px]" onClick={() => void applyLabels()} disabled={sameSet(labelDraft, current.labels.map((label) => label.name))}>
            Apply labels
          </Button>
        }
      />
      <IssuePickerPopover
        open={openMenu === "assignees"}
        anchorRef={assigneesRef}
        onClose={() => setOpenMenu(null)}
        title="Assignees"
        options={assigneeOptions}
        selected={assigneeDraft}
        onToggle={(value) => setAssigneeDraft((draft) => toggle(draft, value))}
        busy={metadataBusy}
        emptyMessage="No assignable users were found."
        footer={
          <div className="flex gap-1.5">
            {access?.viewer && !assigneeDraft.includes(access.viewer) ? (
              <Button type="button" size="xs" variant="secondary" className="h-7 flex-1 text-[10px]" onClick={() => setAssigneeDraft((draft) => [...draft, access.viewer ?? ""].filter(Boolean))}>
                Assign me
              </Button>
            ) : null}
            <Button type="button" size="xs" className="h-7 flex-1 text-[10px]" onClick={() => void applyAssignees()} disabled={sameSet(assigneeDraft, current.assignees.map((user) => user.username))}>
              Apply
            </Button>
          </div>
        }
      />
      <IssuePickerPopover
        open={openMenu === "milestone"}
        anchorRef={milestoneRef}
        onClose={() => setOpenMenu(null)}
        title="Milestone"
        options={milestoneOptions}
        selected={[current.milestone ? String(current.milestone.number) : ""]}
        multiple={false}
        busy={metadataBusy}
        onToggle={(value) => void onUpdate({ milestone: value ? Number.parseInt(value, 10) : null })}
      />
      <AnchorDropdownPortal open={openMenu === "close"} anchorRef={closeRef} onClose={() => setOpenMenu(null)} align="end" widthPx={208} className="glass-popover overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] p-1 shadow-2xl shadow-black/45">
        <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" onClick={() => void closeIssue("completed")}>
          <CircleCheck className="h-3.5 w-3.5 text-[var(--ec-accent)]" aria-hidden /> Close as completed
        </button>
        <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" onClick={() => void closeIssue("not_planned")}>
          <CircleSlash className="h-3.5 w-3.5 text-[var(--ec-muted)]" aria-hidden /> Close as not planned
        </button>
      </AnchorDropdownPortal>
      <AnchorDropdownPortal open={openMenu === "assist"} anchorRef={assistRef} onClose={() => setOpenMenu(null)} align="end" widthPx={288} className="glass-popover overflow-hidden rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] shadow-2xl shadow-black/45">
        <div className="space-y-1 border-b border-[var(--ec-border)] p-2">
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-muted)]">Model</p>
          <div className="app-scrollbar max-h-36 space-y-0.5 overflow-y-auto" role="listbox" aria-label="Model for AI assistance">
            {modelOptions.map((option) => {
              const selected = option.id === assistModelId;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors",
                    selected ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]" : "text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]",
                  )}
                  onClick={() => onAssistModelChange(option.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        </div>
        <div className="p-1">
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--ec-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!assistModelId || assistBusy !== null}
            onClick={() => {
              setOpenMenu(null);
              setTab("conversation");
              void onAssist({ kind: "summary" });
            }}
          >
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />
            <span>
              <span className="block text-[11px] font-medium text-[var(--ec-text)]">Summarize thread</span>
              <span className="block text-[9px] leading-snug text-[var(--ec-muted)]">Problem, status, open questions, and next step.</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--ec-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!assistModelId || assistBusy !== null}
            onClick={() => {
              setOpenMenu(null);
              setTab("conversation");
              void onAssist({ kind: "triage" });
            }}
          >
            <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ec-accent)]" aria-hidden />
            <span>
              <span className="block text-[11px] font-medium text-[var(--ec-text)]">Triage</span>
              <span className="block text-[9px] leading-snug text-[var(--ec-muted)]">Suggests labels, possible duplicates, and the files likely involved.</span>
            </span>
          </button>
        </div>
        {modelOptions.length === 0 ? <p className="border-t border-[var(--ec-border)] px-2.5 py-1.5 text-[9px] text-[var(--ec-warning)]">Add a model in Settings to use AI assistance.</p> : null}
      </AnchorDropdownPortal>
    </section>
  );

  const renderSummary = () =>
    summary || assistBusy === "summary" ? (
      <div className="mb-3 rounded-lg border border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-accent)]">
            <Sparkles className="h-3 w-3" aria-hidden /> AI summary
          </p>
          {summary ? (
            <button type="button" className="rounded p-0.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onDismissSummary} aria-label="Dismiss summary">
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </div>
        {summary ? (
          <ActivityRichText content={summary} compact className="mt-1.5 break-words text-[var(--ec-text)]" />
        ) : (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Reading the thread…</p>
        )}
      </div>
    ) : null;

  const renderTriage = () => {
    if (!triage && assistBusy !== "triage") return null;
    const empty = triage && triage.suggestedLabels.length === 0 && triage.duplicates.length === 0 && triage.likelyFiles.length === 0 && !triage.notes && !triage.effort;
    return (
      <div className="mb-3 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-accent)]">
            <Tag className="h-3 w-3" aria-hidden /> AI triage
            {triage?.effort ? <span className="rounded border border-[var(--ec-border)] px-1 py-px text-[8px] text-[var(--ec-muted)]">{triage.effort} effort</span> : null}
          </p>
          {triage ? (
            <button type="button" className="rounded p-0.5 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" onClick={onDismissTriage} aria-label="Dismiss triage">
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </div>
        {!triage ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Comparing with labels, open issues, and project files…</p>
        ) : empty ? (
          <p className="mt-1.5 text-[11px] text-[var(--ec-muted)]">No suggestions for this issue.</p>
        ) : (
          <div className="mt-2 grid gap-2.5 text-[11px] lg:grid-cols-3">
            <div className="min-w-0">
              <p className="mb-1 text-[9px] font-medium text-[var(--ec-muted)]">Suggested labels</p>
              {triage.suggestedLabels.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  {triage.suggestedLabels.map((name) => (
                    <IssueLabelChip key={name} label={metadata?.labels.find((label) => label.name === name) ?? { name, color: null, description: null }} />
                  ))}
                  <Button
                    type="button"
                    size="xs"
                    variant="secondary"
                    className="h-5 px-1.5 text-[9px]"
                    disabled={busy || !canTriage}
                    title={canTriage ? "Add the suggested labels to the issue" : (triageHint ?? undefined)}
                    onClick={() => void onUpdate({ labels: [...new Set([...current.labels.map((label) => label.name), ...triage.suggestedLabels])] })}
                  >
                    Add
                  </Button>
                </div>
              ) : (
                <p className="text-[var(--ec-faint)]">None</p>
              )}
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-[9px] font-medium text-[var(--ec-muted)]">Possible duplicates</p>
              {triage.duplicates.length > 0 ? (
                <ul className="space-y-1">
                  {triage.duplicates.map((duplicate) => (
                    <li key={duplicate.number} className="min-w-0">
                      <button type="button" className="block max-w-full truncate text-left text-[var(--ec-accent)] hover:underline" onClick={() => onSelectIssue(duplicate.number)} title={duplicate.title}>
                        #{String(duplicate.number)} {duplicate.title}
                      </button>
                      {duplicate.reason ? <p className="text-[10px] leading-snug text-[var(--ec-muted)]">{duplicate.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[var(--ec-faint)]">None found</p>
              )}
            </div>
            <div className="min-w-0">
              <p className="mb-1 text-[9px] font-medium text-[var(--ec-muted)]">Likely files</p>
              {triage.likelyFiles.length > 0 ? (
                <ul className="space-y-1">
                  {triage.likelyFiles.map((file) => (
                    <li key={file.path} className="min-w-0">
                      <p className="truncate font-mono text-[10px] text-[var(--ec-text)]" title={file.path}>{file.path}</p>
                      {file.reason ? <p className="text-[10px] leading-snug text-[var(--ec-muted)]">{file.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[var(--ec-faint)]">None identified</p>
              )}
            </div>
            {triage.notes ? <p className="text-[10px] leading-snug text-[var(--ec-muted)] lg:col-span-3">{triage.notes}</p> : null}
          </div>
        )}
      </div>
    );
  };

  const renderComposer = () => (
    <div className="shrink-0 border-t border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2">
      {canComment ? (
        <>
          {replyOpen ? (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Input
                value={replyInstructions}
                onChange={(event) => setReplyInstructions(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void draftReply({});
                  }
                }}
                placeholder="What should the comment say? Leave empty to answer the latest question."
                aria-label="Instructions for the comment draft"
                className="h-7 min-w-[12rem] flex-1 text-[11px]"
                autoFocus
              />
              <Button type="button" size="xs" variant="secondary" className="h-7 px-2 text-[10px]" onClick={() => void draftReply({})} disabled={!assistModelId || assistBusy !== null}>
                {assistBusy === "reply" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3 w-3" aria-hidden />}
                Draft
              </Button>
              {reportableRuns.map(({ run }) =>
                run ? (
                  <Button
                    key={run.id}
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="h-7 max-w-[14rem] px-2 text-[10px]"
                    onClick={() => void draftReply({ runId: run.id })}
                    disabled={!assistModelId || assistBusy !== null}
                    title="Draft a comment that reports what this run did"
                  >
                    <Bot className="mr-1 h-3 w-3 shrink-0" aria-hidden />
                    <span className="truncate">Report run: {run.title?.trim() || run.branchName}</span>
                  </Button>
                ) : null,
              )}
              <Button type="button" size="xs" variant="ghost" className="h-7 px-1.5 text-[10px]" onClick={() => setReplyOpen(false)}>
                Cancel
              </Button>
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
            <Textarea
              value={commentDraft}
              onChange={(event) => onCommentDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitComment();
                }
              }}
              placeholder={`Comment on #${String(current.number)} (Markdown)`}
              aria-label="Comment"
              className="min-h-[2.25rem] flex-1 resize-y px-2.5 py-1.5 text-[12px] leading-snug"
              rows={commentDraft.includes("\n") || commentDraft.length > 120 ? 5 : 1}
              disabled={actionBusy}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 px-2 text-[10px] text-[var(--ec-muted)] hover:text-[var(--ec-text)]"
              onClick={() => setReplyOpen((value) => !value)}
              disabled={!assistModelId}
              title={assistModelId ? "Let AI draft the comment. Nothing is posted until you press Comment." : "Choose a model under AI assist first"}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />
              Draft
            </Button>
            <Button type="button" size="sm" className="h-8 shrink-0 px-2.5 text-[11px]" onClick={() => void submitComment()} disabled={actionBusy || !commentDraft.trim()} title="Post the comment (Ctrl+Enter)">
              {actionBusy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Comment
            </Button>
          </div>
        </>
      ) : (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--ec-muted)]">
          {current.locked && writeHint === null ? "The conversation is locked on the Git host." : `Commenting is off: ${(writeHint ?? "").toLowerCase()}.`}
          {writeHint === TOKEN_HINT ? (
            <button type="button" className="font-medium text-[var(--ec-accent)] hover:underline" onClick={onOpenSettings}>
              Add a token in Project Settings
            </button>
          ) : null}
        </p>
      )}
    </div>
  );

  const renderConversation = () => (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-[var(--ec-panel)] ring-1 ring-inset ring-[var(--ec-border)]">
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-5 pb-4 pt-4 lg:px-8">
          {renderSummary()}
          {renderTriage()}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <IssueAvatar user={current.authorUser} name={current.author ?? "?"} />
              <div className="min-w-0">
                <p className="truncate text-[11px] text-[var(--ec-muted)]">
                  <span className="font-semibold text-[var(--ec-text)]">{current.author ?? "Unknown author"}</span> opened this issue
                </p>
                <p className="mt-0.5 text-[9px] text-[var(--ec-faint)]">{formatIssueDate(current.createdAt)}</p>
              </div>
            </div>
            <span className="font-mono text-[9px] text-[var(--ec-faint)]">updated {formatIssueAge(current.updatedAt)} ago</span>
          </div>
          <div className="mt-3 max-w-4xl break-words text-[13px] leading-[1.65] text-[var(--ec-text)]">
            {details ? (
              details.issue.body.trim() ? <ActivityRichText content={hostedMarkdown(details.issue.body)} compact renderImage={renderImage} /> : <p className="text-[var(--ec-faint)]">No description provided.</p>
            ) : detailsError ? null : (
              <p className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ec-muted)]"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading issue…</p>
            )}
          </div>
          <Reactions reactions={current.reactions} />
          {details && details.subIssues.length > 0 ? (
            <div className="mt-3 rounded-lg border border-[var(--ec-border)] p-2">
              <SectionTitle count={details.subIssues.length}>Sub-issues</SectionTitle>
              <ul>
                {details.subIssues.map((sub) => (
                  <li key={sub.number}>
                    <button type="button" className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] text-[var(--ec-text)] hover:bg-[var(--ec-hover)]" onClick={() => onSelectIssue(sub.number)}>
                      <IssueStateIcon issue={{ state: sub.state, stateReason: null }} className="h-3 w-3 shrink-0" />
                      <span className="font-mono text-[9px] text-[var(--ec-muted)]">#{String(sub.number)}</span>
                      <span className="truncate">{sub.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {detailsError ? <p className="mt-2 text-[10px] text-[var(--ec-danger)]">{detailsError}</p> : null}
          {details?.warnings.map((warning) => (
            <p key={warning} className="mt-2 text-[10px] text-[var(--ec-warning)]">{warning}</p>
          ))}
        </div>
        <div className="border-y border-[var(--ec-border)] bg-[var(--ec-panel)]">
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-2 lg:px-8">
            <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-muted)]">Conversation</p>
            <span className="font-mono text-[9px] text-[var(--ec-faint)]">{String(commentCount)} comment{commentCount === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div className="mx-auto w-full max-w-5xl px-5 pb-6 lg:px-8">
          {timeline.length > 0 ? (
            timeline.map((item) => <TimelineEntry key={item.itemKey} item={item} providerName={providerName} body={hostedMarkdown(item.body ?? "")} renderImage={renderImage} />)
          ) : (
            <p className="py-6 text-center text-xs text-[var(--ec-faint)]">{detailsBusy ? "Loading conversation…" : "No comments yet."}</p>
          )}
        </div>
      </div>
      {renderComposer()}
    </section>
  );

  const renderLinked = () => (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-[var(--ec-panel)] ring-1 ring-inset ring-[var(--ec-border)]">
      <div className="app-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {linkedCount === 0 ? (
          <div className="mx-auto max-w-md py-8 text-center">
            <p className="text-sm font-semibold text-[var(--ec-text)]">No work linked yet</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--ec-muted)]">
              Runs, chats, and tasks you start from this issue appear here, together with the {requestWord}s that mention or close it.
            </p>
          </div>
        ) : null}
        {linkedRequests.length > 0 ? (
          <div>
            <SectionTitle count={linkedRequests.length}>{current.provider === "gitlab" ? "Merge requests" : "Pull requests"}</SectionTitle>
            <div className="space-y-1.5">
              {linkedRequests.map((request) => (
                <div key={request.number} className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2">
                  <GitPullRequest className={cn("h-3.5 w-3.5 shrink-0", request.state === "closed" ? "text-[var(--ec-danger)]" : "text-[var(--ec-accent)]")} aria-hidden />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenRequest(request.url)} title={`Open #${String(request.number)} under PRs`}>
                    <span className="block truncate text-xs font-semibold text-[var(--ec-text)]">
                      <span className="font-mono text-[10px] font-normal text-[var(--ec-muted)]">#{String(request.number)}</span> {request.title}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-[var(--ec-muted)]">
                      <span>{request.state}{request.draft ? " · draft" : ""}</span>
                      <span className={request.relation === "closes" ? "text-[var(--ec-success)]" : undefined}>{request.relation === "closes" ? "closes this issue" : "mentions this issue"}</span>
                    </span>
                  </button>
                  <button type="button" className="shrink-0 rounded p-1 text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]" title="Open in browser" aria-label={`Open #${String(request.number)} in browser`} onClick={() => onOpenExternal(request.url)}>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {work.runs.length > 0 ? (
          <div>
            <SectionTitle count={work.runs.length}>Agent runs</SectionTitle>
            <div className="space-y-1.5">
              {work.runs.map(({ link, run }) =>
                run ? (
                  <div key={run.id} className="flex min-w-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2">
                    <Badge tone={run.status} dot className="shrink-0 px-1.5 py-px text-[9px]">{RUN_DISPLAY_STATUS_LABELS[run.status]}</Badge>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelectRun(run.id)} title="Open this run">
                      <span className="block truncate text-xs font-semibold text-[var(--ec-text)]">{run.title?.trim() || run.prompt.split("\n", 1)[0]}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-[var(--ec-muted)]">
                        <span className="truncate font-mono">{run.branchName}</span>
                        <span>{run.mode === "plan" ? "investigation" : run.mode}</span>
                        <span>{formatIssueAge(run.createdAt)} ago</span>
                        {run.forgeRequest ? <span className="text-[var(--ec-accent)]">{current.provider === "gitlab" ? "MR" : "PR"} #{String(run.forgeRequest.number)} · {run.forgeRequest.state}</span> : null}
                      </span>
                    </button>
                    {canComment && !isActiveRunStatus(run.status) ? (
                      <Button type="button" size="xs" variant="ghost" className="h-6 shrink-0 px-1.5 text-[10px]" disabled={!assistModelId || assistBusy !== null} onClick={() => void draftReply({ runId: run.id })} title="Draft an issue comment that reports what this run did">
                        {assistBusy === "reply" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden /> : <Sparkles className="mr-1 h-3 w-3" aria-hidden />}
                        Report
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  <p key={`${link.runId ?? ""}${link.createdAt}`} className="rounded-md border border-dashed border-[var(--ec-border)] p-2 text-[10px] text-[var(--ec-faint)]">A run from {formatIssueDate(link.createdAt)} is not in this list (it may be hidden or still loading).</p>
                ),
              )}
            </div>
          </div>
        ) : null}
        {work.chats.length > 0 ? (
          <div>
            <SectionTitle count={work.chats.length}>Chats</SectionTitle>
            <div className="space-y-1.5">
              {work.chats.map(({ link, chat }) => (
                <button key={link.chatId ?? link.createdAt} type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-left transition hover:bg-[var(--ec-hover)]" onClick={() => link.chatId && onOpenChat(link.chatId)}>
                  <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-[var(--ec-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-[var(--ec-text)]">{chat?.title?.trim() || chat?.prompt.split("\n", 1)[0] || "Chat"}</span>
                    <span className="block text-[10px] text-[var(--ec-muted)]">{formatIssueDate(link.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {work.tasks.length > 0 ? (
          <div>
            <SectionTitle count={work.tasks.length}>Task Board</SectionTitle>
            <div className="space-y-1.5">
              {work.tasks.map(({ link, task }) => (
                <button key={link.taskId ?? link.createdAt} type="button" className="flex w-full min-w-0 items-center gap-2 rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel)] p-2 text-left transition hover:bg-[var(--ec-hover)]" onClick={onOpenTaskBoard}>
                  <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--ec-muted)]" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ec-text)]">{task?.title ?? link.issueTitle}</span>
                  {task ? <span className="shrink-0 text-[10px] text-[var(--ec-muted)]">{task.status.replace(/_/g, " ")}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      {renderHeader()}
      {tab === "conversation" ? renderConversation() : renderLinked()}
    </div>
  );
};
