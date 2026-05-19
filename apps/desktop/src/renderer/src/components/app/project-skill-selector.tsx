import { useMemo, useRef, useState } from "react";
import type { IntegratedSkillDefinition } from "@easycode/shared";
import { Check, ChevronDown, X } from "lucide-react";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

export type ProjectSkillSelectorProps = {
  skills: IntegratedSkillDefinition[];
  selectedSkillIds: string[];
  disabled?: boolean;
  onChange: (skillIds: string[]) => void | Promise<void>;
};

export const ProjectSkillSelector = ({
  skills,
  selectedSkillIds,
  disabled,
  onChange,
}: ProjectSkillSelectorProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const selectedSkills = skills.filter((skill) => selectedSet.has(skill.id));
  const summary =
    selectedSkills.length === 0
      ? "No project skills selected"
      : selectedSkills.length <= 2
        ? selectedSkills.map((skill) => skill.title).join(", ")
        : `${selectedSkills.length} skills selected`;

  const toggleSkill = (skillId: string) => {
    const next = new Set(selectedSkillIds);
    if (next.has(skillId)) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    void onChange([...next].sort());
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative" ref={anchorRef}>
          <button
            type="button"
            disabled={disabled || skills.length === 0}
            className="flex min-w-[18rem] items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-left text-sm text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-900/70 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <span className="min-w-0 truncate">{skills.length === 0 ? "No enabled skills available" : summary}</span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition ${menuOpen ? "rotate-180" : ""}`} />
          </button>
          <AnchorDropdownPortal
            open={menuOpen && skills.length > 0}
            anchorRef={anchorRef}
            onClose={() => setMenuOpen(false)}
            align="start"
            widthPx={440}
            className="overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-950 py-1 shadow-xl shadow-black/40 ring-1 ring-cyan-500/10"
          >
            <div className="app-scrollbar max-h-[24rem] overflow-y-auto p-1.5">
              {skills.map((skill) => {
                const selected = selectedSet.has(skill.id);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition ${
                      selected ? "bg-cyan-500/10 text-cyan-50" : "text-zinc-200 hover:bg-zinc-800/80"
                    }`}
                    onClick={() => toggleSkill(skill.id)}
                  >
                    <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-cyan-400 bg-cyan-400/20" : "border-zinc-700 bg-zinc-900/80"}`}>
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{skill.title}</span>
                        <span className="rounded-full border border-zinc-700 bg-zinc-900/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                          {skill.source}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-zinc-400">{skill.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </AnchorDropdownPortal>
        </div>

        {selectedSkills.length > 0 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2.5 py-2 text-xs text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
            onClick={() => void onChange([])}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
};
