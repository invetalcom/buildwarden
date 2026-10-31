import { DEFAULT_RUN_SECTION_COLOR, DEFAULT_UNCATEGORIZED_COLOR, isRunSectionColor, UNCATEGORIZED_RUN_SECTION_ID, type AppSnapshot, type RunOrganizationSnapshot, type RunListItem } from "@buildwarden/shared";
import { buildRunHierarchyRows, findRunHierarchyScopeRoots } from "./run-hierarchy";
import { recentRunOrderTimestamp } from "./sidebar-run-ordering";
import { isRunDisplayStatusActive, resolveRunDisplayStatus } from "./run-display-status";

export const EMPTY_RUN_ORGANIZATION: RunOrganizationSnapshot = { sections: [], runs: [] };
export type SidebarRunView = "all" | "active" | "done" | "failed";
export const SIDEBAR_RUN_VIEWS: { id: SidebarRunView; label: string }[] = [
  { id: "all", label: "All statuses" }, { id: "active", label: "Active" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

const matchesSidebarRunView = (run: RunListItem, view: SidebarRunView) => {
  const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
  if (view === "active") return isRunDisplayStatusActive(status);
  if (view === "done") return status === "completed";
  if (view === "failed") return status === "failed" || status === "deletion-failed";
  return true;
};

export const buildSidebarRunSections = ({ projects, organization, view, tag, hideActiveRuns, recentDays, expandedRunIds, uncategorizedFirst = false, includeOlderRuns = false, now = Date.now() }: {
  projects: AppSnapshot["projects"];
  organization: RunOrganizationSnapshot;
  view: SidebarRunView;
  tag: string;
  hideActiveRuns: boolean;
  recentDays: number;
  expandedRunIds: ReadonlySet<string>;
  uncategorizedFirst?: boolean;
  includeOlderRuns?: boolean;
  now?: number;
}) => {
  const metadata = new Map(organization.runs.map((record) => [record.runId, record]));
  const customIds = new Set(organization.sections.map((section) => section.id));
  const sectionFor = (run: RunListItem) => {
    const id = metadata.get(run.id)?.sectionId;
    return id && customIds.has(id) ? id : UNCATEGORIZED_RUN_SECTION_ID;
  };
  const availableProjects = projects.map((project) => {
    const runsById = new Map([...project.runs, ...project.orchestratedRuns, ...project.forLaterRuns].map((run) => [run.id, run]));
    const forLaterIds = new Set([...runsById.values()].filter((run) => run.listVisibility === "for-later").map((run) => run.id));
    const hasHiddenAncestor = (run: RunListItem) => {
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
    const visible = (run: RunListItem) => {
      const status = resolveRunDisplayStatus(run.status, run.orchestrationStatus);
      return run.listVisibility !== "for-later" &&
        !(hideActiveRuns && view !== "active" && ["queued", "preparing", "running"].includes(status));
    };
    return { project, primary: project.runs.filter(visible), children: project.orchestratedRuns.filter((run) => visible(run) && !hasHiddenAncestor(run)) };
  });
  const uncategorized = { id: UNCATEGORIZED_RUN_SECTION_ID, name: "Uncategorized", position: organization.sections.length,
    color: isRunSectionColor(organization.uncategorizedColor) ? organization.uncategorizedColor : DEFAULT_UNCATEGORIZED_COLOR };
  const orderedSections = uncategorizedFirst ? [uncategorized, ...organization.sections] : [...organization.sections, uncategorized];
  return orderedSections.map((section) => {
    let hiddenOlderRunCount = 0;
    const groups = availableProjects.flatMap(({ project, primary, children }) => {
      const matches = (run: RunListItem) => (!tag || metadata.get(run.id)?.tags.includes(tag)) &&
        matchesSidebarRunView(run, view);
      const inScope = (run: RunListItem) => sectionFor(run) === section.id && matches(run);
      let rootsInSection = primary.filter(inScope);
      let childrenInSection = children.filter(inScope);
      if (section.id === UNCATEGORIZED_RUN_SECTION_ID && !includeOlderRuns) {
        const scoped = [...rootsInSection, ...childrenInSection];
        const byId = new Map(scoped.map((run) => [run.id, run]));
        const retained = new Set(scoped.filter((run) =>
          isRunDisplayStatusActive(resolveRunDisplayStatus(run.status, run.orchestrationStatus)) ||
          now - recentRunOrderTimestamp(run) <= recentDays * 86_400_000).map((run) => run.id));
        // Preserve ancestors of recent/active subagents, but not unrelated old siblings.
        for (const id of [...retained]) {
          const run = byId.get(id)!;
          if (run.rootRunId && byId.has(run.rootRunId)) retained.add(run.rootRunId);
          const visited = new Set<string>([id]);
          let parentId = run.parentRunId;
          while (parentId && byId.has(parentId) && !visited.has(parentId)) {
            visited.add(parentId); retained.add(parentId);
            parentId = byId.get(parentId)!.parentRunId;
          }
        }
        hiddenOlderRunCount += scoped.length - retained.size;
        rootsInSection = rootsInSection.filter((run) => retained.has(run.id));
        childrenInSection = childrenInSection.filter((run) => retained.has(run.id));
      }
      const candidates = [...rootsInSection, ...childrenInSection];
      const roots = findRunHierarchyScopeRoots(candidates, rootsInSection, childrenInSection,
        [...rootsInSection, ...project.forLaterRuns]);
      if (!roots.length) return [];
      const rows = buildRunHierarchyRows(roots, childrenInSection, {
        expandedRunIds,
        compareRuns: (left, right) => recentRunOrderTimestamp(right) - recentRunOrderTimestamp(left),
      });
      return [{ project, rows, count: candidates.length }];
    });
    const time = (run: RunListItem | undefined) => run ? recentRunOrderTimestamp(run) : 0;
    groups.sort((left, right) => time(right.rows[0]?.run) - time(left.rows[0]?.run));
    // Sort root blocks across projects without separating children from parents.
    const blocks: { project: AppSnapshot["projects"][number]; row: (typeof groups)[number]["rows"][number] }[][] = [];
    for (const { project, rows } of groups) for (const row of rows) {
      if (row.depth === 0 || !blocks.length) blocks.push([]);
      blocks.at(-1)!.push({ project, row });
    }
    blocks.sort((left, right) => time(right[0]?.row.run) - time(left[0]?.row.run));
    return { ...section, color: isRunSectionColor(section.color) ? section.color : DEFAULT_RUN_SECTION_COLOR,
      groups, flatRows: blocks.flat(), count: groups.reduce((sum, group) => sum + group.count, 0), hiddenOlderRunCount };
  });
};
