import { useState } from "react";
import { Loader2, MessageSquareText, Play, Send } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentPanel } from "./agent-worklog";

export function RunPlanDecisionCard({
  disabled,
  onImplement,
  onSubmitFeedback,
}: Readonly<{
  disabled?: boolean;
  onImplement: () => void;
  onSubmitFeedback: (feedback: string) => Promise<void>;
}>) {
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedFeedback = feedback.trim();

  const submitFeedback = async () => {
    if (!trimmedFeedback || disabled || submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmitFeedback(trimmedFeedback);
      setFeedback("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AgentPanel tone="request" className="mt-2 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-[color:var(--ec-info)]" />
          <p className="truncate text-[11px] font-medium text-[color:var(--ec-text)]">Plan decision</p>
          <Badge
            tone="queued"
            className="px-1.5 py-0 text-[10px] bg-[color:var(--ec-info-soft)] text-[color:var(--ec-info)] ring-[color:var(--ec-info-ring)]"
          >
            next step
          </Badge>
        </div>
      </div>
      <textarea
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="Add feedback or changes to the plan"
        rows={2}
        disabled={disabled || submitting}
        className="mt-2 w-full resize-y rounded-md border border-[color:var(--ec-border)] bg-[color:var(--ec-input)] px-2 py-1.5 text-xs text-[color:var(--ec-text)] outline-none transition placeholder:text-[color:var(--ec-faint)] focus:border-[color:var(--ec-ring)] disabled:cursor-not-allowed disabled:opacity-70"
      />
      {error ? <p className="mt-1.5 text-[11px] text-[color:var(--ec-danger)]">{error}</p> : null}
      <div className="mt-2 flex flex-wrap justify-end gap-1.5">
        <Button
          type="button"
          variant="secondary"
          size="xs"
          onClick={() => void submitFeedback()}
          disabled={!trimmedFeedback || disabled || submitting}
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send feedback
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="border-[color:var(--ec-accent-ring)] bg-[color:var(--ec-accent-soft)] text-[color:var(--ec-text)] hover:bg-[color:var(--ec-info-soft)] hover:text-[color:var(--ec-text)] disabled:text-[color:var(--ec-muted)] disabled:opacity-70"
          onClick={onImplement}
          disabled={disabled || submitting}
        >
          <Play className="h-3.5 w-3.5" />
          Implement plan
        </Button>
      </div>
    </AgentPanel>
  );
}
