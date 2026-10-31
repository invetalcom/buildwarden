import { DEFAULT_RUN_SECTION_COLOR, DEFAULT_UNCATEGORIZED_COLOR, isRunSectionColor, UNCATEGORIZED_RUN_SECTION_ID, type RunOrganizationSnapshot, type RunListItem } from "@buildwarden/shared";
import { appendUnreachableSubagentRoots, buildRunHierarchyRows, findRunHierarchyScopeRoots, type RunHierarchyRow } from "./run-hierarchy";

export const runHistoryCategories = (organization: RunOrganizationSnapshot) => [
  ...organization.sections.map((section) => ({
    ...section,
    color: isRunSectionColor(section.color) ? section.color : DEFAULT_RUN_SECTION_COLOR,
  })),
  {
    id: UNCATEGORIZED_RUN_SECTION_ID,
    name: "Uncategorized",
    color: isRunSectionColor(organization.uncategorizedColor) ? organization.uncategorizedColor : DEFAULT_UNCATEGORIZED_COLOR,
  },
];

/** Scope each category independently, just like the sidebar. A child assigned to
 * another category becomes a root there without being duplicated under its parent. */
export const buildRunHistoryCategories = ({ runs, orchestratedRuns, knownPrimaryRuns = runs, organization, expandedRunIds, searchRows }: {
  runs: RunListItem[];
  orchestratedRuns: RunListItem[];
  knownPrimaryRuns?: RunListItem[];
  organization: RunOrganizationSnapshot;
  expandedRunIds: ReadonlySet<string>;
  searchRows?: RunHierarchyRow[];
}) => {
  const roots = appendUnreachableSubagentRoots(runs, orchestratedRuns, knownPrimaryRuns);
  // Start from the same reachable history as flat view, including collapsed children.
  // This also keeps descendants of runs in For later out of category view.
  const eligible = buildRunHierarchyRows(roots, orchestratedRuns, {
    expandedRunIds: new Set([...runs, ...orchestratedRuns].map((run) => run.id)),
  }).map((row) => row.run);
  const searchIds = searchRows ? new Set(searchRows.map((row) => row.run.id)) : null;
  const primaryIds = new Set(runs.map((run) => run.id));
  const metadata = new Map(organization.runs.map((record) => [record.runId, record]));
  const categories = runHistoryCategories(organization);
  const categoryIds = new Set(categories.map((category) => category.id));
  const runsByCategory = new Map<string, RunListItem[]>();
  for (const run of eligible) {
    if (searchIds && !searchIds.has(run.id)) continue;
    const assignedId = metadata.get(run.id)?.sectionId;
    const categoryId = assignedId && categoryIds.has(assignedId) ? assignedId : UNCATEGORIZED_RUN_SECTION_ID;
    const entries = runsByCategory.get(categoryId) ?? [];
    entries.push(run);
    runsByCategory.set(categoryId, entries);
  }
  return categories.flatMap((category) => {
    const candidates = runsByCategory.get(category.id) ?? [];
    if (!candidates.length) return [];
    const primary = candidates.filter((run) => primaryIds.has(run.id));
    const children = candidates.filter((run) => !primaryIds.has(run.id));
    const scopedRoots = findRunHierarchyScopeRoots(candidates, primary, children);
    return [{ ...category, count: primary.length, rows: buildRunHierarchyRows(scopedRoots, children, {
      expandedRunIds,
      matches: searchRows ? () => true : undefined,
    }) }];
  });
};
