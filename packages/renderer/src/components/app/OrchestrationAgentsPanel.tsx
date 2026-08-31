import {
  type OrchestrationAdoptionPreview,
  type OrchestrationDetail,
  type OrchestrationTaskRecord,
  type RunDetail,
} from "@buildwarden/shared";
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  ExternalLink,
  GitCompareArrows,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Undo2,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { ActivityRichText } from "../ui/activity-rich-text";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

interface OrchestrationAgentsPanelProps {
  coordinatorRunId: string;
  initialDetail?: OrchestrationDetail | null;
  modelLabels: ReadonlyMap<string, string>;
  onOpenChildRun: (runId: string) => void;
  onReviewChildRun: (runId: string) => void;
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const LIVE_REFRESH_DELAY_MS = 250;
const formatCount = new Intl.NumberFormat("en-US");

const taskTone = (status: OrchestrationTaskRecord["status"]): "queued" | "preparing" | "running" | "completed" | "failed" | "cancelled" => {
  if (status === "pending" || status === "queued") return "queued";
  if (status === "provisioning") return "preparing";
  if (status === "running" || status === "waiting-input") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
};

const formatElapsed = (task: OrchestrationTaskRecord) => {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const safeMetadata = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const AgentDetailSection = ({ title, countLabel, icon, children }: { title: string; countLabel?: string; icon: ReactNode; children: ReactNode }) => (
  <section className="!mt-7 pb-1">
    <div className="mb-3 flex items-center gap-2">
      <span className="shrink-0 text-[var(--ec-accent)]" aria-hidden>{icon}</span>
      <h4 className="shrink-0 text-sm font-semibold text-[var(--ec-text)]">{title}</h4>
      {countLabel ? <span className="shrink-0 text-[10px] tabular-nums text-[var(--ec-faint)]">{countLabel}</span> : null}
      <span className="h-px min-w-4 flex-1 bg-[var(--ec-border-strong)]" aria-hidden />
    </div>
    <div>{children}</div>
  </section>
);

const nativeSubagentsFromRun = (run: RunDetail | null) => {
  if (!run) return [];
  const byId = new Map<string, { id: string; name: string; status: string; summary: string }>();
  for (const step of run.steps) {
    const metadata = safeMetadata(step.metadataJson);
    const raw = metadata.subagent;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const subagent = raw as Record<string, unknown>;
    const id = typeof subagent.id === "string" ? subagent.id : "";
    if (!id) continue;
    byId.set(id, {
      id,
      name: typeof subagent.name === "string" ? subagent.name : "Provider subagent",
      status: typeof subagent.status === "string" ? subagent.status : "running",
      summary: typeof subagent.summary === "string" ? subagent.summary : "",
    });
  }
  return [...byId.values()];
};

export const OrchestrationAgentsPanel = ({
  coordinatorRunId,
  initialDetail = null,
  modelLabels,
  onOpenChildRun,
  onReviewChildRun,
}: OrchestrationAgentsPanelProps) => {
  const buildwarden = useBuildWardenClient();
  const [detail, setDetail] = useState<OrchestrationDetail | null>(initialDetail);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialDetail?.tasks[0]?.id ?? null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [preview, setPreview] = useState<OrchestrationAdoptionPreview | null>(null);
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const coordinatorRunIdRef = useRef(coordinatorRunId);
  const reloadGenerationRef = useRef(0);
  coordinatorRunIdRef.current = coordinatorRunId;

  const reload = useCallback(async () => {
    if (!buildwarden.capabilities.orchestrationRead) return;
    const requestedCoordinatorRunId = coordinatorRunId;
    const generation = ++reloadGenerationRef.current;
    const next = await buildwarden.getOrchestrationDetail(coordinatorRunId);
    if (
      coordinatorRunIdRef.current !== requestedCoordinatorRunId ||
      reloadGenerationRef.current !== generation
    ) {
      return;
    }
    setDetail(next);
    setSelectedTaskId((current) => current && next?.tasks.some((task) => task.id === current)
      ? current
      : (next?.tasks[0]?.id ?? null));
  }, [buildwarden, coordinatorRunId]);

  useEffect(() => {
    reloadGenerationRef.current += 1;
    setDetail(initialDetail);
    setSelectedTaskId(initialDetail?.tasks[0]?.id ?? null);
    setPreview(null);
    setSelectedRunDetail(null);
    if (!initialDetail) {
      void reload().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load orchestration."));
    }
  }, [coordinatorRunId, initialDetail, reload]);

  useEffect(() => {
    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight = false;
    let trailingRefresh = false;
    const scheduleRefresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (refreshInFlight) {
          trailingRefresh = true;
          return;
        }
        refreshInFlight = true;
        void reload()
          .catch(() => undefined)
          .finally(() => {
            refreshInFlight = false;
            if (trailingRefresh && !disposed) {
              trailingRefresh = false;
              scheduleRefresh();
            }
          });
      }, LIVE_REFRESH_DELAY_MS);
    };
    const unsubscribe = buildwarden.onOrchestrationChanged((payload) => {
      if (payload.coordinatorRunId !== coordinatorRunId) return;
      if (refreshInFlight) {
        trailingRefresh = true;
      } else {
        scheduleRefresh();
      }
    });
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [buildwarden, coordinatorRunId, reload]);

  const selectedTask = detail?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedChildRunId = selectedTask?.childRunId ?? null;

  useEffect(() => {
    setPreview(null);
    setSelectedRunDetail(null);
    if (!selectedChildRunId) return;

    let disposed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight = false;
    let trailingRefresh = false;
    const loadChildDetail = async (clearOnError: boolean) => {
      if (refreshInFlight) {
        trailingRefresh = true;
        return;
      }
      refreshInFlight = true;
      try {
        const next = await buildwarden.getRunDetail(selectedChildRunId);
        if (!disposed) setSelectedRunDetail(next);
      } catch {
        if (!disposed && clearOnError) setSelectedRunDetail(null);
      } finally {
        refreshInFlight = false;
        if (trailingRefresh && !disposed) {
          trailingRefresh = false;
          scheduleRefresh();
        }
      }
    };
    const scheduleRefresh = () => {
      if (disposed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void loadChildDetail(false);
      }, LIVE_REFRESH_DELAY_MS);
    };

    void loadChildDetail(true);
    const unsubscribe = buildwarden.onRunEvent((event) => {
      if (event.runId !== selectedChildRunId) return;
      if (refreshInFlight) {
        trailingRefresh = true;
      } else {
        scheduleRefresh();
      }
    });
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [buildwarden, selectedChildRunId]);

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusyAction(name);
    setError(null);
    try {
      await action();
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The orchestration action failed.");
    } finally {
      setBusyAction(null);
    }
  };

  const loadPreview = async () => {
    if (!selectedTask) return;
    setBusyAction("preview");
    setError(null);
    try {
      setPreview(await buildwarden.getOrchestrationAdoptionPreview(selectedTask.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare the adoption preview.");
    } finally {
      setBusyAction(null);
    }
  };

  const nativeSubagents = useMemo(() => nativeSubagentsFromRun(selectedRunDetail), [selectedRunDetail]);
  const taskOptions = useMemo(() => detail?.tasks.map((task) => {
    const role = detail.orchestration.teamSnapshot.roles.find((entry) => entry.id === task.roleId);
    return {
      value: task.id,
      label: task.title,
      status: {
        label: task.status,
        tone: taskTone(task.status),
      },
      description: [
        role?.name ?? task.roleId,
        modelLabels.get(task.modelId) ?? task.modelId,
        task.intent,
        formatElapsed(task),
        task.adoptionStatus !== "none" ? `changes: ${task.adoptionStatus}` : null,
      ].filter(Boolean).join(" · "),
    };
  }) ?? [], [detail, modelLabels]);
  const events = detail?.events.filter((event) => !selectedTask || event.taskId === selectedTask.id).slice(-30).reverse() ?? [];
  const messages = detail?.messages.filter((entry) => !selectedTask || entry.taskId === selectedTask.id) ?? [];
  const canOperate = buildwarden.capabilities.orchestrationOperate;
  const canAdopt = buildwarden.capabilities.orchestrationAdoption;
  const totalTokens = (detail?.totalInputTokens ?? 0) + (detail?.totalOutputTokens ?? 0);

  if (!buildwarden.capabilities.orchestrationRead) {
    return <div className="grid h-full place-items-center px-6 text-center text-sm text-[var(--ec-muted)]">Remote scope <code>state:read</code> is required to view agents.</div>;
  }

  if (!detail) {
    return (
      <div className="grid h-full place-items-center gap-2 px-6 text-center text-sm text-[var(--ec-muted)]">
        <UsersRound className="size-7 text-[var(--ec-faint)]" />
        Delegation is enabled. The durable orchestration will be created when this coordinator delegates its first wave.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ec-panel)]">
      <header className="shrink-0 border-b border-[var(--ec-border)] px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge dot tone={detail.orchestration.status === "active" || detail.orchestration.status === "waiting" ? "running" : detail.orchestration.status === "completed" ? "completed" : detail.orchestration.status === "cancelled" ? "cancelled" : detail.orchestration.status === "paused" ? "queued" : "failed"}>
            {detail.orchestration.status}
          </Badge>
          <span className="text-[11px] tabular-nums text-[var(--ec-muted)]">
            {detail.activeTaskCount} running · {detail.queuedTaskCount} queued · {detail.attentionTaskCount} attention
          </span>
          <span className="text-[11px] tabular-nums text-[var(--ec-muted)]">
            {detail.tasks.length}/{detail.orchestration.teamSnapshot.maxTasksPerOrchestration} tasks · {formatCount.format(totalTokens)} tokens
          </span>
          <span className="flex-1" />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            title={buildwarden.capabilities.orchestrationSettings ? "Refresh frozen team" : "Requires run:operate and admin scopes"}
            disabled={!canOperate || !buildwarden.capabilities.orchestrationSettings || busyAction != null}
            onClick={() => void runAction("refresh", () => buildwarden.refreshOrchestrationTeam(coordinatorRunId))}
          >
            <RefreshCw className={`size-3.5 ${busyAction === "refresh" ? "animate-spin" : ""}`} />
          </Button>
          {detail.orchestration.status === "paused" ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" title={canOperate ? "Resume" : "Requires run:operate scope"} disabled={!canOperate || busyAction != null} onClick={() => void runAction("resume", () => buildwarden.resumeOrchestration(coordinatorRunId))}>
              <Play className="size-3.5" />
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="icon" className="size-7" title={canOperate ? "Pause" : "Requires run:operate scope"} disabled={!canOperate || busyAction != null} onClick={() => void runAction("pause", () => buildwarden.pauseOrchestration(coordinatorRunId))}>
              <Pause className="size-3.5" />
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="size-7 text-[var(--ec-danger)]" title={canOperate ? "Cancel orchestration" : "Requires run:operate scope"} disabled={!canOperate || busyAction != null} onClick={() => void runAction("cancel", () => buildwarden.cancelOrchestration(coordinatorRunId))}>
            <Square className="size-3.5" />
          </Button>
        </div>
        {error ? <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ec-danger)]"><AlertTriangle className="size-3.5" />{error}</p> : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--ec-border)] px-3 py-2">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ec-faint)]">Agent</span>
          <Select
            value={selectedTaskId ?? ""}
            options={taskOptions}
            onValueChange={setSelectedTaskId}
            placeholder="No delegated agents"
            ariaLabel="Select agent"
            className="min-w-0 flex-1"
            triggerClassName="h-8 rounded-md px-2.5 text-xs"
            optionClassName="py-1.5 text-xs"
            maxMenuHeightPx={320}
            searchable={detail.tasks.length > 6}
            searchPlaceholder="Search agents…"
            searchAriaLabel="Search agents"
          />
          {selectedTask ? (
            <Badge dot tone={taskTone(selectedTask.status)}>{selectedTask.status}</Badge>
          ) : null}
          <Badge tone="neutral" className="h-7 shrink-0 gap-1.5 px-2 text-[11px] tabular-nums">
            <UsersRound className="size-3" />
            {detail.tasks.length} {detail.tasks.length === 1 ? "agent" : "agents"}
          </Badge>
        </div>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          {selectedTask ? (
            <div className="space-y-3 p-3">
              <section>
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-[var(--ec-text)]">{selectedTask.title}</h3>
                    <p className="mt-0.5 text-[11px] text-[var(--ec-muted)]">
                      {modelLabels.get(selectedTask.modelId) ?? selectedTask.modelId} · {formatCount.format(selectedTask.inputTokens + selectedTask.outputTokens)} tokens
                    </p>
                  </div>
                </div>
                <ActivityRichText content={selectedTask.prompt} compact className="mt-2 break-words" />
                {selectedTask.attentionReason || selectedTask.errorMessage ? (
                  <p className="mt-2 rounded-md border border-[var(--ec-danger-ring)] bg-[var(--ec-danger-soft)] px-2 py-1.5 text-xs text-[var(--ec-danger)]">
                    {selectedTask.attentionReason ?? selectedTask.errorMessage}
                  </p>
                ) : null}
              </section>

              <div className="flex flex-wrap gap-1.5">
                {selectedTask.childRunId ? (
                  <>
                    <Button type="button" variant="secondary" size="sm" className="h-7 gap-1 text-xs" onClick={() => onOpenChildRun(selectedTask.childRunId!)}>
                      <ExternalLink className="size-3" /> Open full run
                    </Button>
                    <Button type="button" variant="secondary" size="sm" className="h-7 gap-1 text-xs" onClick={() => onReviewChildRun(selectedTask.childRunId!)}>
                      <GitCompareArrows className="size-3" /> Review changes
                    </Button>
                  </>
                ) : null}
                {selectedTask.status === "completed" && selectedTask.intent === "implement" ? (
                  <Button type="button" variant="secondary" size="sm" className="h-7 gap-1 text-xs" disabled={busyAction != null} onClick={() => void loadPreview()}>
                    {busyAction === "preview" ? <Loader2 className="size-3 animate-spin" /> : <GitCompareArrows className="size-3" />} Adoption preview
                  </Button>
                ) : null}
                {TERMINAL_TASK_STATUSES.has(selectedTask.status) ? (
                  <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={!canOperate || busyAction != null} title={canOperate ? "Retry as a linked replacement task" : "Requires run:operate scope"} onClick={() => void runAction("retry", () => buildwarden.retryOrchestrationTask(selectedTask.id))}>
                    <RotateCcw className="size-3" /> Retry
                  </Button>
                ) : null}
              </div>

              {preview ? (
                <section className="rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-[var(--ec-text)]">{preview.changedFiles.length} changed file{preview.changedFiles.length === 1 ? "" : "s"}</p>
                    <span className="text-[10px] text-[var(--ec-muted)]">{preview.status}</span>
                  </div>
                  {preview.conflicts.length || preview.unsupportedPaths.length ? (
                    <p className="mt-1 text-[11px] text-[var(--ec-danger)]">
                      {[...preview.conflicts, ...preview.unsupportedPaths].join(", ")}
                    </p>
                  ) : (
                    <p className="mt-1 max-h-16 overflow-auto font-mono text-[10px] text-[var(--ec-muted)]">{preview.changedFiles.join(", ") || "No file changes."}</p>
                  )}
                  <div className="mt-2 flex gap-1.5">
                    {selectedTask.adoptionStatus === "adopted" ? (
                      <Button type="button" variant="secondary" size="sm" className="h-7 gap-1 text-xs" disabled={!canAdopt || busyAction != null} title={canAdopt ? "Undo while adopted file hashes still match" : "Requires run:operate and git:write scopes"} onClick={() => void runAction("undo", () => buildwarden.decideOrchestrationAdoption({ taskId: selectedTask.id, decision: "undo" }))}>
                        <Undo2 className="size-3" /> Undo
                      </Button>
                    ) : (
                      <>
                        <Button type="button" size="sm" className="h-7 gap-1 text-xs" disabled={!canAdopt || busyAction != null || preview.conflicts.length > 0 || preview.unsupportedPaths.length > 0} title={canAdopt ? "Adopt the complete verified delta" : "Requires run:operate and git:write scopes"} onClick={() => void runAction("adopt", () => buildwarden.decideOrchestrationAdoption({ taskId: selectedTask.id, decision: "approve" }))}>
                          <CheckCircle2 className="size-3" /> Adopt
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" disabled={!canAdopt || busyAction != null} onClick={() => void runAction("reject", () => buildwarden.decideOrchestrationAdoption({ taskId: selectedTask.id, decision: "reject" }))}>
                          <X className="size-3" /> Reject
                        </Button>
                      </>
                    )}
                  </div>
                </section>
              ) : null}

              {nativeSubagents.length > 0 ? (
                <section>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--ec-faint)]">Provider-native subagents</p>
                  <div className="space-y-1">
                    {nativeSubagents.map((subagent) => (
                      <div key={subagent.id} className="rounded-md border border-[var(--ec-border)] px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="font-medium text-[var(--ec-text)]">{subagent.name}</span>
                          <span className="text-[var(--ec-muted)]">{subagent.status}</span>
                        </div>
                        {subagent.summary ? <ActivityRichText content={subagent.summary} compact className="mt-0.5 line-clamp-2 break-words" /> : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              <AgentDetailSection title="Result" icon={<CheckCircle2 className="size-3.5" />}>
                {selectedTask.summary ? (
                  <ActivityRichText content={selectedTask.summary} compact className="break-words" />
                ) : (
                  <p className="text-[11px] text-[var(--ec-faint)]">No result has been reported yet.</p>
                )}
              </AgentDetailSection>

              <AgentDetailSection
                title="Messages"
                countLabel={`${messages.length} ${messages.length === 1 ? "message" : "messages"}`}
                icon={<MessageSquare className="size-3.5" />}
              >
                {messages.length > 0 ? <div className="mb-2 space-y-1.5">{messages.map((entry) => (
                  <div key={entry.id} className="rounded-md border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-1.5">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ec-muted)]">{entry.source}</p>
                    <ActivityRichText content={entry.content} compact className="break-words" />
                  </div>
                ))}</div> : <p className="mb-2 text-[11px] text-[var(--ec-faint)]">No messages for this agent.</p>}
                <div className="flex gap-1">
                  <Input value={message} disabled={!canOperate || busyAction != null} className="h-8 text-xs" placeholder="Deliver at the next child turn boundary" onChange={(event) => setMessage(event.target.value)} />
                  <Button
                    type="button"
                    size="icon"
                    className="size-8"
                    title={canOperate ? "Queue message" : "Requires run:operate scope"}
                    disabled={!canOperate || !message.trim() || busyAction != null}
                    onClick={() => void runAction("message", async () => {
                      await buildwarden.sendOrchestrationTaskMessage({ taskId: selectedTask.id, content: message.trim() });
                      setMessage("");
                    })}
                  >
                    <Send className="size-3.5" />
                  </Button>
                </div>
              </AgentDetailSection>

              <AgentDetailSection
                title="Activity"
                countLabel={`${events.length} ${events.length === 1 ? "event" : "events"}`}
                icon={<Activity className="size-3.5" />}
              >
                <div className="space-y-2">
                  {events.length === 0 ? <p className="text-[11px] text-[var(--ec-faint)]">No task events yet.</p> : events.map((event) => (
                    <div key={event.id} className="border-b border-[var(--ec-border)] pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="size-1.5 shrink-0 rounded-full bg-[var(--ec-muted)]" />
                        <span className="font-medium text-[var(--ec-text)]">{event.title}</span>
                      </div>
                      {event.content ? <ActivityRichText content={event.content} compact className="mt-1 break-words pl-3.5" /> : null}
                    </div>
                  ))}
                </div>
              </AgentDetailSection>

            </div>
          ) : (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-[var(--ec-muted)]">
              <MessageSquare className="size-6 text-[var(--ec-faint)]" />
              The coordinator has not delegated a task yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
