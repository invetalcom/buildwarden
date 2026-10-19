import { ListFilter } from "lucide-react";
import { SIDEBAR_RUN_VIEWS, type SidebarRunView } from "./sidebar-run-sections";
import { SidebarRunFilterMenu } from "./SidebarRunFilterMenu";

export const SidebarRunViewFilter = ({ value, counts, includeOlderRuns, onIncludeOlderRunsChange, onChange }: {
  value: SidebarRunView;
  counts: Record<string, number>;
  includeOlderRuns: boolean;
  onIncludeOlderRunsChange: (include: boolean) => void;
  onChange: (view: SidebarRunView) => void;
}) => <SidebarRunFilterMenu value={value} onChange={onChange} icon={ListFilter} label="Filter runs" menuLabel="Run views" active={value !== "all" || includeOlderRuns}
  width={280} toggle={{ label: "Include older runs", checked: includeOlderRuns, onChange: onIncludeOlderRunsChange }}
  options={SIDEBAR_RUN_VIEWS.map((view) => ({ ...view, count: counts[view.id] ?? 0 }))} />;
