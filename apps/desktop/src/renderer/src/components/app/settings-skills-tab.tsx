import { useEffect, useMemo, useState } from "react";
import type { IntegratedSkillDefinition } from "@easycode/shared";
import { Braces, CheckSquare, Layers3, X } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

export type SkillsSettingsTabProps = {
  skills: IntegratedSkillDefinition[];
  globallyDisabledSkillIds: string[];
  onDisabledSkillIdsChange: (skillIds: string[]) => void | Promise<void>;
};

type ExpandedSkillState = {
  skill: IntegratedSkillDefinition;
};

const SOURCE_LABELS: Record<IntegratedSkillDefinition["source"], string> = {
  openai: "OpenAI",
  angular: "Angular",
};

export const SkillsSettingsTab = ({
  skills,
  globallyDisabledSkillIds,
  onDisabledSkillIdsChange,
}: SkillsSettingsTabProps) => {
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
  const groups = filteredSkills.reduce<Record<IntegratedSkillDefinition["source"], IntegratedSkillDefinition[]>>(
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

  const openSkillPopup = (skill: IntegratedSkillDefinition) => {
    setExpandedSkill({ skill });
  };

  return (
    <>
    <div className="space-y-4">
      <Card className="overflow-auto p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">Integrated skills</p>
            <p className="mt-2 text-sm font-medium text-zinc-100">Global availability</p>
            <p className="mt-1 text-sm text-zinc-400">
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
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <div className="flex items-center gap-2 text-cyan-300">
              <Layers3 className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Catalog</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-zinc-100">{skills.length}</p>
            <p className="text-xs text-zinc-500">Integrated official skills</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <div className="flex items-center gap-2 text-cyan-300">
              <CheckSquare className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Enabled</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-zinc-100">{enabledCount}</p>
            <p className="text-xs text-zinc-500">Available to projects</p>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-3">
            <div className="flex items-center gap-2 text-cyan-300">
              <Braces className="h-4 w-4" />
              <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">Sources</p>
            </div>
            <p className="mt-2 text-lg font-semibold text-zinc-100">2</p>
            <p className="text-xs text-zinc-500">OpenAI and Angular</p>
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
              <p className="text-xs uppercase tracking-[0.25em] text-zinc-500">{SOURCE_LABELS[source]}</p>
              <p className="mt-1 text-sm text-zinc-400">
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
                    enabled ? "border-cyan-500/20 bg-cyan-500/5" : "border-zinc-800 bg-zinc-950/60"
                  }`}
                >
                  <input
                    className="mt-1 h-4 w-4 accent-cyan-400"
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-zinc-100">{skill.title}</p>
                        <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
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
                    <p className="mt-1 text-xs text-zinc-500">{skill.id}</p>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-400">{skill.description}</p>
                  </div>
                </div>
              );
            })}
            {groups[source].length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 px-3 py-6 text-sm text-zinc-500">
                No matching skills in this group.
              </div>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
    {expandedSkill ? createPortal(
      <>
      <div className="fixed inset-0 z-[24999] bg-black/35 backdrop-blur-[1px]" onClick={() => setExpandedSkill(null)} />
      <div className="fixed inset-0 z-[25000] flex items-center justify-center p-4" onClick={() => setExpandedSkill(null)}>
        <Card
          className="app-scrollbar flex max-h-[min(78vh,720px)] w-full max-w-5xl flex-col overflow-y-auto p-0 shadow-2xl shadow-black/55"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-zinc-800/90 bg-zinc-950/95 px-5 py-4 backdrop-blur">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-zinc-100">{expandedSkill.skill.title}</h3>
                <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                  {expandedSkill.skill.source}
                </span>
                <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                  {expandedSkill.skill.category}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{expandedSkill.skill.id}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setExpandedSkill(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Description</p>
              <p className="mt-2 text-sm leading-relaxed text-zinc-300">{expandedSkill.skill.description}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Skill body</p>
              <pre className="app-scrollbar mt-2 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 text-xs leading-6 text-zinc-300 whitespace-pre-wrap break-words">
                {expandedSkill.skill.content}
              </pre>
            </div>
          </div>
        </Card>
      </div>
      </>
    , document.body) : null}
    </>
  );
};
