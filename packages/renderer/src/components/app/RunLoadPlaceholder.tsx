import { CircleAlert, RefreshCw } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Spinner } from "../ui/motion";

/** Shown while a run's detail loads, or, when the load failed, why it failed and a way to try again. */
export const RunLoadPlaceholder = ({
  error,
  onRetry,
  className,
}: Readonly<{ error: string | null; onRetry: () => Promise<unknown>; className?: string }>) => {
  if (!error) {
    return (
      <Card className={cn("flex min-h-[400px] flex-col items-center justify-center gap-4 p-8", className)}>
        <Spinner className="h-10 w-10 text-[var(--ec-accent)]" />
        <p className="text-sm text-[var(--ec-muted)]">Loading run...</p>
      </Card>
    );
  }
  return (
    <Card role="alert" className={cn("flex min-h-[400px] flex-col items-center justify-center gap-3 p-8 text-center", className)}>
      <CircleAlert className="size-6 text-[var(--ec-danger)]" aria-hidden />
      <p className="text-sm font-medium text-[var(--ec-text)]">Could not load this run</p>
      <p className="max-w-xl break-words text-xs text-[var(--ec-muted)]">{error}</p>
      {/* A new load clears the error, so the spinner shows while it runs. */}
      <Button type="button" size="sm" variant="secondary" onClick={() => void onRetry().catch(() => undefined)}>
        <RefreshCw className="size-3.5" aria-hidden />
        Try again
      </Button>
    </Card>
  );
};
