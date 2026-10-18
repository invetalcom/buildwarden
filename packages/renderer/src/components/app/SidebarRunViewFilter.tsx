import { ListFilter } from "lucide-react";
import { SIDEBAR_RUN_VIEWS, type SidebarRunView } from "./sidebar-run-sections";
import { SidebarRunFilterMenu } from "./SidebarRunFilterMenu";

export const SidebarRunViewFilter = ({ value, counts, recentRunDays, onChange }: {
  value: SidebarRunView;
  counts: Record<string, number>;
  recentRunDays: number;
  onChange: (view: SidebarRunView) => void;
}) => <SidebarRunFilterMenu value={value} onChange={onChange} icon={ListFilter} label="Filter runs" menuLabel="Run views" active={value !== "all"}
  options={SIDEBAR_RUN_VIEWS.map((view) => ({ ...view, count: counts[view.id] ?? 0,
    title: view.id === "recent" ? `User activity in the last ${recentRunDays} days` : undefined }))} />;
