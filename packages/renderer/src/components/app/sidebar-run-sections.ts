import { UNCATEGORIZED_RUN_SECTION_ID, type AppSnapshot, type RunOrganizationSnapshot, type RunRecord } from "@buildwarden/shared";
import { buildRunHierarchyRows, findRunHierarchyScopeRoots } from "./run-hierarchy";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";
import { isRunDisplayStatusActive, resolveRunDisplayStatus } from "./run-display-status";

export const EMPTY_RUN_ORGANIZATION: RunOrganizationSnapshot = { sections: [], runs: [] };
export type SidebarRunView = "all" | "active" | "done" | "failed" | "recent";
export const SIDEBAR_RUN_VIEWS: { id: SidebarRunView; label: string }[] = [
  { id: "all", label: "All" }, { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" }, { id: "recent", label: "Recent" },
];

export const matchesSidebarRunView = (run: RunRecord, view: SidebarRunView, recentDays: number, now: number) => {
  const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  if (view === "active") return isRunDisplayStatusActive(status);
  if (view === "done") return status === "completed";
  if (view === "failed") return status === "failed" || status === "deletion-failed";
  if (view === "recent") return now - recentRunOrderTimestamp(run) <= recentDays * 86_400_000;
  return true;
};

export const buildSidebarRunSections = ({ projects, organization, view, tag, hideActiveRuns, recentDays, expandedRunIds, now = Date.now() }: {
  projects: AppSnapshot["projects"];
  organization: RunOrganizationSnapshot;
  view: SidebarRunView;
  tag: string;
  hideActiveRuns: boolean;
  recentDays: number;
  expandedRunIds: ReadonlySet<string>;
  now?: number;
}) => {
  const metadata = new Map(organization.runs.map((record) => [record.runId, record]));
  const customIds = new Set(organization.sections.map((section) => section.id));
  const sectionFor = (run: RunRecord) => {
    const id = metadata.get(run.id)?.sectionId;
    return id && customIds.has(id) ? id : UNCATEGORIZED_RUN_SECTION_ID;
  };
  const availableProjects = projects.map((project) => {
    const runsById = new Map([...project.runs, ...project.orchestratedRuns, ...project.forLaterRuns].map((run) => [run.id, run]));
    const forLaterIds = new Set([...runsById.values()].filter((run) => run.listVisibility === "for-later").map((run) => run.id));
    const hasHiddenAncestor = (run: RunRecord) => {
      if (run.rootRunId && forLaterIds.has(run.rootRunId)) return true;
      const visited = new Set<string>();
      let parentId = run.parentRunId;
      while (parentId && !visited.has(parentId)) {
        if (forLaterIds.has(parentId)) return true;
        visited.add(parentId);
        parentId = runsById.get(parentId)?.parentRunId ?? null;
      }
      return false;
    };
    const visible = (run: RunRecord) => {
      const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
      return run.listVisibility !== "for-later" &&
        !(hideActiveRuns && view !== "active" && ["queued", "preparing", "running"].includes(status));
    };
    return { project, primary: project.runs.filter(visible), children: project.orchestratedRuns.filter((run) => visible(run) && !hasHiddenAncestor(run)) };
  });
  return [...organization.sections, { id: UNCATEGORIZED_RUN_SECTION_ID, name: "Uncategorized", position: organization.sections.length }].map((section) => {
    const groups = availableProjects.flatMap(({ project, primary, children }) => {
      const matches = (run: RunRecord) => (!tag || metadata.get(run.id)?.tags.includes(tag)) &&
        matchesSidebarRunView(run, view, recentDays, now);
      // Recent retains the existing ancestor context; explicit status/tag filters
      // show only matching runs, recovering a child as a root when necessary.
      const inScope = (run: RunRecord) => sectionFor(run) === section.id && (view === "recent" && !tag || matches(run));
      const rootsInSection = primary.filter(inScope);
      const childrenInSection = children.filter(inScope);
      const candidates = [...rootsInSection, ...childrenInSection].filter(matches);
      const roots = findRunHierarchyScopeRoots(candidates, rootsInSection, childrenInSection,
        [...rootsInSection, ...project.forLaterRuns]);
      if (!roots.length) return [];
      const rows = buildRunHierarchyRows(roots, childrenInSection, {
        expandedRunIds,
        compareRuns: (left, right) => recentRunOrderTimestamp(right) - recentRunOrderTimestamp(left),
      });
      return [{ project, rows, count: candidates.length }];
    });
    const time = (run: RunRecord | undefined) => run ? recentRunOrderTimestamp(run) : 0;
    groups.sort((left, right) => time(right.rows[0]?.run) - time(left.rows[0]?.run));
    // Sort root blocks across projects without separating children from parents.
    const blocks: { project: AppSnapshot["projects"][number]; row: (typeof groups)[number]["rows"][number] }[][] = [];
    for (const { project, rows } of groups) for (const row of rows) {
      if (row.depth === 0 || !blocks.length) blocks.push([]);
      blocks.at(-1)!.push({ project, row });
    }
    blocks.sort((left, right) => time(right[0]?.row.run) - time(left[0]?.row.run));
    return { ...section, groups, flatRows: blocks.flat(), count: groups.reduce((sum, group) => sum + group.count, 0) };
  });
};
