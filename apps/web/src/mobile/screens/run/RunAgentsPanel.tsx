import { useCallback, useEffect, useState } from "react";
import type { OrchestrationDetail } from "@buildwarden/shared";
import { Bot, Pause, Play, RotateCw, Square } from "lucide-react";
import { useMobileApp } from "../../data/mobile-app-context";
import { useAction } from "../../data/use-action";
import { errorMessage, relativeTime } from "../../lib/format";
import { Badge, Button, CenteredSpinner, EmptyState, InlineError, ListRow, SectionLabel, type Tone } from "../../components/primitives";

const TASK_TONES: Record<string, Tone> = {
  queued: "neutral",
  running: "accent",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  attention: "warning",
};

/** Read-and-operate view of a coordinator run's delegated tasks. */
export const RunAgentsPanel = ({ coordinatorRunId }: { coordinatorRunId: string }) => {
  const { client, router } = useMobileApp();
  const [detail, setDetail] = useState<OrchestrationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    try {
      setDetail(await client.getOrchestrationDetail(coordinatorRunId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, "Could not load the agent team."));
    } finally {
      setLoading(false);
    }
  }, [client, coordinatorRunId]);

  useEffect(() => {
    void load();
    const unsubscribe = client.onOrchestrationChanged((payload) => {
      if (payload.coordinatorRunId === coordinatorRunId) void load();
    });
    return unsubscribe;
  }, [client, coordinatorRunId, load]);

  if (loading) return <CenteredSpinner label="Loading agents" />;
  if (error) return <InlineError message={error} onRetry={() => void load()} />;
  if (!detail) {
    return <EmptyState icon={<Bot className="size-7" />} title="No delegated agents" message="This run has not created any child tasks." />;
  }

  const status = detail.orchestration.status;
  const canOperate = client.capabilities.orchestrationOperate;

  return (
    <div className="m-scroll flex-1">
      {action.error ? <InlineError message={action.error} /> : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--ec-border)] px-4 py-3">
        <Badge tone={status === "attention" ? "warning" : status === "failed" ? "danger" : "accent"}>{status}</Badge>
        <span className="text-xs text-[var(--ec-muted)]">{detail.activeTaskCount} active</span>
        <span className="text-xs text-[var(--ec-muted)]">{detail.queuedTaskCount} queued</span>
        {detail.attentionTaskCount > 0 ? (
          <span className="text-xs font-medium text-[var(--ec-warning)]">{detail.attentionTaskCount} need attention</span>
        ) : null}
      </div>

      {canOperate ? (
        <div className="flex gap-2 border-b border-[var(--ec-border)] px-4 py-2.5">
          {status === "paused" ? (
            <Button tone="neutral" size="sm" className="flex-1" busy={action.busy} onClick={() => void action.run(() => client.resumeOrchestration(coordinatorRunId)).then(load)}>
              <Play className="size-4" />
              Resume
            </Button>
          ) : (
            <Button tone="neutral" size="sm" className="flex-1" busy={action.busy} onClick={() => void action.run(() => client.pauseOrchestration(coordinatorRunId)).then(load)}>
              <Pause className="size-4" />
              Pause
            </Button>
          )}
          <Button tone="danger" size="sm" className="flex-1" busy={action.busy} onClick={() => void action.run(() => client.cancelOrchestration(coordinatorRunId)).then(load)}>
            <Square className="size-4" />
            Cancel all
          </Button>
        </div>
      ) : null}

      <SectionLabel>Tasks</SectionLabel>
      {detail.tasks.length === 0 ? (
        <EmptyState title="No tasks yet" message="Delegated work appears here as the coordinator creates it." />
      ) : (
        detail.tasks.map((task) => (
          <ListRow
            key={task.id}
            title={task.title || task.prompt.split("\n")[0]}
            subtitle={task.attentionReason ?? task.errorMessage ?? task.summary ?? undefined}
            trailing={
              <>
                <Badge tone={TASK_TONES[task.status] ?? "neutral"}>{task.status}</Badge>
                <span>{relativeTime(task.updatedAt)}</span>
              </>
            }
            onClick={task.childRunId ? () => router.push({ name: "run", runId: task.childRunId as string, segment: "activity" }) : undefined}
            className="border-b border-[var(--ec-border)]"
          />
        ))
      )}

      {canOperate && detail.tasks.some((task) => task.status === "failed") ? (
        <div className="px-4 py-3">
          <Button
            tone="neutral"
            block
            size="sm"
            busy={action.busy}
            onClick={() => void action.run(() => client.refreshOrchestrationTeam(coordinatorRunId)).then(load)}
          >
            <RotateCw className="size-4" />
            Refresh team
          </Button>
        </div>
      ) : null}
      <div className="h-6" />
    </div>
  );
};
