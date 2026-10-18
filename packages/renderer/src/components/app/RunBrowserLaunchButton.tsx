import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { runHasBrowserActivity, type RunBrowserState, type RunDetail } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export const RunBrowserLaunchButton = ({ detail, onOpen }: { detail: RunDetail; onOpen: () => void }) => {
  const runId = detail.run.id;
  const client = useBuildWardenClient();
  const [state, setState] = useState<RunBrowserState | null>(null);
  useEffect(() => client.onRunBrowserEvent((event) => {
    if (event.runId === runId && event.type === "state") setState(event.state);
  }), [client, runId]);
  if (!client.capabilities.browserControl || !runHasBrowserActivity(detail)) return null;
  const current = state?.runId === runId ? state : null;
  return <button type="button" onClick={onOpen} title="View the shared run browser and select page elements as context"
    className="flex min-h-7 max-w-full shrink-0 items-center gap-1.5 self-end px-3 text-[11px] text-[var(--ec-accent)] hover:underline">
    <Globe className="h-3.5 w-3.5 shrink-0" />
    <span>Browser</span>
    {current?.owner === "agent" ? <span className="text-[var(--ec-muted)]">· Agent controlling</span> : null}
    {current && current.currentUrl !== "about:blank" ? <span className="max-w-64 truncate text-[var(--ec-muted)]">{current.title || current.currentUrl}</span> : null}
  </button>;
};
