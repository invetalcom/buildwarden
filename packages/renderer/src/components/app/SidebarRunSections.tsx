import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, X } from "lucide-react";
import { UNCATEGORIZED_RUN_SECTION_ID, type AppSnapshot, type RunOrganizationSnapshot } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { AnchorDropdownPortal } from "../ui/dropdown-portal";
import { parseRunDragPayload, RUN_DRAG_MIME_TYPE } from "./app-model";
import type { RunHierarchyRow } from "./run-hierarchy";
import { buildSidebarRunSections, EMPTY_RUN_ORGANIZATION, SIDEBAR_RUN_VIEWS, type SidebarRunView } from "./sidebar-run-sections";
import { SidebarOrganizerDialog, SidebarRunOrganizationForm, SidebarSectionNameForm } from "./SidebarRunOrganizer";
import { SidebarRunViewFilter } from "./SidebarRunViewFilter";

const PREFERENCE_KEY = "buildwarden:sidebar-run-sections";
type Preferences = { view: SidebarRunView; projectId: string; tag: string; collapsed: string[] };
const readPreferences = (): Preferences => {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? "null") as Partial<Preferences> | null;
    return { view: SIDEBAR_RUN_VIEWS.some((view) => view.id === value?.view) ? value!.view! : "all",
      projectId: typeof value?.projectId === "string" ? value.projectId : "",
      tag: typeof value?.tag === "string" ? value.tag : "",
      collapsed: Array.isArray(value?.collapsed) ? value.collapsed.filter((id): id is string => typeof id === "string") : [] };
  } catch { return { view: "all", projectId: "", tag: "", collapsed: [] }; }
};

type SectionDialog = { kind: "name"; id?: string; name: string } | { kind: "delete"; id: string; name: string };

export interface SidebarRunSectionsProps {
  projects: AppSnapshot["projects"];
  organization?: RunOrganizationSnapshot;
  onOrganizationChange?: (organization: RunOrganizationSnapshot) => void;
  recentRunDays: number;
  hideActiveRuns: boolean;
  groupRunsByProject: boolean;
  runRowGapClassName?: string;
  onSelectProject?: (projectId: string) => void;
  expandedRunIds: ReadonlySet<string>;
  highlightedRunId: string | null;
  organizeRunId: string | null;
  onCloseOrganizer: () => void;
  renderRun: (project: AppSnapshot["projects"][number], row: RunHierarchyRow, showProject: boolean) => ReactNode;
}

export const SidebarRunSections = ({ projects, organization = EMPTY_RUN_ORGANIZATION, onOrganizationChange,
  recentRunDays, hideActiveRuns, groupRunsByProject, runRowGapClassName = "space-y-0.5", onSelectProject, expandedRunIds, highlightedRunId, organizeRunId,
  onCloseOrganizer, renderRun }: SidebarRunSectionsProps) => {
  const client = useBuildWardenClient();
  const canOrganize = client.capabilities.runListVisibilityMutations && organization !== EMPTY_RUN_ORGANIZATION;
  const [preferences, setPreferences] = useState(readPreferences);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SectionDialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const projectId = projects.some((entry) => entry.project.id === preferences.projectId) ? preferences.projectId : "";
  const filteredProjects = useMemo(() => projectId ? projects.filter((entry) => entry.project.id === projectId) : projects, [projects, projectId]);
  const allTags = useMemo(() => [...new Set(organization.runs.flatMap((run) => run.tags))].sort(), [organization]);
  const tag = allTags.includes(preferences.tag) ? preferences.tag : "";
  const sections = useMemo(() => buildSidebarRunSections({ projects: filteredProjects, organization, view: preferences.view,
    tag, hideActiveRuns, recentDays: recentRunDays, expandedRunIds }),
  [filteredProjects, organization, preferences.view, tag, hideActiveRuns, recentRunDays, expandedRunIds]);
  const counts = useMemo(() => Object.fromEntries(SIDEBAR_RUN_VIEWS.map(({ id }) => [id,
    buildSidebarRunSections({ projects: filteredProjects, organization, view: id, tag, hideActiveRuns, recentDays: recentRunDays,
      expandedRunIds: new Set() }).reduce((count, section) => count + section.count, 0)])),
  [filteredProjects, organization, tag, hideActiveRuns, recentRunDays]);
  const updatePreferences = (patch: Partial<Preferences>) => setPreferences((current) => {
    const next = { ...current, ...patch };
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
    return next;
  });
  const highlightedSectionId = organization.runs.find((run) => run.runId === highlightedRunId)?.sectionId ?? UNCATEGORIZED_RUN_SECTION_ID;
  const highlightedProjectId = projects.find((entry) => [...entry.runs, ...entry.orchestratedRuns].some((run) => run.id === highlightedRunId))?.project.id;

  useEffect(() => {
    if (!highlightedRunId) return;
    const sectionId = highlightedSectionId;
    setPreferences((current) => current.collapsed.includes(sectionId)
      ? { ...current, collapsed: current.collapsed.filter((id) => id !== sectionId) } : current);
    if (highlightedProjectId) setCollapsedProjects((current) => {
      const key = `${sectionId}:${highlightedProjectId}`;
      if (!current.has(key)) return current;
      const next = new Set(current); next.delete(key); return next;
    });
  }, [highlightedRunId, highlightedSectionId, highlightedProjectId]);

  const mutate = async (operation: () => Promise<RunOrganizationSnapshot>, message: string) => {
    if (!canOrganize || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await operation();
      onOrganizationChange?.(next);
      setDialog(null); onCloseOrganizer(); setAnnouncement(message);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update run organization."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const acceptsDrag = (event: DragEvent<HTMLElement>) => canOrganize && !busy &&
    Array.from(event.dataTransfer.types).includes(RUN_DRAG_MIME_TYPE);
  const dropRun = (event: DragEvent<HTMLElement>, sectionId: string, name: string) => {
    if (!acceptsDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    const payload = parseRunDragPayload(event);
    const project = projects.find((entry) => entry.project.id === payload?.projectId);
    if (!payload || !project || ![...project.runs, ...project.orchestratedRuns].some((run) => run.id === payload.runId)) {
      setError("This run is no longer available. Refresh the run list and try again."); return;
    }
    const target = sectionId === UNCATEGORIZED_RUN_SECTION_ID ? null : sectionId;
    if ((organization.runs.find((run) => run.runId === payload.runId)?.sectionId ?? null) === target) return;
    updatePreferences({ collapsed: preferences.collapsed.filter((id) => id !== sectionId) });
    // Clear local filters so a successful move cannot appear to lose the run.
    updatePreferences({ view: "all", tag: "", projectId: projectId && projectId !== payload.projectId ? "" : projectId });
    void mutate(() => client.updateRunOrganization(payload.runId, { sectionId: target }), `Run moved to ${name}.`);
  };
  const reorder = (id: string, offset: number) => {
    const ids = organization.sections.map((section) => section.id);
    const index = ids.indexOf(id);
    if (index < 0 || index + offset < 0 || index + offset >= ids.length) return;
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    setMenu(null);
    void mutate(() => client.reorderRunSections(ids), "Section order updated.");
  };
  const menuSection = organization.sections.find((section) => section.id === menu);
  const errorContent = error ? <p role="alert" className="my-2 text-xs text-[var(--ec-danger)]">{error}</p> : null;

  return <div className="space-y-1.5 px-2" aria-busy={busy}>
    <div className="flex items-center gap-1 px-1">
      <Select ariaLabel="Filter runs by project" value={projectId} onValueChange={(nextProjectId) => updatePreferences({ projectId: nextProjectId })}
        className="min-w-0 flex-1" triggerClassName={cn("h-6 rounded border-0 bg-transparent px-1 text-xs hover:bg-[var(--ec-hover)]",
          projectId && "bg-[var(--ec-accent-soft)]")}
        optionClassName="px-2 py-1.5 text-xs" maxMenuHeightPx={280}
        searchable={projects.length > 8} searchPlaceholder="Find project…" searchAriaLabel="Find project"
        options={[{ value: "", label: "All projects" }, ...projects.map((entry) => ({ value: entry.project.id, label: entry.project.name }))]} />
      <SidebarRunViewFilter value={preferences.view} counts={counts} recentRunDays={recentRunDays}
        onChange={(view) => updatePreferences({ view })} />
      {canOrganize && <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="New run section" disabled={busy}
        onClick={() => { setError(""); setDialog({ kind: "name", name: "" }); }}><Plus className="size-3.5" /></Button>}
    </div>
    {allTags.length > 0 && <div className="app-scrollbar flex max-h-16 flex-wrap items-center gap-1 overflow-y-auto" aria-label="Filter runs by tag">
      {allTags.map((value) => <button type="button" key={value} aria-pressed={tag === value}
        className={cn("max-w-full truncate rounded px-1.5 py-0.5 text-[10px]", tag === value
          ? "bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]" : "bg-[var(--ec-panel)] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]")}
        onClick={() => updatePreferences({ tag: tag === value ? "" : value })}>#{value}</button>)}
      {tag && <Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Clear tag filter" onClick={() => updatePreferences({ tag: "" })}><X className="size-3" /></Button>}
    </div>}
    {!dialog && !organizeRunId && errorContent}
    <span role="status" className="sr-only">{announcement}</span>
    {sections.map((section) => {
      const collapsed = preferences.collapsed.includes(section.id);
      return <section key={section.id} aria-label={`${section.name} run section`} data-run-section={section.id}
        className={cn("rounded-md p-0.5", dropTarget === section.id
          ? "bg-[var(--ec-accent-soft)]" : "bg-[var(--ec-panel-soft)]")}
        onDragOver={(event) => { if (acceptsDrag(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(section.id); } }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(null); }}
        onDrop={(event) => dropRun(event, section.id, section.name)}>
        <div className="flex items-center">
          <button type="button" aria-expanded={!collapsed} className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-xs text-[var(--ec-text)]"
            onClick={() => updatePreferences({ collapsed: collapsed ? preferences.collapsed.filter((id) => id !== section.id) : [...preferences.collapsed, section.id] })}>
            {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
            <span className="min-w-0 flex-1 truncate font-semibold">{section.name}</span><span className="font-mono text-[10px] text-[var(--ec-muted)]">{section.count}</span>
          </button>
          {canOrganize && section.id !== UNCATEGORIZED_RUN_SECTION_ID && <button type="button" ref={menu === section.id ? menuAnchor : undefined}
            aria-label={`Manage ${section.name} section`} aria-expanded={menu === section.id} disabled={busy}
            className="rounded p-1 text-[var(--ec-muted)] hover:bg-[var(--ec-hover)]" onClick={() => setMenu(menu === section.id ? null : section.id)}><MoreHorizontal className="size-3.5" /></button>}
        </div>
        {!collapsed && (section.count === 0 ? <p className="px-2 py-2 text-[11px] text-[var(--ec-muted)]">
          {preferences.view === "all" && !tag ? hideActiveRuns ? "No inactive runs." : "No runs." : "No matching runs."}
          {canOrganize && " Drop a run here."}
        </p> : groupRunsByProject ? section.groups.map(({ project, rows, count }) => {
          const key = `${section.id}:${project.project.id}`;
          const projectExpanded = !collapsedProjects.has(key);
          return <div key={key} data-sidebar-run-group={project.project.id}>
            <button type="button" aria-expanded={projectExpanded} className="flex h-6 w-full min-w-0 items-center gap-1 px-2 text-left text-[11px] font-medium text-[var(--ec-muted)]"
              onDoubleClick={() => onSelectProject?.(project.project.id)}
              onClick={() => setCollapsedProjects((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>
              {projectExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{project.project.name}</span><span className="font-mono text-[10px]">{count}</span>
            </button>
            {projectExpanded && <div className={runRowGapClassName}>{rows.map((row) => renderRun(project, row, false))}</div>}
          </div>;
        }) : <div className={runRowGapClassName}>{section.flatRows.map(({ project, row }) => renderRun(project, row, true))}</div>)}
      </section>;
    })}
    <AnchorDropdownPortal open={Boolean(menuSection)} anchorRef={menuAnchor} onClose={() => setMenu(null)} widthPx={210} className="glass-popover p-1">
      {menuSection && <div className="flex flex-col">
        <Button variant="ghost" size="xs" onClick={() => { setError(""); setDialog({ kind: "name", id: menuSection.id, name: menuSection.name }); setMenu(null); }}>Rename section</Button>
        <Button variant="ghost" size="xs" disabled={organization.sections[0]?.id === menuSection.id} onClick={() => reorder(menuSection.id, -1)}>Move up</Button>
        <Button variant="ghost" size="xs" disabled={organization.sections.at(-1)?.id === menuSection.id} onClick={() => reorder(menuSection.id, 1)}>Move down</Button>
        <Button variant="ghost" size="xs" onClick={() => { setError(""); setDialog({ kind: "delete", id: menuSection.id, name: menuSection.name }); setMenu(null); }}>Remove section</Button>
      </div>}
    </AnchorDropdownPortal>
    {dialog && <SidebarOrganizerDialog title={dialog.kind === "delete" ? `Remove ${dialog.name}?` : dialog.id ? "Rename section" : "New run section"} onClose={() => !busy && setDialog(null)}>
      {dialog.kind === "name" ? <SidebarSectionNameForm name={dialog.name} busy={busy} onClose={() => setDialog(null)}
        onSubmit={(name) => void mutate(() => dialog.id ? client.renameRunSection(dialog.id, name) : client.createRunSection(name), "Section saved.")} />
        : <><p className="mb-3 text-xs text-[var(--ec-muted)]">Its runs will return to Uncategorized. Runs, tags, and workspaces will be kept.</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" size="sm" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => void mutate(() => client.deleteRunSection(dialog.id), "Section removed. Runs returned to Uncategorized.")}>Remove section</Button></div></>}
      {errorContent}
    </SidebarOrganizerDialog>}
    {organizeRunId && canOrganize && <SidebarOrganizerDialog title="Organize run" onClose={() => !busy && onCloseOrganizer()}>
      <SidebarRunOrganizationForm key={organizeRunId} runId={organizeRunId} organization={organization} busy={busy} onClose={onCloseOrganizer}
        onSubmit={(sectionId, tags) => void mutate(() => client.updateRunOrganization(organizeRunId, { sectionId, tags }), "Run organization saved.")} />
      {errorContent}
    </SidebarOrganizerDialog>}
  </div>;
};
