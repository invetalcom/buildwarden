import { InstanceBadge, useInstanceContext } from "../../lib/instance-context";
import { parseScopedId } from "../../lib/instance-identity";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Tag } from "lucide-react";
import { DEFAULT_RUN_SECTION_COLOR, UNCATEGORIZED_RUN_SECTION_ID, type AppSnapshot, type RunOrganizationSnapshot, type SidebarRunEntrySize } from "@buildwarden/shared";
import { useBuildWardenClient } from "../../lib/buildwarden-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { AnchorDropdownPortal } from "../ui/dropdown-portal";
import { parseRunDragPayload, RUN_DRAG_MIME_TYPE } from "./app-model";
import type { RunHierarchyRow } from "./run-hierarchy";
import { buildSidebarRunSections, EMPTY_RUN_ORGANIZATION, SIDEBAR_RUN_VIEWS, type SidebarRunView } from "./sidebar-run-sections";
import { SidebarOrganizerDialog, SidebarRunOrganizationForm, SidebarSectionColorForm, SidebarSectionNameForm } from "./SidebarRunOrganizer";
import { SidebarRunViewFilter } from "./SidebarRunViewFilter";
import { SidebarRunFilterMenu } from "./SidebarRunFilterMenu";

const PREFERENCE_KEY = "buildwarden:sidebar-run-sections";
const SECTION_HEADER_STYLES: Record<SidebarRunEntrySize, { button: string; title: string; icon: string; dot: string; count: string }> = {
  small: { button: "h-6 gap-1 px-1", title: "text-[11px] leading-[0.875rem]", icon: "size-3", dot: "size-1.5", count: "h-4 min-w-4 text-[9px]" },
  medium: { button: "h-7 gap-1.5 px-1.5", title: "text-[12px] leading-4", icon: "size-3.5", dot: "size-2", count: "h-[18px] min-w-[18px] text-[10px]" },
  large: { button: "h-8 gap-2 px-2", title: "text-[13px] leading-[1.125rem]", icon: "size-4", dot: "size-2.5", count: "h-5 min-w-5 text-[11px]" },
};
type Preferences = { view: SidebarRunView; projectId: string; tag: string; collapsed: string[]; includeOlderRuns: boolean };
const readPreferences = (): Preferences => {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? "null") as Partial<Preferences> | null;
    return { view: SIDEBAR_RUN_VIEWS.some((view) => view.id === value?.view) ? value!.view! : "all",
      projectId: typeof value?.projectId === "string" ? value.projectId : "",
      tag: typeof value?.tag === "string" ? value.tag : "",
      includeOlderRuns: value?.includeOlderRuns === true,
      collapsed: Array.isArray(value?.collapsed) ? value.collapsed.filter((id): id is string => typeof id === "string") : [] };
  } catch { return { view: "all", projectId: "", tag: "", collapsed: [], includeOlderRuns: false }; }
};

type SectionDialog = ({ kind: "name"; id?: string; name: string } | { kind: "delete"; id: string; name: string }
  | { kind: "color"; id: string; name: string; color: string }) & { returnFocusTo?: HTMLElement | null };

const emptySectionMessage = ({ view, tag, hideActiveRuns, hiddenOlderRunCount, canOrganize, showHeader }: {
  view: SidebarRunView; tag: string; hideActiveRuns: boolean; hiddenOlderRunCount: number; canOrganize: boolean; showHeader: boolean;
}) => {
  if (hideActiveRuns && view === "all" && !tag) return "No inactive runs.";
  if (view !== "all" || tag || hideActiveRuns) return "No matching runs.";
  if (hiddenOlderRunCount > 0) return "No runs in this window.";
  if (!canOrganize) return "No runs.";
  return showHeader ? "Drag runs here" : "Drop runs here to uncategorize";
};

const sectionDialogTitle = (dialog: SectionDialog) => {
  if (dialog.kind === "color") return `${dialog.name} color`;
  if (dialog.kind === "delete") return `Remove ${dialog.name}?`;
  return dialog.id ? "Rename section" : "New run section";
};

export interface SidebarRunSectionsProps {
  projects: AppSnapshot["projects"];
  organization?: RunOrganizationSnapshot;
  onOrganizationChange?: (organization: RunOrganizationSnapshot) => void;
  recentRunDays: number;
  hideActiveRuns: boolean;
  groupRunsByProject: boolean;
  uncategorizedFirst?: boolean;
  uncategorizedSection?: boolean;
  runRowGapClassName?: string;
  runEntrySize?: SidebarRunEntrySize;
  onSelectProject?: (projectId: string) => void;
  expandedRunIds: ReadonlySet<string>;
  highlightedRunId: string | null;
  organizeRunId: string | null;
  organizerReturnFocusTo?: HTMLElement | null;
  onCloseOrganizer: () => void;
  renderRun: (project: AppSnapshot["projects"][number], row: RunHierarchyRow, showProject: boolean) => ReactNode;
}

export const SidebarRunSections = ({ projects, organization = EMPTY_RUN_ORGANIZATION, onOrganizationChange,
  recentRunDays, hideActiveRuns, groupRunsByProject, runRowGapClassName = "space-y-0.5", onSelectProject, expandedRunIds, highlightedRunId, organizeRunId,
  onCloseOrganizer, organizerReturnFocusTo, renderRun, uncategorizedFirst = false, uncategorizedSection = true, runEntrySize = "medium" }: SidebarRunSectionsProps) => {
  const headerStyles = SECTION_HEADER_STYLES[runEntrySize];
  const client = useBuildWardenClient();
  const instances = useInstanceContext();
  const canOrganize = client.capabilities.runListVisibilityMutations && organization !== EMPTY_RUN_ORGANIZATION;
  const [preferences, setPreferences] = useState(readPreferences);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const preferencesRef = useRef(preferences);
  const [automaticallyExpandedSections, setAutomaticallyExpandedSections] = useState<Set<string>>(() => new Set());
  const sectionToggleVersions = useRef(new Map<string, number>());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<SectionDialog | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const newSectionButton = useRef<HTMLButtonElement>(null);
  const openSectionDialog = (next: SectionDialog, returnFocusTo: HTMLElement | null) => {
    setError(""); setDialog({ ...next, returnFocusTo }); setMenu(null);
  };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const projectId = projects.some((entry) => entry.project.id === preferences.projectId) ? preferences.projectId : "";
  const filteredProjects = useMemo(() => projectId ? projects.filter((entry) => entry.project.id === projectId) : projects, [projects, projectId]);
  const allTags = useMemo(() => [...new Set(organization.runs.flatMap((run) => run.tags))].sort((left, right) => left.localeCompare(right)), [organization]);
  const tag = allTags.includes(preferences.tag) ? preferences.tag : "";
  const sections = useMemo(() => buildSidebarRunSections({ projects: filteredProjects, organization, view: preferences.view,
    tag, hideActiveRuns, recentDays: recentRunDays, expandedRunIds, uncategorizedFirst, includeOlderRuns: preferences.includeOlderRuns, now }),
  [filteredProjects, organization, preferences.view, preferences.includeOlderRuns, tag, hideActiveRuns, recentRunDays, expandedRunIds, uncategorizedFirst, now]);
  const counts = useMemo(() => Object.fromEntries(SIDEBAR_RUN_VIEWS.map(({ id }) => [id,
    buildSidebarRunSections({ projects: filteredProjects, organization, view: id, tag, hideActiveRuns, recentDays: recentRunDays,
      expandedRunIds: new Set(), includeOlderRuns: preferences.includeOlderRuns, now }).reduce((count, section) => count + section.count, 0)])),
  [filteredProjects, organization, tag, hideActiveRuns, recentRunDays, preferences.includeOlderRuns, now]);
  const updatePreferences = (patch: Partial<Preferences> | ((current: Preferences) => Partial<Preferences>)) => {
    const current = preferencesRef.current;
    const next = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
    preferencesRef.current = next;
    setPreferences(next);
    // This state/ref contains only saved preferences, never automatic expansion.
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next)); } catch { /* Storage may be disabled. */ }
  };
  const toggleSection = (id: string, collapsed: boolean) => {
    sectionToggleVersions.current.set(id, (sectionToggleVersions.current.get(id) ?? 0) + 1);
    setAutomaticallyExpandedSections((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current); next.delete(id); return next;
    });
    updatePreferences((current) => {
      const next = new Set(current.collapsed);
      if (collapsed) next.delete(id);
      else next.add(id);
      return { collapsed: [...next] };
    });
  };
  const highlightedSectionId = organization.runs.find((run) => run.runId === highlightedRunId)?.sectionId ?? UNCATEGORIZED_RUN_SECTION_ID;
  const highlightedProjectId = projects.find((entry) => [...entry.runs, ...entry.orchestratedRuns].some((run) => run.id === highlightedRunId))?.project.id;

  useEffect(() => {
    if (!highlightedRunId) return;
    const sectionId = highlightedSectionId;
    setAutomaticallyExpandedSections((current) => current.has(sectionId) ? current : new Set(current).add(sectionId));
    if (highlightedProjectId) setCollapsedProjects((current) => {
      const key = `${sectionId}:${highlightedProjectId}`;
      if (!current.has(key)) return current;
      const next = new Set(current); next.delete(key); return next;
    });
  }, [highlightedRunId, highlightedSectionId, highlightedProjectId]);

  const mutate = async (operation: () => Promise<RunOrganizationSnapshot>, message: string, onSuccess?: () => void) => {
    if (!canOrganize || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await operation();
      onOrganizationChange?.(next);
      onSuccess?.();
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
    const preferencesAtDrop = preferencesRef.current;
    const destinationToggleVersion = sectionToggleVersions.current.get(sectionId) ?? 0;
    void mutate(() => client.updateRunOrganization(payload.runId, { sectionId: target }), `Run moved to ${name}.`, () => {
      // Reveal the saved move without undoing choices made while it was pending.
      updatePreferences((current) => ({
        // A manual collapse of an automatically expanded section may leave its
        // saved collapse unchanged, so track explicit toggles rather than values.
        collapsed: (sectionToggleVersions.current.get(sectionId) ?? 0) === destinationToggleVersion
          ? current.collapsed.filter((id) => id !== sectionId) : current.collapsed,
        view: current.view === preferencesAtDrop.view ? "all" : current.view,
        tag: current.tag === preferencesAtDrop.tag ? "" : current.tag,
        projectId: current.projectId === preferencesAtDrop.projectId && current.projectId !== payload.projectId ? "" : current.projectId,
      }));
    });
  };
  const reorder = (id: string, offset: number) => {
    const ids = organization.sections.map((section) => section.id);
    const index = ids.indexOf(id);
    if (index < 0 || index + offset < 0 || index + offset >= ids.length) return;
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    setMenu(null);
    void mutate(() => client.reorderRunSections(ids), "Section order updated.");
  };
  const menuSection = sections.find((section) => section.id === menu && (uncategorizedSection || section.id !== UNCATEGORIZED_RUN_SECTION_ID));
  const errorContent = error ? <p role="alert" className="my-2 text-xs text-[var(--ec-danger)]">{error}</p> : null;

  return <div className="space-y-1.5 px-2" aria-busy={busy}>
    <div className="flex items-center gap-1 px-1">
      <Select ariaLabel="Filter runs by project" value={projectId} onValueChange={(nextProjectId) => updatePreferences({ projectId: nextProjectId })}
        className="min-w-0 flex-1" triggerClassName={cn("h-6 rounded border-0 bg-transparent px-1 text-xs hover:bg-[var(--ec-hover)]",
          projectId && "bg-[var(--ec-accent-soft)]")}
        optionClassName="px-2 py-1.5 text-xs" maxMenuHeightPx={280}
        searchable={projects.length > 8} searchPlaceholder="Find project…" searchAriaLabel="Find project"
        options={[{ value: "", label: "All projects" }, ...projects.map((entry) => ({ value: entry.project.id, label: `${entry.project.name}${instances ? ` ? ${instances.instances.find((host) => host.id === parseScopedId(entry.project.id)?.instanceId)?.label ?? "Unknown instance"}` : ""}` }))]} />
      <SidebarRunViewFilter value={preferences.view} counts={counts} includeOlderRuns={preferences.includeOlderRuns}
        onIncludeOlderRunsChange={(includeOlderRuns) => updatePreferences({ includeOlderRuns })}
        onChange={(view) => updatePreferences({ view })} />
      <SidebarRunFilterMenu value={tag} onChange={(nextTag) => updatePreferences({ tag: nextTag })} icon={Tag}
        label="Filter runs by tag" menuLabel="Run tags" active={Boolean(tag)} width={220}
        options={[{ id: "", label: "All tags" }, ...allTags.map((value) => ({ id: value, label: `#${value}` }))]} />
      {canOrganize && <Button ref={newSectionButton} size="icon" variant="ghost" className="h-6 w-6" aria-label="New run section" disabled={busy}
        onClick={(event) => openSectionDialog({ kind: "name", name: "" }, event.currentTarget)}><Plus className="size-3.5" /></Button>}
    </div>
    {!dialog && !organizeRunId && errorContent}
    <span role="status" className="sr-only">{announcement}</span>
    {sections.map((section) => {
      const showHeader = uncategorizedSection || section.id !== UNCATEGORIZED_RUN_SECTION_ID;
      const collapsed = showHeader && preferences.collapsed.includes(section.id) && !automaticallyExpandedSections.has(section.id);
      const title = section.id === UNCATEGORIZED_RUN_SECTION_ID ? `${section.name} (${recentRunDays} ${recentRunDays === 1 ? "day" : "days"})` : section.name;
      return <section key={section.id} aria-label={showHeader ? `${section.name} run section` : "Uncategorized runs"} data-run-section={section.id}
        className={cn("group/section rounded-md p-0.5", dropTarget === section.id && "bg-[var(--ec-accent-soft)]")}
        onDragOver={(event) => { if (acceptsDrag(event)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(section.id); } }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(null); }}
        onDrop={(event) => dropRun(event, section.id, section.name)}>
        {showHeader && <div className="mb-0.5 flex items-center gap-1 pr-1">
          <button type="button" aria-expanded={!collapsed} aria-label={`${title}, ${section.count} runs`} className={cn("flex min-w-0 flex-1 items-center text-left text-[var(--ec-text)]", headerStyles.button)}
            onClick={() => toggleSection(section.id, collapsed)}>
            {collapsed ? <ChevronRight className={cn("shrink-0", headerStyles.icon)} /> : <ChevronDown className={cn("shrink-0", headerStyles.icon)} />}
            <span aria-hidden="true" data-section-color={section.color} className={cn("shrink-0 rounded-full ring-1 ring-inset ring-black/15", headerStyles.dot)} style={{ backgroundColor: section.color }} />
            <span className={cn("ml-0.5 min-w-0 flex-1 truncate font-semibold", headerStyles.title)}>{title}</span><InstanceBadge entityId={section.id} />
          </button>
          {canOrganize && <button type="button" ref={menu === section.id ? menuAnchor : undefined}
            aria-label={`Manage ${section.name} section`} aria-expanded={menu === section.id} disabled={busy}
            className={cn("shrink-0 rounded p-1 text-[var(--ec-muted)] transition-opacity hover:bg-[var(--ec-hover)]",
              "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100 [@media(hover:none)]:opacity-100",
              menu === section.id && "opacity-100")}
            onClick={() => setMenu(menu === section.id ? null : section.id)}><MoreHorizontal className={headerStyles.icon} /></button>}
          <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-1 font-mono leading-none text-[var(--ec-muted)]", headerStyles.count)}>{section.count}</span>
        </div>}
        {!collapsed && (section.count === 0 ? <p className="flex min-h-7 items-center justify-center rounded-xl border border-dashed border-[var(--ec-border)] px-2 py-1 text-center text-[10px] text-[var(--ec-muted)]">
          {emptySectionMessage({ view: preferences.view, tag, hideActiveRuns, hiddenOlderRunCount: section.hiddenOlderRunCount, canOrganize, showHeader })}
        </p> : groupRunsByProject ? section.groups.map(({ project, rows, count }) => {
          const key = `${section.id}:${project.project.id}`;
          const projectExpanded = !collapsedProjects.has(key);
          return <div key={key} data-sidebar-run-group={project.project.id}>
            <button type="button" aria-expanded={projectExpanded} className="flex h-6 w-full min-w-0 items-center gap-1 px-2 text-left text-[var(--ec-muted)]"
              onDoubleClick={() => onSelectProject?.(project.project.id)}
              onClick={() => setCollapsedProjects((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}>
              {projectExpanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              <span className={cn("min-w-0 flex-1 truncate font-medium", headerStyles.title)}>{project.project.name}</span><span className="font-mono text-[10px]">{count}</span>
            </button>
            {projectExpanded && <div className={runRowGapClassName}>{rows.map((row) => renderRun(project, row, false))}</div>}
          </div>;
        }) : <div className={runRowGapClassName}>{section.flatRows.map(({ project, row }) => renderRun(project, row, true))}</div>)}
        {!collapsed && section.id === UNCATEGORIZED_RUN_SECTION_ID && (section.hiddenOlderRunCount > 0 || preferences.includeOlderRuns) &&
          <button type="button" className="mt-1 w-full rounded px-2 py-1 text-left text-[10px] text-[var(--ec-muted)] hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
            onClick={() => updatePreferences({ includeOlderRuns: !preferences.includeOlderRuns })}>
            {preferences.includeOlderRuns ? "Hide older runs" : "Show older runs"}
          </button>}
      </section>;
    })}
    <AnchorDropdownPortal open={Boolean(menuSection)} anchorRef={menuAnchor} onClose={() => setMenu(null)} widthPx={210} className="glass-popover p-1">
      {menuSection && <div className="flex flex-col">
        <Button variant="ghost" size="xs" onClick={() => openSectionDialog({ kind: "color", id: menuSection.id, name: menuSection.name, color: menuSection.color }, menuAnchor.current)}>Change color</Button>
        {menuSection.id !== UNCATEGORIZED_RUN_SECTION_ID && <>
        <Button variant="ghost" size="xs" onClick={() => openSectionDialog({ kind: "name", id: menuSection.id, name: menuSection.name }, menuAnchor.current)}>Rename section</Button>
        <Button variant="ghost" size="xs" disabled={organization.sections[0]?.id === menuSection.id} onClick={() => reorder(menuSection.id, -1)}>Move up</Button>
        <Button variant="ghost" size="xs" disabled={organization.sections.at(-1)?.id === menuSection.id} onClick={() => reorder(menuSection.id, 1)}>Move down</Button>
        <Button variant="ghost" size="xs" onClick={() => openSectionDialog({ kind: "delete", id: menuSection.id, name: menuSection.name }, menuAnchor.current)}>Remove section</Button>
        </>}
      </div>}
    </AnchorDropdownPortal>
    {dialog && <SidebarOrganizerDialog returnFocusTo={dialog.returnFocusTo} fallbackFocusRef={newSectionButton}
      title={sectionDialogTitle(dialog)} onClose={() => !busy && setDialog(null)}>
      {dialog.kind === "color" ? <SidebarSectionColorForm color={dialog.color} busy={busy} onClose={() => setDialog(null)}
        onSubmit={(color) => void mutate(() => client.setRunSectionColor(dialog.id, color), "Section color saved.")} />
        : null}
      {dialog.kind === "name" ? <SidebarSectionNameForm name={dialog.name} color={dialog.id ? undefined : DEFAULT_RUN_SECTION_COLOR} busy={busy} onClose={() => setDialog(null)}
        onSubmit={(name, color) => void mutate(() => dialog.id ? client.renameRunSection(dialog.id, name) : client.createRunSection(name, color), "Section saved.")} />
        : null}
      {dialog.kind === "delete" ? <><p className="mb-3 text-xs text-[var(--ec-muted)]">Its runs will return to Uncategorized. Runs, tags, and workspaces will be kept.</p>
          <div className="flex justify-end gap-2"><Button variant="secondary" size="sm" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
            <Button size="sm" disabled={busy} onClick={() => void mutate(() => client.deleteRunSection(dialog.id), "Section removed. Runs returned to Uncategorized.")}>Remove section</Button></div></> : null}
      {errorContent}
    </SidebarOrganizerDialog>}
    {organizeRunId && canOrganize && <SidebarOrganizerDialog title="Organize run" returnFocusTo={organizerReturnFocusTo} fallbackFocusRef={newSectionButton} onClose={() => !busy && onCloseOrganizer()}>
      <SidebarRunOrganizationForm key={organizeRunId} runId={organizeRunId} organization={organization} busy={busy} onClose={onCloseOrganizer}
        onSubmit={(sectionId, tags) => void mutate(() => client.updateRunOrganization(organizeRunId, { sectionId, tags }), "Run metadata saved.")} />
      {errorContent}
    </SidebarOrganizerDialog>}
  </div>;
};
