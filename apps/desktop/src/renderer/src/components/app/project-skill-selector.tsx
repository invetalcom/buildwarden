import { useMemo, useRef, useState } from "react";
import type { IntegratedSkillMetadata } from "@buildwarden/shared";
import { Check, ChevronDown, X } from "lucide-react";
import { AnchorDropdownPortal } from "./anchor-dropdown-portal";

export type ProjectSkillSelectorProps = {
  skills: IntegratedSkillMetadata[];
  selectedSkillIds: string[];
  disabled?: boolean;
  onChange: (skillIds: string[]) => void | Promise<void>;
};

const selectedSkillsSummary = (skills: IntegratedSkillMetadata[]) => {
  if (skills.length === 0) {
    return "No project skills selected";
  }
  if (skills.length <= 2) {
    return skills.map((skill) => skill.title).join(", ");
  }
  return `${skills.length} skills selected`;
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
  const summary = selectedSkillsSummary(selectedSkills);

  const toggleSkill = (skillId: string) => {
    const next = new Set(selectedSkillIds);
    if (next.has(skillId)) {
      next.delete(skillId);
    } else {
      next.add(skillId);
    }
    void onChange([...next].sort((left, right) => left.localeCompare(right)));
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:flex-none" ref={anchorRef}>
          <button
            type="button"
            disabled={disabled || skills.length === 0}
            className="flex w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-[var(--ec-border)] bg-[var(--ec-panel)] px-3 py-2 text-left text-sm text-[var(--ec-text)] transition hover:border-[var(--ec-border-strong)] hover:bg-[var(--ec-hover)] disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-[18rem]"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <span className="min-w-0 truncate">{skills.length === 0 ? "No enabled skills available" : summary}</span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--ec-faint)] transition ${menuOpen ? "rotate-180" : ""}`} />
          </button>
          <AnchorDropdownPortal
            open={menuOpen && skills.length > 0}
            anchorRef={anchorRef}
            onClose={() => setMenuOpen(false)}
            align="start"
            widthPx={440}
            className="glass-popover overflow-hidden py-1"
          >
            <div className="app-scrollbar max-h-[24rem] overflow-y-auto p-1.5">
              {skills.map((skill) => {
                const selected = selectedSet.has(skill.id);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition ${
                      selected
                        ? "bg-[var(--ec-accent-soft)] text-[var(--ec-text)]"
                        : "text-[var(--ec-text)] hover:bg-[var(--ec-hover)]"
                    }`}
                    onClick={() => toggleSkill(skill.id)}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        selected
                          ? "border-[var(--ec-accent-ring)] bg-[var(--ec-accent-soft)] text-[var(--ec-accent)]"
                          : "border-[var(--ec-border)] bg-[var(--ec-panel)]"
                      }`}
                    >
                      {selected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{skill.title}</span>
                        <span className="rounded-full border border-[var(--ec-border)] bg-[var(--ec-panel-soft)] px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-[var(--ec-muted)]">
                          {skill.source}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-[var(--ec-muted)]">{skill.description}</span>
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
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--ec-border)] bg-[var(--ec-panel)] px-2.5 py-2 text-xs text-[var(--ec-muted)] transition hover:border-[var(--ec-border-strong)] hover:text-[var(--ec-text)]"
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
