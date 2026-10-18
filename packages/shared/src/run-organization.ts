/** Uncategorized is virtual: a missing assignment always belongs to it. */
export const UNCATEGORIZED_RUN_SECTION_ID = "uncategorized";
export const RUN_SECTION_NAME_LIMIT = 80;
export const RUN_TAG_LIMIT = 40;
export const RUN_TAG_COUNT_LIMIT = 20;
export const DEFAULT_RUN_SECTION_COLOR = "#60a5fa";
export const DEFAULT_UNCATEGORIZED_COLOR = "#94a3b8";
export const isRunSectionColor = (value: unknown): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export interface RunSectionRecord {
  id: string;
  name: string;
  position: number;
  /** Missing on snapshots from hosts predating section colors. */
  color?: string;
}

export interface RunOrganizationRecord {
  runId: string;
  sectionId: string | null;
  tags: string[];
}

export interface RunOrganizationSnapshot {
  uncategorizedColor?: string;
  sections: RunSectionRecord[];
  runs: RunOrganizationRecord[];
}

export interface UpdateRunOrganizationInput {
  /** null returns the run to Uncategorized. Omitted fields are preserved. */
  sectionId?: string | null;
  tags?: string[];
}

export const isRunSectionName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= RUN_SECTION_NAME_LIMIT &&
  value.trim().toLowerCase() !== UNCATEGORIZED_RUN_SECTION_ID;

export const isUpdateRunOrganizationInput = (value: unknown): value is UpdateRunOrganizationInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => key !== "sectionId" && key !== "tags")) return false;
  if ("sectionId" in input && input.sectionId !== null &&
      (typeof input.sectionId !== "string" || !input.sectionId.trim() || input.sectionId.length > 200)) return false;
  return !("tags" in input) || (Array.isArray(input.tags) && input.tags.length <= RUN_TAG_COUNT_LIMIT &&
    input.tags.every((tag) => typeof tag === "string" && tag.trim().length > 0 && tag.trim().length <= RUN_TAG_LIMIT));
};
