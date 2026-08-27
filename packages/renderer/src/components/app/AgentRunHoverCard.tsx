import type { ProviderType, RunForgeReadiness, RunRecord } from "@buildwarden/shared";
import { Bot, CircleAlert, Clock3, FolderGit2, GitBranch, GitPullRequest, ListChecks } from "lucide-react";
import { Badge, type BadgeProps } from "../ui/badge";
import { ProviderBrandIcon } from "./provider-brand-icons";
import { PROVIDER_BRAND_LABELS } from "./provider-brand-metadata";
import { runForgeReadinessColor, runForgeReadinessLabel } from "./run-forge-ui";
import { formatRunDuration, formatRunRelativeTime } from "./run-summary-format";
import {
  resolveRunDisplayStatus,
  RUN_DISPLAY_STATUS_LABELS,
  runDisplayStatusTone,
} from "./run-display-status";

const FORGE_READINESS_BADGE_TONE: Record<RunForgeReadiness, NonNullable<BadgeProps["tone"]>> = {
  ready: "completed",
  pending: "queued",
  blocked: "failed",
  merged: "running",
  closed: "cancelled",
  unavailable: "neutral",
};

export const AgentRunHoverCard = ({ projectName, run, providerType }: { projectName: string; run: RunRecord; providerType?: ProviderType | null }) => {
  const displayStatus = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  const waitingForInput = run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1;
  const providerLabel = PROVIDER_BRAND_LABELS[providerType === "openrouter" ? "openrouter" : run.harnessType];

  return (
    <article data-agent-run-hover-card className="p-3.5 text-[var(--ec-text)]">
      <header className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--ec-faint)]">
          <Bot className="size-3.5 text-[var(--ec-accent)]" aria-hidden />
          {run.kind === "orchestration-task" ? "Subagent run" : "Agent run"}
        </span>
        <Badge tone={runDisplayStatusTone(displayStatus)} dot className="px-2 py-0.5 text-[10px] leading-4">
          {RUN_DISPLAY_STATUS_LABELS[displayStatus]}
        </Badge>
      </header>

      <p className="mt-2.5 line-clamp-6 whitespace-pre-wrap break-words text-sm font-semibold leading-5">
        {run.prompt || "Untitled agent run"}
      </p>

      <div className="mt-3 grid gap-1.5 border-t border-[var(--ec-border)] pt-2.5 text-[11px] text-[var(--ec-muted)]">
        <span className="flex min-w-0 items-center gap-2">
          <FolderGit2 className="size-3.5 shrink-0 text-[var(--ec-faint)]" aria-hidden />
          <span className="truncate font-medium text-[var(--ec-text)]" title={projectName}>{projectName}</span>
        </span>
        {run.branchName ? (
          <span className="flex min-w-0 items-center gap-2">
            <GitBranch className="size-3.5 shrink-0 text-[var(--ec-faint)]" aria-hidden />
            <span className="truncate font-mono" title={run.branchName}>{run.branchName}</span>
          </span>
        ) : null}
      </div>

      {run.forgeRequest ? (
        <section
          data-agent-run-forge-request
          className="mt-2.5 border-t border-[var(--ec-border)] pt-2.5"
          aria-label={`${run.forgeRequest.provider === "github" ? "Pull request" : "Merge request"} #${String(run.forgeRequest.number)}`}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-[var(--ec-text)]">
              <GitPullRequest
                className={`size-3.5 shrink-0 ${runForgeReadinessColor[run.forgeRequest.readiness]}`}
                aria-hidden
              />
              <span className="truncate">
                {run.forgeRequest.provider === "github" ? "Pull request" : "Merge request"} #{run.forgeRequest.number}
              </span>
              {run.forgeRequest.draft ? (
                <span className="shrink-0 rounded-full border border-[var(--ec-border)] bg-[var(--ec-muted-soft)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--ec-muted)]">
                  Draft
                </span>
              ) : null}
            </span>
            <Badge
              tone={FORGE_READINESS_BADGE_TONE[run.forgeRequest.readiness]}
              className="shrink-0 px-2 py-0.5 text-[9px] leading-4"
            >
              {runForgeReadinessLabel[run.forgeRequest.readiness]}
            </Badge>
          </div>
          <p className="mt-1.5 line-clamp-2 break-words text-[11px] font-medium leading-4 text-[var(--ec-muted)]">
            {run.forgeRequest.title}
          </p>
          {run.forgeRequest.checks.total > 0 ? (
            <span className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[var(--ec-muted)]">
              <ListChecks className="size-3.5 text-[var(--ec-faint)]" aria-hidden />
              <span>
                <span className="font-mono font-semibold text-[var(--ec-text)]">
                  {run.forgeRequest.checks.completed} of {run.forgeRequest.checks.total}
                </span>{" "}
                checks
              </span>
            </span>
          ) : null}
        </section>
      ) : null}

      <footer className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-[var(--ec-border)] pt-2.5 text-[10px] text-[var(--ec-muted)]">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderBrandIcon harnessType={run.harnessType} providerType={providerType} className="size-3.5 shrink-0" />
          <span className="truncate">{providerLabel}</span>
        </span>
        <span className="size-1 shrink-0 rounded-full bg-[var(--ec-faint)]" aria-hidden />
        <span className="flex shrink-0 items-center gap-1">
          <Clock3 className="size-3" aria-hidden />
          {formatRunRelativeTime(run.finishedAt ?? run.updatedAt)}
        </span>
        <span className="size-1 shrink-0 rounded-full bg-[var(--ec-faint)]" aria-hidden />
        <span className="shrink-0">{formatRunDuration(run)}</span>
        {waitingForInput ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-medium text-[var(--ec-warning)]">
            <CircleAlert className="size-3" aria-hidden />
            Input needed
          </span>
        ) : null}
      </footer>
    </article>
  );
};
