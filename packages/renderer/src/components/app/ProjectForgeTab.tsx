import { parseForgeIssueUrl, type ProjectForgeProvider } from "@buildwarden/shared";
import { CircleDot, GitPullRequest } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { ProjectIssuesTab, type ProjectIssuesTabProps } from "./ProjectIssuesTab";
import { ProjectPrMrTab, type ProjectPrMrTabProps } from "./ProjectPrMrTab";
import { readStoredForgeSegment, writeStoredForgeSegment, type ForgeSegment } from "./project-issues-model";

export interface ProjectForgeTabProps
  extends Omit<ProjectPrMrTabProps, "headerLead" | "onRequestCountChange" | "onProviderChange" | "onOpenIssue">,
    Omit<ProjectIssuesTabProps, "headerLead" | "initialIssue" | "onIssueCountChange" | "onProviderChange" | "onOpenRequest" | "modelOptions"> {}

type OpenTarget = { url: string; requestId: number };

/**
 * Open requests (from a notification or a back-link) that were already followed. The app keeps the
 * last one around, and without this the page would jump back to it every time it is reopened.
 */
const followedTargets = new Set<number>();

type ForgeViewOption = { value: ForgeSegment; label: string; icon: typeof GitPullRequest; count: string | null };

/** The two views of the page as tabs, each with its icon and the number of loaded entries. */
const ForgeViewSwitch = ({ value, options, onChange }: Readonly<{ value: ForgeSegment; options: readonly ForgeViewOption[]; onChange: (value: ForgeSegment) => void }>) => (
  <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-0.5" role="tablist" aria-label="Pull requests or issues">
    {options.map((option) => {
      const Icon = option.icon;
      const selected = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={selected}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ec-ring)]",
            selected
              ? "bg-[var(--ec-accent-soft)] font-medium text-[color:var(--ec-text)] shadow-[inset_0_0_0_1px_var(--ec-accent-ring)]"
              : "text-[color:var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[color:var(--ec-text)]",
          )}
          onClick={() => onChange(option.value)}
        >
          <Icon className={cn("h-3.5 w-3.5 shrink-0", selected && "text-[var(--ec-accent)]")} aria-hidden />
          {option.label}
          {option.count !== null ? (
            <span
              className={cn(
                "min-w-[1.125rem] rounded-full px-1 text-center font-mono text-[10px] leading-4",
                selected ? "bg-[var(--ec-accent)] text-[var(--ec-accent-foreground)]" : "bg-[var(--ec-control)] text-[var(--ec-muted)]",
              )}
            >
              {option.count}
            </span>
          ) : null}
        </button>
      );
    })}
  </div>
);

/**
 * Pull/merge requests and issues of a project's Git host behind one sidebar entry.
 * Both views keep their state while the user switches between them; issues load on first use.
 */
export const ProjectForgeTab = ({ initialRequest = null, ...props }: ProjectForgeTabProps) => {
  const { projectId } = props;
  const [target, setTarget] = useState<OpenTarget | null>(() => (initialRequest && !followedTargets.has(initialRequest.requestId) ? initialRequest : null));
  const targetIssueNumber = target ? (parseForgeIssueUrl(target.url)?.number ?? null) : null;
  const [segment, setSegment] = useState<ForgeSegment>(() => (target ? (targetIssueNumber !== null ? "issues" : "requests") : readStoredForgeSegment(projectId)));
  const [issuesMounted, setIssuesMounted] = useState(segment === "issues");
  const [requestCount, setRequestCount] = useState<number | null>(null);
  const [issueCount, setIssueCount] = useState<{ count: number; more: boolean } | null>(null);
  /** Decides whether the first tab reads "Pull requests" or "Merge requests"; known once either view has loaded. */
  const [provider, setProvider] = useState<ProjectForgeProvider | null>(null);

  const changeSegment = useCallback(
    (next: ForgeSegment) => {
      setSegment(next);
      if (next === "issues") setIssuesMounted(true);
      writeStoredForgeSegment(projectId, next);
    },
    [projectId],
  );

  const follow = useCallback(
    (next: OpenTarget) => {
      followedTargets.add(next.requestId);
      setTarget(next);
      changeSegment(parseForgeIssueUrl(next.url) ? "issues" : "requests");
    },
    [changeSegment],
  );

  const incomingRequestId = initialRequest?.requestId;
  const incomingUrl = initialRequest?.url;
  useEffect(() => {
    if (incomingRequestId === undefined || incomingUrl === undefined || followedTargets.has(incomingRequestId)) return;
    follow({ url: incomingUrl, requestId: incomingRequestId });
  }, [follow, incomingRequestId, incomingUrl]);

  const requestTarget = target && targetIssueNumber === null ? target : null;
  const issueTarget = useMemo(
    () => (target && targetIssueNumber !== null ? { number: targetIssueNumber, requestId: target.requestId } : null),
    [target, targetIssueNumber],
  );
  /** Issues opened from a request's "Closes #N" chip carry no URL; they are tracked separately. */
  const [issueFromRequest, setIssueFromRequest] = useState<{ number: number; requestId: number } | null>(null);
  const initialIssue = issueFromRequest && (!issueTarget || issueFromRequest.requestId > issueTarget.requestId) ? issueFromRequest : issueTarget;

  const openRequest = useCallback((url: string) => follow({ url, requestId: Date.now() }), [follow]);
  const openIssue = useCallback(
    (issueNumber: number) => {
      setIssueFromRequest({ number: issueNumber, requestId: Date.now() });
      changeSegment("issues");
    },
    [changeSegment],
  );

  const reportProvider = useCallback((next: ProjectForgeProvider | null) => {
    if (next) setProvider(next);
  }, []);

  const switcher = (
    <ForgeViewSwitch
      value={segment}
      onChange={changeSegment}
      options={[
        { value: "requests", label: provider === "gitlab" ? "Merge requests" : "Pull requests", icon: GitPullRequest, count: requestCount !== null ? String(requestCount) : null },
        { value: "issues", label: "Issues", icon: CircleDot, count: issueCount ? `${String(issueCount.count)}${issueCount.more ? "+" : ""}` : null },
      ]}
    />
  );

  return (
    <>
      <div className={cn("min-h-0 flex-1 flex-col", segment === "requests" ? "flex" : "hidden")}>
        <ProjectPrMrTab
          projectId={projectId}
          modelOptions={props.modelOptions}
          defaultModelId={props.defaultModelId}
          initialRequest={requestTarget}
          onOpenProjectSettings={props.onOpenProjectSettings}
          headerLead={switcher}
          onRequestCountChange={setRequestCount}
          onProviderChange={reportProvider}
          onOpenIssue={openIssue}
        />
      </div>
      {issuesMounted ? (
        <div className={cn("min-h-0 flex-1 flex-col", segment === "issues" ? "flex" : "hidden")}>
          <ProjectIssuesTab
            key={projectId}
            projectId={projectId}
            baseBranch={props.baseBranch}
            runs={props.runs}
            tasks={props.tasks}
            chats={props.chats}
            modelOptions={props.modelOptions}
            defaultModelId={props.defaultModelId}
            preferences={props.preferences}
            headerLead={switcher}
            initialIssue={initialIssue}
            onIssueCountChange={setIssueCount}
            onProviderChange={reportProvider}
            onSavePreferences={props.onSavePreferences}
            onStartIssueRuns={props.onStartIssueRuns}
            onAskIssue={props.onAskIssue}
            onWorkChanged={props.onWorkChanged}
            onOpenProjectSettings={props.onOpenProjectSettings}
            onSelectRun={props.onSelectRun}
            onOpenChat={props.onOpenChat}
            onOpenTaskBoard={props.onOpenTaskBoard}
            onOpenRequest={openRequest}
          />
        </div>
      ) : null}
    </>
  );
};
