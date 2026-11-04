import type { IntegratedSkillMetadata } from "./index";

export type SkillImportInput =
  | { source: "local"; path: string }
  | { source: "git"; url: string; revision: string; subdirectory: string };

export interface SkillPackageRecord {
  metadata: IntegratedSkillMetadata;
  hash: string;
  resources: string[];
  revision?: string;
  diagnostics: string[];
}

export interface SkillDiagnostic {
  skillId: string;
  status: "available" | "loaded" | "disabled" | "unavailable" | "omitted";
  message?: string;
}

/** Versioned manifest; package hashes refer to immutable app-owned directories. */
export interface SkillSessionSnapshot {
  version: 1;
  createdAt: string;
  /** null follows project defaults on the next turn; [] explicitly selects none. */
  overrideIds: string[] | null;
  selectedIds: string[];
  packages: SkillPackageRecord[];
  explicitIds: string[];
  loadedIds: string[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillRuntimeInput {
  snapshot: SkillSessionSnapshot;
  storePath: string;
  recovering: boolean;
}

export type SkillToolName = "buildwarden_load_skill" | "buildwarden_read_skill_resource";

export const isSkillSelection = (value: unknown): value is string[] | null =>
  value === null || (Array.isArray(value) && value.length <= 200 && value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 300));

export const isSkillImportInput = (value: unknown): value is SkillImportInput => {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return input.source === "local" ? typeof input.path === "string" && input.path.length > 0 && input.path.length <= 4096
    : input.source === "git" && typeof input.url === "string" && input.url.length <= 2048 &&
      typeof input.revision === "string" && /^[a-f0-9]{40}$/i.test(input.revision) &&
      typeof input.subdirectory === "string" && input.subdirectory.length <= 1024;
};

/** Only explicit, namespaced mentions trigger loading; native slash commands remain untouched. */
export const extractSkillMentions = (prompt: string): string[] =>
  [...new Set([...prompt.matchAll(/\$skill\(([a-zA-Z0-9:._/-]+)\)/g)].map((match) => match[1]!))];
