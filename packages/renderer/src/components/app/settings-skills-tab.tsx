import { useEffect, useMemo, useState } from "react";
import type { IntegratedSkillMetadata } from "@buildwarden/shared";
import { Braces, CheckSquare, Layers3, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { useBuildWardenClient } from "../../lib/buildwarden-client";

export type SkillsSettingsTabProps = {
  skills: IntegratedSkillMetadata[];
  globallyDisabledSkillIds: string[];
  onDisabledSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
};

type ExpandedSkillState = {
  skill: IntegratedSkillMetadata;
  /** Loaded lazily over IPC; null while the request is in flight. */
  content: string | null;
};

const SOURCE_LABELS: Record<IntegratedSkillMetadata["source"], string> = {
  openai: "OpenAI",
  angular: "Angular",
};

const ExpandedSkillModal = ({ state, onClose }: { state: ExpandedSkillState | null; onClose: () => void }) => {
  if (!state) {
    return null;
  }
  return createPortal(
    <>
      <div className="fixed inset-0 z-[24999] bg-black/35 backdrop-blur-md" onClick={onClose} />
      <div className="fixed inset-0 z-[25000] flex items-center justify-center p-4" onClick={onClose}>
        <Card className="app-scrollbar flex max-h-[min(78vh,720px)] w-full max-w-5xl flex-col overflow-y-auto p-0 shadow-[var(--ec-popover-shadow)]" onClick={(event) => event.stopPropagation()}>
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--ec-border)] bg-[var(--ec-panel)] px-5 py-4 backdrop-blur">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-[var(--ec-text)]">{state.skill.title}</h3>
                <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">{state.skill.source}</span>
                <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">{state.skill.category}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--ec-muted)]">{state.skill.id}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-[var(--ec-muted)]">Description</p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ec-text)]">{state.skill.description}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-[var(--ec-muted)]">Skill body</p>
              <pre className="app-scrollbar mt-2 overflow-x-auto rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] p-4 text-xs leading-6 text-[var(--ec-text)] whitespace-pre-wrap break-words">
                {state.content ?? "Loading skill body..."}
              </pre>
            </div>
          </div>
        </Card>
      </div>
    </>,
    document.body,
  );
};

export const SkillsSettingsTab = ({
  skills,
  globallyDisabledSkillIds,
  onDisabledSkillIdsChange,
}: SkillsSettingsTabProps) => {
  const buildwarden = useBuildWardenClient();
  const [search, setSearch] = useState("");
  const [expandedSkill, setExpandedSkill] = useState<ExpandedSkillState | null>(null);
  const visibleSkillIds = useMemo(() => new Set(skills.map((skill) => skill.id)), [skills]);
  const normalizedDisabledSkillIds = useMemo(
    () => globallyDisabledSkillIds.filter((skillId) => visibleSkillIds.has(skillId)),
    [globallyDisabledSkillIds, visibleSkillIds],
  );
  const disabled = new Set(normalizedDisabledSkillIds);
  const enabledCount = skills.length - normalizedDisabledSkillIds.length;
  const hasEnabledSkills = enabledCount > 0;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredSkills = useMemo(
    () =>
      normalizedSearch
        ? skills.filter((skill) =>
            [skill.title, skill.name, skill.id, skill.description, skill.source, skill.category].some((value) =>
              value.toLowerCase().includes(normalizedSearch),
            ),
          )
        : skills,
    [normalizedSearch, skills],
  );
  const groups = filteredSkills.reduce<Record<IntegratedSkillMetadata["source"], IntegratedSkillMetadata[]>>(
    (acc, skill) => {
      acc[skill.source] ??= [];
      acc[skill.source].push(skill);
      return acc;
    },
    { openai: [], angular: [] },
  );

  const toggleSkill = (skillId: string, enabled: boolean) => {
    const next = new Set(normalizedDisabledSkillIds);
    if (enabled) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    void onDisabledSkillIdsChange([...next]);
  };

  useEffect(() => {
    if (!expandedSkill) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpandedSkill(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedSkill]);

  const openSkillPopup = (skill: IntegratedSkillMetadata) => {
    setExpandedSkill({ skill, content: null });
    void buildwarden
      .getIntegratedSkillContent(skill.id)
      .then((content) => {
        setExpandedSkill((current) =>
          current && current.skill.id === skill.id ? { ...current, content: content ?? "Skill body unavailable." } : current,
        );
      })
      .catch(() => {
        setExpandedSkill((current) =>
          current && current.skill.id === skill.id ? { ...current, content: "Skill body unavailable." } : current,
        );
      });
  };

  return (
    <>
    <div className="space-y-4">
      <Card className="overflow-auto p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">Integrated skills</p>
            <p className="mt-2 text-sm font-medium text-[var(--ec-text)]">Global availability</p>
            <p className="mt-1 text-sm text-[var(--ec-muted)]">
              Enable the official OpenAI and Angular skills that projects can choose from. Disabled skills disappear from project
              selection and are not injected into agent runs.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void onDisabledSkillIdsChange(hasEnabledSkills ? skills.map((skill) => skill.id) : [])}
            >
              {hasEnabledSkills ? "Disable all" : "Enable all"}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-3">
            <div className="flex items-center gap-2 text-[var(--ec-accent)]">
              <Layers3 className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--ec-muted)]">Catalog</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-[var(--ec-text)]">{skills.length}</p>
            <p className="text-xs text-[var(--ec-muted)]">Integrated official skills</p>
          </div>
          <div className="rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-3">
            <div className="flex items-center gap-2 text-[var(--ec-accent)]">
              <CheckSquare className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--ec-muted)]">Enabled</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-[var(--ec-text)]">{enabledCount}</p>
            <p className="text-xs text-[var(--ec-muted)]">Available to projects</p>
          </div>
          <div className="rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-3">
            <div className="flex items-center gap-2 text-[var(--ec-accent)]">
              <Braces className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--ec-muted)]">Sources</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-[var(--ec-text)]">2</p>
            <p className="text-xs text-[var(--ec-muted)]">OpenAI and Angular</p>
          </div>
        </div>

        <div className="mt-4">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search skills by name, id, source, category, or description"
          />
        </div>
      </Card>

      {(["openai", "angular"] as const).map((source) => (
        <Card key={source} className="overflow-auto p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.25em] text-[var(--ec-muted)]">{SOURCE_LABELS[source]}</p>
              <p className="mt-1 text-sm text-[var(--ec-muted)]">
                {groups[source].length} integrated {groups[source].length === 1 ? "skill" : "skills"}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3">
            {groups[source].map((skill) => {
              const enabled = !disabled.has(skill.id);
              return (
                <div
                  key={skill.id}
                  className={`flex items-start gap-3 rounded-xl border px-3 py-3 transition ${
                    enabled ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)]" : "border-[var(--ec-border)] bg-[var(--ec-panel)]"
                  }`}
                >
                  <input
                    className="mt-1 h-4 w-4 accent-[var(--ec-accent)]"
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-[var(--ec-text)]">{skill.title}</p>
                        <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">
                          {skill.category}
                        </span>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-8 shrink-0 px-3 text-xs"
                        onClick={() => openSkillPopup(skill)}
                      >
                        View more
                      </Button>
                    </div>
                    <p className="mt-1 text-xs text-[var(--ec-muted)]">{skill.id}</p>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--ec-muted)]">{skill.description}</p>
                  </div>
                </div>
              );
            })}
            {groups[source].length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-6 text-sm text-[var(--ec-muted)]">
                No matching skills in this group.
              </div>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
    <ExpandedSkillModal state={expandedSkill} onClose={() => setExpandedSkill(null)} />
    </>
  );
};
