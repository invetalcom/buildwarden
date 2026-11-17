import { ArrowRightLeft, Gauge } from "lucide-react";
import {
  describeModelHandoffContext,
  formatEffortChangeContent,
  formatTurnEffortLabel,
  type EffortChangeMetadata,
  type ModelHandoffMetadata,
} from "@buildwarden/shared";

const effortFactLabel = (change: EffortChangeMetadata): string => `${formatTurnEffortLabel(change.toEffort)} effort`;

/**
 * Hairline divider marking that a follow-up passed the conversation to another model. The label
 * wraps in narrow panels instead of truncating, so the context note never depends on the tooltip.
 */
export const ModelHandoffDivider = ({
  handoff,
  effortChange,
  time,
}: Readonly<{ handoff: ModelHandoffMetadata; effortChange?: EffortChangeMetadata | null; time?: string | null }>) => {
  const target = handoff.toProviderLabel ? `${handoff.toModelLabel} · ${handoff.toProviderLabel}` : handoff.toModelLabel;
  const contextNote = describeModelHandoffContext(handoff.context);
  const source = handoff.fromModelLabel ? `From ${handoff.fromModelLabel} to ${target}` : `To ${target}`;
  const effortNote = effortChange ? formatEffortChangeContent(effortChange) : null;
  return (
    <div
      className="agent-turn-end agent-turn-end--handoff"
      role="separator"
      aria-label={[`Passing over to ${target}`, effortChange ? effortFactLabel(effortChange) : null, contextNote].filter(Boolean).join(", ")}
      title={[source, effortNote, contextNote, time].filter(Boolean).join(" · ")}
    >
      <span className="agent-turn-end-label">
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-[color:var(--ec-accent)]" aria-hidden />
        <span>Passing over to</span>
        <span className="agent-turn-end-title">{handoff.toModelLabel}</span>
        {handoff.toProviderLabel ? <span className="agent-turn-end-fact">{handoff.toProviderLabel}</span> : null}
        {effortChange ? <span className="agent-turn-end-fact">{effortFactLabel(effortChange)}</span> : null}
        <span className="agent-turn-end-fact agent-turn-end-note">{contextNote}</span>
      </span>
    </div>
  );
};

/** Hairline divider marking that a follow-up kept its model but changed the reasoning effort. */
export const EffortChangeDivider = ({
  change,
  time,
}: Readonly<{ change: EffortChangeMetadata; time?: string | null }>) => {
  const content = formatEffortChangeContent(change);
  return (
    <div
      className="agent-turn-end agent-turn-end--handoff"
      role="separator"
      aria-label={content}
      title={[content, time].filter(Boolean).join(" · ")}
    >
      <span className="agent-turn-end-label">
        <Gauge className="h-3 w-3 shrink-0 text-[color:var(--ec-accent)]" aria-hidden />
        <span>Effort</span>
        {change.fromEffort ? (
          <>
            <span className="agent-turn-end-fact agent-turn-end-note">{formatTurnEffortLabel(change.fromEffort)}</span>
            <span aria-hidden>→</span>
          </>
        ) : null}
        <span className="agent-turn-end-title">{formatTurnEffortLabel(change.toEffort)}</span>
      </span>
    </div>
  );
};
