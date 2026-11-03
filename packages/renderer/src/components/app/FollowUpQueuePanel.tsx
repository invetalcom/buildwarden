import { useEffect, useState, type KeyboardEvent } from "react";
import type { FollowUpQueueAction, QueuedFollowUpRecord } from "@buildwarden/shared";
import { AlertTriangle, ArrowDown, ArrowUp, Check, ListOrdered, Paperclip, Pencil, Play, Send, Target, X, Zap } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface FollowUpQueuePanelProps {
  queue: readonly QueuedFollowUpRecord[];
  /** True while the agent's turn is running; the queue starts when it ends. */
  active: boolean;
  /** True when the running turn accepts steered input. */
  steeringAvailable: boolean;
  readOnly?: boolean;
  /** Larger tap targets with actions on their own row, for the mobile shell. */
  touch?: boolean;
  busy?: boolean;
  /** Most recent queue or steering problem to show inline. */
  notice?: string | null;
  onDismissNotice?: () => void;
  modelLabel?: (modelId: string) => string | null;
  onAction: (action: FollowUpQueueAction) => Promise<void>;
}

const DENSE_ICON_BUTTON_CLASS = "h-6 w-6 shrink-0 p-0 text-[var(--ec-muted)] [&_svg]:h-3.5 [&_svg]:w-3.5";
const TOUCH_ICON_BUTTON_CLASS = "h-9 w-9 shrink-0 p-0 text-[var(--ec-muted)] [&_svg]:h-4 [&_svg]:w-4";

/**
 * Compact list of follow-ups waiting behind the running turn. Entries can be edited,
 * reordered, removed, or sent now (steered into the running turn when supported).
 */
export const FollowUpQueuePanel = ({
  queue,
  active,
  steeringAvailable,
  readOnly = false,
  touch = false,
  busy = false,
  notice,
  onDismissNotice,
  modelLabel,
  onAction,
}: FollowUpQueuePanelProps) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pending, setPending] = useState(false);

  // An entry that starts or is removed while being edited ends the edit.
  useEffect(() => {
    if (editingId && !queue.some((entry) => entry.id === editingId)) setEditingId(null);
  }, [editingId, queue]);

  if (queue.length === 0 && !notice) return null;

  const disabled = readOnly || busy || pending;
  const iconButtonClass = touch ? TOUCH_ICON_BUTTON_CLASS : DENSE_ICON_BUTTON_CLASS;
  const run = async (action: FollowUpQueueAction) => {
    setPending(true);
    try {
      await onAction(action);
      return true;
    } catch {
      return false;
    } finally {
      setPending(false);
    }
  };
  const saveEdit = async (entry: QueuedFollowUpRecord) => {
    if (editText.trim() === entry.prompt) {
      setEditingId(null);
      return;
    }
    if (await run({ type: "edit", queuedFollowUpId: entry.id, prompt: editText })) setEditingId(null);
  };
  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, entry: QueuedFollowUpRecord) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setEditingId(null);
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveEdit(entry);
    }
  };

  const held = !active && queue.length > 0;
  let sendNowTitle = "Send now";
  if (active) sendNowTitle = steeringAvailable ? "Steer into the running turn now" : "Send next, when the current turn ends";

  return (
    <div className="mx-1 mb-1 rounded-xl border border-dashed border-[var(--ec-border-strong)] bg-[var(--ec-panel-soft)] px-2 py-1" aria-label="Queued follow-ups">
      {queue.length > 0 ? (
        <div className={`flex ${touch ? "min-h-9" : "h-6"} items-center gap-1.5 text-[11px] text-[var(--ec-muted)]`}>
          <ListOrdered className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="font-medium text-[var(--ec-text)]">Queued · {queue.length}</span>
          <span className="min-w-0 truncate">
            {held ? "Held — resume to send in order." : active ? "Sends when the current turn ends." : null}
          </span>
          {held && !readOnly ? (
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className={touch ? "ml-auto h-8 gap-1 rounded-full px-3 text-xs [&_svg]:h-3.5 [&_svg]:w-3.5" : "ml-auto h-5 gap-1 rounded-full px-2 text-[11px] [&_svg]:h-3 [&_svg]:w-3"}
              disabled={disabled}
              onClick={() => void run({ type: "resume" })}
              title="Start the oldest queued follow-up"
            >
              <Play aria-hidden /> Resume
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="flex items-start gap-1.5 py-0.5 text-[11px] text-[var(--ec-warning)]">
          <span className="min-w-0 flex-1">{notice}</span>
          {onDismissNotice ? (
            <button type="button" className="shrink-0 text-[var(--ec-muted)] hover:text-[var(--ec-text)]" onClick={onDismissNotice} aria-label="Dismiss">
              <X className="h-3 w-3" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      <ol className={touch ? "flex max-h-56 flex-col overflow-y-auto" : "flex max-h-40 flex-col overflow-y-auto"}>
        {queue.map((entry, index) => {
          const editing = editingId === entry.id;
          const label = entry.modelId ? modelLabel?.(entry.modelId) : null;
          return (
            <li key={entry.id} className={`group flex min-w-0 items-start gap-1.5 border-t border-[var(--ec-border)] py-0.5 first:border-t-0 ${touch ? "flex-wrap" : ""}`}>
              <span className="mt-1 w-4 shrink-0 text-right text-[11px] tabular-nums text-[var(--ec-muted)]">{index + 1}</span>
              {editing ? (
                <div className="flex min-w-0 flex-1 items-start gap-1">
                  <Textarea
                    autoFocus
                    aria-label="Edit queued follow-up"
                    className="min-h-14 flex-1 resize-y px-2 py-1 text-[13px]"
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => handleEditKeyDown(event, entry)}
                    disabled={disabled}
                  />
                  <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={disabled} onClick={() => void saveEdit(entry)} title="Save (Ctrl+Enter)" aria-label="Save queued follow-up">
                    <Check aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={pending} onClick={() => setEditingId(null)} title="Cancel (Esc)" aria-label="Cancel editing">
                    <X aria-hidden />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
                    <span className="min-w-0 truncate text-[13px] text-[var(--ec-text)]" title={entry.prompt || undefined}>
                      {entry.prompt || <span className="italic text-[var(--ec-muted)]">{entry.updatesGoal ? "Goal update" : "Attachments only"}</span>}
                    </span>
                    {entry.attachments.length > 0 ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-[var(--ec-muted)]" title={entry.attachments.map((attachment) => attachment.fileName).join(", ")}>
                        <Paperclip className="h-3 w-3" aria-hidden />{entry.attachments.length}
                      </span>
                    ) : null}
                    {entry.deliveryUncertain ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-[var(--ec-warning)]"
                        title="Steering this message could not be confirmed, so the agent may already have it. It will not send on its own: send it again or remove it."
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden />May have arrived
                      </span>
                    ) : null}
                    {entry.updatesGoal && entry.prompt ? <Target className="h-3 w-3 shrink-0 text-[var(--ec-muted)]" aria-label="Updates the run goal" /> : null}
                    {entry.mode && entry.mode !== "code" ? <span className="shrink-0 rounded bg-[var(--ec-hover)] px-1 text-[10px] uppercase text-[var(--ec-muted)]">{entry.mode}</span> : null}
                    {label ? <span className="hidden max-w-32 shrink-0 truncate text-[11px] text-[var(--ec-muted)] sm:inline">{label}</span> : null}
                  </div>
                  {!readOnly ? (
                    <div className={touch ? "flex w-full items-center justify-end" : "flex shrink-0 items-center opacity-70 transition group-hover:opacity-100 group-focus-within:opacity-100"}>
                      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={disabled}
                        onClick={() => { setEditText(entry.prompt); setEditingId(entry.id); }} title="Edit" aria-label="Edit queued follow-up">
                        <Pencil aria-hidden />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={disabled || index === 0}
                        onClick={() => void run({ type: "move", queuedFollowUpId: entry.id, direction: "up" })} title="Move up" aria-label="Move up">
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={disabled || index === queue.length - 1}
                        onClick={() => void run({ type: "move", queuedFollowUpId: entry.id, direction: "down" })} title="Move down" aria-label="Move down">
                        <ArrowDown aria-hidden />
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className={iconButtonClass}
                        disabled={disabled || (active && !steeringAvailable && index === 0)}
                        onClick={() => void run({ type: "send-now", queuedFollowUpId: entry.id })} title={entry.deliveryUncertain ? `${sendNowTitle} (again)` : sendNowTitle} aria-label={sendNowTitle}>
                        {active && steeringAvailable ? <Zap aria-hidden /> : <Send aria-hidden />}
                      </Button>
                      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} disabled={disabled}
                        onClick={() => void run({ type: "delete", queuedFollowUpId: entry.id })} title="Remove" aria-label="Remove queued follow-up">
                        <X aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
