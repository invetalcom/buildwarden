import { useState } from "react";
import { GitPullRequest } from "lucide-react";
import { Spinner } from "../ui/motion";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";

/** Always available for a Git run, including when automatic checks are disabled. */
export function RunForgeRefreshButton({ runId, menu = false }: { runId: string; menu?: boolean }) {
  const client = useBuildWardenClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return <>
    <Button type="button" role={menu ? "menuitem" : undefined} variant={menu ? "ghost" : "secondary"} size="sm"
      className={menu ? "h-auto w-full justify-start gap-2.5 rounded-none px-3 py-2 text-xs text-[var(--ec-text)]" : "h-8 shrink-0 px-2"}
      disabled={pending} title={message ?? "Check PR/MR status now"} aria-label="Check PR/MR status now"
      onClick={() => {
        setPending(true);
        setMessage(null);
        void client.refreshRunForgeRequest(runId).then((request) => {
          setMessage(request?.syncError ?? (request ? `${request.provider === "github" ? "PR" : "MR"} #${String(request.number)}: ${request.state}` : "No matching PR/MR found."));
        }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not check PR/MR status."))
          .finally(() => setPending(false));
      }}>
      {pending ? <Spinner className="size-4" aria-hidden /> : <GitPullRequest className="size-4" aria-hidden />}
      {menu ? "Check PR/MR status" : null}
    </Button>
    {message ? <span role="status" className={menu ? "block px-3 pb-2 text-[11px] text-[var(--ec-muted)]" : "max-w-64 truncate text-xs text-[var(--ec-muted)]"} title={message}>{message}</span> : null}
  </>;
}
