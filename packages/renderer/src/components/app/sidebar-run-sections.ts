import type { AppSnapshot, RunRecord, SidebarRunSection, SidebarRunSectionColor, SidebarRunView } from "@buildwarden/shared";
import { isRunDisplayStatusActive, resolveRunDisplayStatus } from "./run-display-status";
import { findRunHierarchyScopeRoots } from "./run-hierarchy";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";

/** Carries the top-level run id while a sidebar run is dragged onto a section. */
export const SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE = "application/x-buildwarden-sidebar-section-run";

export const SIDEBAR_RUN_SECTION_COLOR_CLASSES: Record<SidebarRunSectionColor, string> = {
  accent: "bg-[var(--ec-accent)]",
  secondary: "bg-[var(--ec-secondary)]",
  success: "bg-[var(--ec-success)]",
  warning: "bg-[var(--ec-warning)]",
  danger: "bg-[var(--ec-danger)]",
  neutral: "bg-[var(--ec-muted)]",
};

type SidebarProject = AppSnapshot["projects"][number];

export interface SidebarSectionRunEntry {
  project: SidebarProject;
  run: RunRecord;
}

/** Pending optimistic moves keyed by run id; `null` means Uncategorized. */
export type SidebarSectionMoves = ReadonlyMap<string, string | null>;

export const resolveRunSidebarSectionId = (
  run: Pick<RunRecord, "id" | "sidebarSectionId">,
  sectionIds: ReadonlySet<string>,
  pendingMoves: SidebarSectionMoves = new Map(),
): string | null => {
  const sectionId = pendingMoves.has(run.id) ? pendingMoves.get(run.id) ?? null : run.sidebarSectionId ?? null;
  return sectionId && sectionIds.has(sectionId) ? sectionId : null;
};

export const sidebarRunMatchesView = (run: RunRecord, view: SidebarRunView): boolean => {
  if (view === "all") return true;
  const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  if (view === "done") return status === "completed";
  if (view === "failed") return status === "failed" || status === "attention" || status === "deletion-failed";
  const waitingForInput = run.pendingUserInputRequest === true || run.pendingUserInputRequest === 1;
  return waitingForInput || (isRunDisplayStatusActive(status) && status !== "attention");
};

/**
 * Collects the top-level runs the sidebar shows: Uncategorized runs only while
 * they (or a subagent) were active within the recent window, and every run the
 * user moved into a section regardless of age.
 */
export const collectSidebarSectionRuns = (
  projects: readonly SidebarProject[],
  {
    sectionIds,
    pendingMoves,
    recentRunWindowMs,
    now,
  }: { sectionIds: ReadonlySet<string>; pendingMoves: SidebarSectionMoves; recentRunWindowMs: number; now: number },
): SidebarSectionRunEntry[] =>
  projects.flatMap((entry) => {
    const recentActivity = [...entry.runs, ...entry.orchestratedRuns].filter((run) => {
      const timestamp = recentRunOrderTimestamp(run);
      return Number.isFinite(timestamp) && now - timestamp <= recentRunWindowMs;
    });
    const roots = new Map(
      findRunHierarchyScopeRoots(recentActivity, entry.runs, entry.orchestratedRuns, [...entry.runs, ...entry.forLaterRuns])
        .map((run) => [run.id, run] as const),
    );
    for (const run of entry.runs) {
      if (resolveRunSidebarSectionId(run, sectionIds, pendingMoves)) roots.set(run.id, run);
    }
    return [...roots.values()].map((run) => ({ project: entry, run }));
  });

export const countSidebarRunViews = (entries: readonly SidebarSectionRunEntry[]): Record<SidebarRunView, number> => ({
  all: entries.length,
  active: entries.filter(({ run }) => sidebarRunMatchesView(run, "active")).length,
  done: entries.filter(({ run }) => sidebarRunMatchesView(run, "done")).length,
  failed: entries.filter(({ run }) => sidebarRunMatchesView(run, "failed")).length,
});

/** Buckets runs by section; the `null` key holds Uncategorized runs. */
export const groupSidebarRunsBySection = (
  entries: readonly SidebarSectionRunEntry[],
  sections: readonly SidebarRunSection[],
  pendingMoves: SidebarSectionMoves = new Map(),
): Map<string | null, SidebarSectionRunEntry[]> => {
  const sectionIds = new Set(sections.map((section) => section.id));
  const groups = new Map<string | null, SidebarSectionRunEntry[]>([[null, []], ...sections.map((section) => [section.id, []] as [string, SidebarSectionRunEntry[]])]);
  for (const entry of entries) {
    groups.get(resolveRunSidebarSectionId(entry.run, sectionIds, pendingMoves))?.push(entry);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => recentRunOrderTimestamp(right.run) - recentRunOrderTimestamp(left.run));
  }
  return groups;
};

export const createSidebarRunSectionId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `section-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
