import { useEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { copyDeepLink } from "../../lib/clipboard";

const COPIED_FEEDBACK_MS = 1_600;

/** Copies a link that reopens this run or chat: `buildwarden://…` on the desktop, this page's URL in a browser. */
export const CopyDeepLinkButton = ({ kind, id, className }: { kind: "run" | "chat"; id: string; className: string }) => {
  const buildwarden = useBuildWardenClient();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const label = state === "copied" ? "Link copied" : state === "failed" ? "Could not copy the link" : `Copy link to this ${kind}`;
  const copy = async () => {
    setState(await copyDeepLink(kind, id, buildwarden.capabilities.platform) ? "copied" : "failed");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setState("idle"), COPIED_FEEDBACK_MS);
  };

  return (
    <button type="button" className={className} onClick={() => void copy()} title={label} aria-label={label} data-copied={state === "copied" || undefined}>
      {state === "copied" ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : <Link2 className="h-4 w-4 shrink-0" aria-hidden />}
    </button>
  );
};
