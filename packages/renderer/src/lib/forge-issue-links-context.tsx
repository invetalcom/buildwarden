import type { ProjectForgeIssueWorkLink, ProjectForgeIssueWorkLinkKind } from "@buildwarden/shared";
import { CircleDot } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { cn } from "./cn";

export interface ForgeIssueLinkTarget {
  projectId: string;
  link: ProjectForgeIssueWorkLink;
}

export interface ForgeIssueLinksContextValue {
  /** The issue a run, chat, or task was started for, if any. */
  find: (kind: ProjectForgeIssueWorkLinkKind, targetId: string) => ForgeIssueLinkTarget | null;
  /** Opens the issue in its project's PRs & Issues page. */
  open: (target: ForgeIssueLinkTarget) => void;
}

const ForgeIssueLinksContext = createContext<ForgeIssueLinksContextValue | null>(null);

export const ForgeIssueLinksProvider = ({ value, children }: Readonly<{ value: ForgeIssueLinksContextValue; children: ReactNode }>) => (
  <ForgeIssueLinksContext.Provider value={value}>{children}</ForgeIssueLinksContext.Provider>
);

/** Chip that leads from a run or chat back to the issue it was started for. Renders nothing without one. */
export const ForgeIssueBackLink = ({ kind, targetId, className }: Readonly<{ kind: ProjectForgeIssueWorkLinkKind; targetId: string; className?: string }>) => {
  const context = useContext(ForgeIssueLinksContext);
  const target = context?.find(kind, targetId) ?? null;
  if (!context || !target?.link.issueUrl) return null;
  const { link } = target;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--ec-muted)] transition-colors hover:border-[var(--ec-accent-ring)] hover:bg-[var(--ec-accent-soft)] hover:text-[var(--ec-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ec-ring)]",
        className,
      )}
      title={`Started for issue #${String(link.issueNumber)}${link.issueTitle ? `: ${link.issueTitle}` : ""}. Click to open it.`}
      aria-label={`Open issue #${String(link.issueNumber)}`}
      onClick={() => context.open(target)}
    >
      <CircleDot className="h-3 w-3" aria-hidden />
      Issue #{String(link.issueNumber)}
    </button>
  );
};
