import { useContext, useState, type ReactNode } from "react";
import { ResponseCitationContext } from "../../lib/response-citation-context";

export function ResponseCitationLink({ stepId, children }: { stepId: string; children: ReactNode }) {
  const reveal = useContext(ResponseCitationContext);
  const [unavailable, setUnavailable] = useState(false);
  return <>
    <button type="button" className="text-left text-[var(--ec-accent)] underline underline-offset-2 hover:text-[var(--ec-accent-strong)]"
      title="Go to the original response" onClick={() => setUnavailable(!reveal?.(stepId))}>{children}</button>
    {unavailable ? <span role="status" className="ml-2 text-xs text-[var(--ec-muted)]">Source not in the loaded history. Load earlier turns if available; the saved quote is shown below.</span> : null}
  </>;
}
