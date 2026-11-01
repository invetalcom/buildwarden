import { ArrowRightLeft } from "lucide-react";
import { describeModelHandoffContext, type ModelHandoffMetadata } from "@buildwarden/shared";

/** Hairline divider marking that a follow-up passed the conversation to another model. */
export const ModelHandoffDivider = ({
  handoff,
  time,
}: Readonly<{ handoff: ModelHandoffMetadata; time?: string | null }>) => {
  const target = handoff.toProviderLabel ? `${handoff.toModelLabel} · ${handoff.toProviderLabel}` : handoff.toModelLabel;
  const contextNote = describeModelHandoffContext(handoff.context);
  const tooltip = [
    handoff.fromModelLabel ? `From ${handoff.fromModelLabel} to ${target}` : `To ${target}`,
    contextNote,
    time,
  ].filter(Boolean).join(" · ");
  return (
    <div className="agent-turn-end agent-turn-end--handoff" role="separator" aria-label={`Passing over to ${target}`} title={tooltip}>
      <span className="agent-turn-end-label">
        <ArrowRightLeft className="h-3 w-3 shrink-0 text-[color:var(--ec-accent)]" aria-hidden />
        <span>Passing over to</span>
        <span className="agent-turn-end-title truncate">{handoff.toModelLabel}</span>
        {handoff.toProviderLabel ? <span className="agent-turn-end-fact shrink-0">{handoff.toProviderLabel}</span> : null}
        <span className="agent-turn-end-fact agent-turn-end-note truncate">{contextNote}</span>
      </span>
    </div>
  );
};
