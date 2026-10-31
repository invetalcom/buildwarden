import { useState } from "react";
import { GitPullRequest, Loader2 } from "lucide-react";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { Button } from "../ui/button";

/** Always available for a Git run, including when automatic checks are disabled. */
export function RunForgeRefreshButton({ runId }: { runId: string }) {
  const client = useBuildWardenClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return <>
    <Button type="button" variant="secondary" size="sm" className="h-8 shrink-0 px-2"
      disabled={pending} title={message ?? "Check PR/MR status now"} aria-label="Check PR/MR status now"
      onClick={() => {
        setPending(true);
        setMessage(null);
        void client.refreshRunForgeRequest(runId).then((request) => {
          setMessage(request?.syncError ?? (request ? `${request.provider === "github" ? "PR" : "MR"} #${String(request.number)}: ${request.state}` : "No matching PR/MR found."));
        }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not check PR/MR status."))
          .finally(() => setPending(false));
      }}>
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <GitPullRequest className="size-4" aria-hidden />}
    </Button>
    <span role="status" className="sr-only">{message}</span>
  </>;
}
