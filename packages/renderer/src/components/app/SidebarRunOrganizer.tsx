import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_RUN_SECTION_COLOR, isRunSectionColor, RUN_SECTION_NAME_LIMIT, RUN_TAG_COUNT_LIMIT, RUN_TAG_LIMIT, UNCATEGORIZED_RUN_SECTION_ID, type RunOrganizationSnapshot } from "@buildwarden/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { SidebarSectionColorPicker } from "./SidebarSectionColorPicker";

/** Native dialog supplies focus trapping and Escape handling in both shells. */
export const SidebarOrganizerDialog = ({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return createPortal(<dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose} aria-labelledby={titleId}
    className="fixed inset-0 m-auto w-[min(26rem,95vw)] rounded-xl border border-[var(--ec-border)] bg-[var(--ec-dialog-bg)] p-4 text-[var(--ec-text)] shadow-xl backdrop:bg-black/50">
    <h2 id={titleId} className="mb-3 text-sm font-semibold">{title}</h2>{children}
  </dialog>, document.body);
};

export const SidebarSectionNameForm = ({ name, color, busy, onSubmit, onClose }: {
  name: string; color?: string; busy: boolean; onSubmit: (name: string, color?: string) => void; onClose: () => void;
}) => {
  const [value, setValue] = useState(name);
  const [selectedColor, setSelectedColor] = useState(color ?? DEFAULT_RUN_SECTION_COLOR);
  const valid = color === undefined || isRunSectionColor(selectedColor);
  return <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSubmit(value, color === undefined ? undefined : selectedColor); }} className="space-y-3">
    <Input aria-label="Section name" value={value} maxLength={RUN_SECTION_NAME_LIMIT} autoFocus required onChange={(event) => setValue(event.target.value)} />
    {color !== undefined && <SidebarSectionColorPicker value={selectedColor} onChange={setSelectedColor} disabled={busy} />}
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button size="sm" disabled={busy || !value.trim() || !valid}>Save section</Button></div>
  </form>;
};

export const SidebarSectionColorForm = ({ color, busy, onSubmit, onClose }: {
  color: string; busy: boolean; onSubmit: (color: string) => void; onClose: () => void;
}) => {
  const [value, setValue] = useState(color);
  return <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (isRunSectionColor(value) && !busy) onSubmit(value); }}>
    <SidebarSectionColorPicker value={value} onChange={setValue} disabled={busy} />
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" disabled={busy || !isRunSectionColor(value)}>Save color</Button></div>
  </form>;
};

export const SidebarRunOrganizationForm = ({ runId, organization, busy, onSubmit, onClose }: {
  runId: string; organization: RunOrganizationSnapshot; busy: boolean;
  onSubmit: (sectionId: string | null, tags: string[]) => void; onClose: () => void;
}) => {
  const record = organization.runs.find((entry) => entry.runId === runId);
  const [sectionId, setSectionId] = useState(record?.sectionId ?? UNCATEGORIZED_RUN_SECTION_ID);
  const [tags, setTags] = useState(record?.tags.join(", ") ?? "");
  const tagsHelpId = useId();
  const tagsErrorId = useId();
  const parsedTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  const tagsError = parsedTags.length > RUN_TAG_COUNT_LIMIT ? `Use at most ${RUN_TAG_COUNT_LIMIT} tags per run.`
    : parsedTags.some((tag) => tag.length > RUN_TAG_LIMIT) ? `Each tag can have at most ${RUN_TAG_LIMIT} characters.` : "";
  return <form className="space-y-3" onSubmit={(event) => {
    event.preventDefault();
    if (!busy && !tagsError) onSubmit(sectionId === UNCATEGORIZED_RUN_SECTION_ID ? null : sectionId, parsedTags);
  }}>
    <label className="block space-y-1 text-xs">Section<Select ariaLabel="Run section" value={sectionId} onValueChange={setSectionId}
      options={[{ value: UNCATEGORIZED_RUN_SECTION_ID, label: "Uncategorized" }, ...organization.sections.map((section) => ({ value: section.id, label: section.name }))]} /></label>
    <label className="block space-y-1 text-xs">Tags<Input aria-label="Run tags" placeholder="auth, bug, release" value={tags} onChange={(event) => setTags(event.target.value)}
      aria-invalid={Boolean(tagsError)} aria-describedby={tagsError ? `${tagsHelpId} ${tagsErrorId}` : tagsHelpId} /></label>
    <p id={tagsHelpId} className="text-xs text-[var(--ec-muted)]">Separate tags with commas. Up to {RUN_TAG_COUNT_LIMIT} tags, {RUN_TAG_LIMIT} characters each.</p>
    {tagsError && <p id={tagsErrorId} role="alert" className="text-xs text-[var(--ec-danger)]">{tagsError}</p>}
    <div className="flex justify-end gap-2"><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" disabled={busy || Boolean(tagsError)}>Save run metadata</Button></div>
  </form>;
};
