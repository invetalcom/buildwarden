import {
  MAX_SIDEBAR_RUN_SECTIONS,
  SIDEBAR_RUN_SECTION_COLORS,
  SIDEBAR_RUN_SECTION_NAME_MAX_LENGTH,
  SIDEBAR_RUN_VIEWS,
  type SidebarRunSection,
  type SidebarRunSectionsConfig,
  type SidebarRunView,
} from "@buildwarden/shared";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Inbox, Layers, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { Separator } from "../ui/separator";
import { createSidebarRunSectionId, SIDEBAR_RUN_SECTION_COLOR_CLASSES, SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE } from "./sidebar-run-sections";

const SIDEBAR_RUN_VIEW_LABELS: Record<SidebarRunView, string> = {
  all: "All",
  active: "Active",
  done: "Done",
  failed: "Failed",
};

const UNCATEGORIZED_KEY = "uncategorized";

export interface SidebarRunSectionGroup {
  /** `null` is the built-in Uncategorized section. */
  section: SidebarRunSection | null;
  rootCount: number;
  rows: ReactNode[];
}

interface SidebarRunSectionsProps {
  projects: ReadonlyArray<{ id: string; name: string }>;
  projectScopeId: string | null;
  view: SidebarRunView;
  viewCounts: Record<SidebarRunView, number>;
  config: SidebarRunSectionsConfig;
  groups: SidebarRunSectionGroup[];
  recentRunWindowLabel: string;
  emptyMessage: string;
  canEditSections: boolean;
  canMoveRuns: boolean;
  groupGapClassName: string;
  rowGapClassName: string;
  onProjectScopeChange: (projectId: string | null) => void;
  onViewChange: (view: SidebarRunView) => void;
  onConfigChange: (config: SidebarRunSectionsConfig) => void;
  onMoveRun: (runId: string, sectionId: string | null) => void;
}

type SectionMenuState = { sectionId: string; x: number; y: number };

const hasSectionRunDrag = (event: ReactDragEvent<HTMLElement> | DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes(SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE);

const SectionNameInput = ({
  initialValue,
  placeholder,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) => {
  const [value, setValue] = useState(initialValue);
  const settledRef = useRef(false);
  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    if (commit && value.trim()) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      className="h-5 min-w-0 flex-1 rounded border border-[var(--ec-accent-ring)] bg-[var(--ec-input)] px-1.5 text-[12px] font-semibold text-[var(--ec-text)] outline-none"
      maxLength={SIDEBAR_RUN_SECTION_NAME_MAX_LENGTH}
      placeholder={placeholder}
      value={value}
      aria-label={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") settle(true);
        if (event.key === "Escape") settle(false);
      }}
      onBlur={() => settle(true)}
    />
  );
};

/** Run list area of the sidebar: project scope, status views, and drag-and-drop sections. */
export const SidebarRunSections = ({
  projects,
  projectScopeId,
  view,
  viewCounts,
  config,
  groups,
  recentRunWindowLabel,
  emptyMessage,
  canEditSections,
  canMoveRuns,
  groupGapClassName,
  rowGapClassName,
  onProjectScopeChange,
  onViewChange,
  onConfigChange,
  onMoveRun,
}: SidebarRunSectionsProps) => {
  const [headerMenu, setHeaderMenu] = useState<"scope" | "view" | null>(null);
  const [sectionMenu, setSectionMenu] = useState<SectionMenuState | null>(null);
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(null);
  const [creatingSection, setCreatingSection] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canMoveRuns) return;
    const handleDragStart = (event: DragEvent) => {
      if (hasSectionRunDrag(event)) setDragActive(true);
    };
    const handleDragEnd = () => {
      setDragActive(false);
      setDropTargetKey(null);
    };
    window.addEventListener("dragstart", handleDragStart);
    window.addEventListener("dragend", handleDragEnd);
    window.addEventListener("drop", handleDragEnd);
    return () => {
      window.removeEventListener("dragstart", handleDragStart);
      window.removeEventListener("dragend", handleDragEnd);
      window.removeEventListener("drop", handleDragEnd);
    };
  }, [canMoveRuns]);

  useEffect(() => {
    if (!headerMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) setHeaderMenu(null);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [headerMenu]);

  const scopeProject = projects.find((project) => project.id === projectScopeId) ?? null;
  const sections = config.sections;
  const updateSection = (sectionId: string, patch: Partial<SidebarRunSection>) =>
    onConfigChange({ ...config, sections: sections.map((section) => (section.id === sectionId ? { ...section, ...patch } : section)) });
  const moveSection = (sectionId: string, offset: -1 | 1) => {
    const index = sections.findIndex((section) => section.id === sectionId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onConfigChange({ ...config, sections: next });
  };
  const toggleCollapsed = (section: SidebarRunSection | null) => {
    if (section) updateSection(section.id, { collapsed: !section.collapsed });
    else onConfigChange({ ...config, uncategorizedCollapsed: !config.uncategorizedCollapsed });
  };
  const createSection = (name: string) => {
    setCreatingSection(false);
    if (sections.length >= MAX_SIDEBAR_RUN_SECTIONS) return;
    const color = SIDEBAR_RUN_SECTION_COLORS[sections.length % SIDEBAR_RUN_SECTION_COLORS.length] ?? "accent";
    onConfigChange({ ...config, sections: [...sections, { id: createSidebarRunSectionId(), name, color, collapsed: false }] });
  };

  const dropHandlers = (key: string, sectionId: string | null) =>
    canMoveRuns
      ? {
          onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
            if (!hasSectionRunDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTargetKey((current) => (current === key ? current : key));
          },
          onDragLeave: (event: ReactDragEvent<HTMLDivElement>) => {
            const related = event.relatedTarget;
            if (related instanceof Node && event.currentTarget.contains(related)) return;
            setDropTargetKey((current) => (current === key ? null : current));
          },
          onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
            const runId = event.dataTransfer.getData(SIDEBAR_SECTION_RUN_DRAG_MIME_TYPE);
            setDropTargetKey(null);
            setDragActive(false);
            if (!runId) return;
            event.preventDefault();
            onMoveRun(runId, sectionId);
          },
        }
      : {};

  const menuSection = sectionMenu ? sections.find((section) => section.id === sectionMenu.sectionId) ?? null : null;
  const menuSectionIndex = menuSection ? sections.indexOf(menuSection) : -1;
  const hasAnyRuns = groups.some((group) => group.rootCount > 0);

  return (
    <>
      <div ref={headerMenuRef} className="relative mb-1 flex h-6 min-w-0 items-center gap-1 px-3">
        <button
          type="button"
          className="mr-1 flex h-5 min-w-0 flex-1 items-center justify-between gap-1 rounded px-1 text-[11px] text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)]"
          onClick={() => setHeaderMenu((current) => (current === "scope" ? null : "scope"))}
          aria-expanded={headerMenu === "scope"}
          aria-label="Filter sidebar runs by project"
          title="Show runs from one project or all projects"
        >
          <span className="truncate">{scopeProject?.name ?? "All projects"}</span>
          <ChevronDown className={cn("size-3 shrink-0 transition", headerMenu === "scope" && "rotate-180")} />
        </button>
        <button
          type="button"
          className={cn(
            "flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded px-0.5 text-[11px] transition hover:bg-[var(--ec-hover)]",
            view === "all" ? "text-[var(--ec-muted)] hover:text-[var(--ec-text)]" : "bg-[var(--ec-accent-soft)] px-1 font-semibold text-[var(--ec-accent)]",
          )}
          onClick={() => setHeaderMenu((current) => (current === "view" ? null : "view"))}
          aria-expanded={headerMenu === "view"}
          aria-haspopup="menu"
          aria-label="Filter sidebar runs by status"
          title={view === "all" ? "Filter by status" : `Showing ${SIDEBAR_RUN_VIEW_LABELS[view]} runs`}
        >
          <Layers className="size-3.5 shrink-0" />
          {view === "all" ? null : <span>{SIDEBAR_RUN_VIEW_LABELS[view]}</span>}
        </button>
        {canEditSections ? (
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)] hover:text-[var(--ec-text)] disabled:opacity-40"
            onClick={() => setCreatingSection(true)}
            disabled={sections.length >= MAX_SIDEBAR_RUN_SECTIONS}
            aria-label="New section"
            title="New section"
          >
            <Plus className="size-3.5" />
          </button>
        ) : null}
        {headerMenu === "scope" ? (
          <div className="absolute left-2 right-2 top-full z-50 glass-popover max-h-72 overflow-y-auto py-1">
            {[{ id: null as string | null, name: "All projects" }, ...projects].map((project) => (
              <button
                key={project.id ?? "all"}
                type="button"
                className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
                onClick={() => {
                  setHeaderMenu(null);
                  onProjectScopeChange(project.id);
                }}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", project.id === projectScopeId ? "bg-[var(--ec-accent)]" : "bg-transparent")} />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {headerMenu === "view" ? (
          <div className="absolute right-2 top-full z-50 w-40 glass-popover py-1" role="menu" aria-label="Sidebar run status view">
            {SIDEBAR_RUN_VIEWS.map((option) => {
              const selected = option === view;
              return (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-sidebar-run-view={option}
                  className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-xs text-[var(--ec-text)] transition hover:bg-[var(--ec-hover)]"
                  onClick={() => {
                    setHeaderMenu(null);
                    onViewChange(option);
                  }}
                >
                  <Check className={cn("size-3 shrink-0 text-[var(--ec-accent)]", !selected && "invisible")} />
                  <span className={cn("min-w-0 flex-1 truncate", selected && "font-semibold")}>{SIDEBAR_RUN_VIEW_LABELS[option]}</span>
                  <span className="font-mono text-[10px] tabular-nums text-[var(--ec-faint)]">{viewCounts[option] > 99 ? "99+" : viewCounts[option]}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {!hasAnyRuns && sections.length === 0 && !creatingSection ? (
        <div className="px-3 py-2 text-xs text-[var(--ec-muted)]">{emptyMessage}</div>
      ) : (
        <div className={cn("px-2", groupGapClassName)}>
          {groups.map(({ section, rootCount, rows }) => {
            const key = section?.id ?? UNCATEGORIZED_KEY;
            const collapsed = section ? section.collapsed : config.uncategorizedCollapsed;
            // Filtered views hide empty sections, but every section stays a drop target during a drag.
            if (rootCount === 0 && view !== "all" && !dragActive) return null;
            const dropTarget = dropTargetKey === key;
            const renaming = section !== null && renamingSectionId === section.id;
            return (
              <div
                key={key}
                data-sidebar-run-section={key}
                className={cn(
                  // Borderless at rest; the outline only appears while the section is a drop target.
                  "group/section overflow-hidden rounded-lg border p-0.5 transition-colors",
                  dropTarget ? "border-[var(--ec-accent)] bg-[var(--ec-accent-soft)]" : "border-transparent",
                )}
                onContextMenu={(event) => {
                  if (!section || !canEditSections || renaming) return;
                  event.preventDefault();
                  setSectionMenu({ sectionId: section.id, x: event.clientX, y: event.clientY });
                }}
                {...dropHandlers(key, section?.id ?? null)}
              >
                <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-[var(--ec-muted)] transition hover:bg-[var(--ec-hover)]">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-[var(--ec-text)]"
                    onClick={() => toggleCollapsed(section)}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
                    {section ? (
                      <span className={cn("size-2 shrink-0 rounded-sm", SIDEBAR_RUN_SECTION_COLOR_CLASSES[section.color])} />
                    ) : (
                      <Inbox className="size-3 shrink-0 text-[var(--ec-faint)]" />
                    )}
                    {renaming ? (
                      <SectionNameInput
                        initialValue={section.name}
                        placeholder="Section name"
                        onCommit={(name) => {
                          setRenamingSectionId(null);
                          if (name !== section.name) updateSection(section.id, { name });
                        }}
                        onCancel={() => setRenamingSectionId(null)}
                      />
                    ) : (
                      <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--ec-text)]">{section?.name ?? "Uncategorized"}</span>
                    )}
                    {!section && !renaming ? (
                      <span className="min-w-0 truncate font-mono text-[10px] text-[var(--ec-faint)]" title={`Uncategorized runs leave the sidebar after ${recentRunWindowLabel}; runs in a section stay.`}>
                        {recentRunWindowLabel}
                      </span>
                    ) : null}
                  </button>
                  {section && canEditSections && !renaming ? (
                    <button
                      type="button"
                      className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--ec-muted)] opacity-0 transition hover:bg-[var(--ec-control)] hover:text-[var(--ec-text)] focus-visible:opacity-100 group-hover/section:opacity-100"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        setSectionMenu({ sectionId: section.id, x: rect.left, y: rect.bottom + 2 });
                      }}
                      aria-label={`Section options for ${section.name}`}
                      title="Section options"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  ) : null}
                  <span className="shrink-0 rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-1.5 py-0.5 font-mono text-[10px] leading-none text-[var(--ec-muted)]">
                    {rootCount}
                  </span>
                </div>
                {!collapsed ? (
                  rows.length > 0 ? (
                    <div className={cn("px-0.5 pb-0.5", rowGapClassName)}>{rows}</div>
                  ) : (
                    <div
                      className={cn(
                        "mx-0.5 mb-0.5 flex h-7 items-center justify-center rounded-md border border-dashed text-[10px]",
                        dropTarget ? "border-[var(--ec-accent)] text-[var(--ec-accent)]" : "border-[var(--ec-border)] text-[var(--ec-faint)]",
                      )}
                    >
                      {view !== "all" && !dragActive
                        ? "No matching runs"
                        : section
                          ? canMoveRuns ? "Drag runs here" : "No runs"
                          : "New runs land here"}
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
          {creatingSection ? (
            <div className="flex h-8 items-center gap-1.5 rounded-lg border border-[var(--ec-accent-ring)] bg-[var(--ec-panel-soft)] px-2">
              <span className={cn("size-2 shrink-0 rounded-sm", SIDEBAR_RUN_SECTION_COLOR_CLASSES[SIDEBAR_RUN_SECTION_COLORS[sections.length % SIDEBAR_RUN_SECTION_COLORS.length] ?? "accent"])} />
              <SectionNameInput initialValue="" placeholder="New section name" onCommit={createSection} onCancel={() => setCreatingSection(false)} />
            </div>
          ) : null}
        </div>
      )}

      {sectionMenu && menuSection
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-[30000]"
                onClick={() => setSectionMenu(null)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setSectionMenu(null);
                }}
                role="presentation"
              />
              <div className="fixed z-[30001] min-w-[11rem] glass-popover py-1" style={{ left: sectionMenu.x, top: sectionMenu.y }} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                  onClick={() => {
                    setRenamingSectionId(menuSection.id);
                    setSectionMenu(null);
                  }}
                >
                  <Pencil className="size-3.5" />
                  Rename
                </button>
                <div className="flex items-center gap-1.5 px-3 py-1.5" aria-label="Section color">
                  {SIDEBAR_RUN_SECTION_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={cn(
                        "size-3.5 rounded-sm transition",
                        SIDEBAR_RUN_SECTION_COLOR_CLASSES[color],
                        color === menuSection.color ? "ring-2 ring-[var(--ec-text)] ring-offset-1 ring-offset-[var(--ec-panel)]" : "opacity-70 hover:opacity-100",
                      )}
                      onClick={() => {
                        updateSection(menuSection.id, { color });
                        setSectionMenu(null);
                      }}
                      aria-label={`Use ${color} color`}
                      title={color}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  disabled={menuSectionIndex <= 0}
                  onClick={() => {
                    moveSection(menuSection.id, -1);
                    setSectionMenu(null);
                  }}
                >
                  <ArrowUp className="size-3.5" />
                  Move up
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-text)] hover:bg-[var(--ec-hover)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  disabled={menuSectionIndex >= sections.length - 1}
                  onClick={() => {
                    moveSection(menuSection.id, 1);
                    setSectionMenu(null);
                  }}
                >
                  <ArrowDown className="size-3.5" />
                  Move down
                </button>
                <Separator className="my-1" />
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ec-danger)] hover:bg-[var(--ec-danger-soft)]"
                  title="Runs in this section move back to Uncategorized"
                  onClick={() => {
                    onConfigChange({ ...config, sections: sections.filter((section) => section.id !== menuSection.id) });
                    setSectionMenu(null);
                  }}
                >
                  <Trash2 className="size-3.5" />
                  Delete section
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
};
