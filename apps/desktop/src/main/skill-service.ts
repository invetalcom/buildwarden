import { join, dirname } from "node:path";
import type { BuildWardenDatabase } from "@buildwarden/db";
import {
  APP_SETTING_KEYS, extractSkillMentions, isSkillImportInput, isSkillSelection,
  parseIntegratedSkillsDisabledSetting, parseProjectActiveSkillsSetting,
  type IntegratedSkillMetadata, type SkillImportInput, type SkillPackageRecord, type SkillSessionSnapshot,
} from "@buildwarden/shared";
import { packageBundledSkill, parseSkillPackage, readGitSkill, readSkillDirectory, skillMetadata, skillPackagePath, storeSkillFiles, findMissingSkillResources } from "./skill-packages";

let catalogPromise: Promise<typeof import("@buildwarden/shared/integrated-skills-catalog")> | undefined;
const catalog = () => catalogPromise ??= import("@buildwarden/shared/integrated-skills-catalog");

export const emptySkillSnapshot = (overrideIds: string[] | null = null): SkillSessionSnapshot => ({
  version: 1, createdAt: new Date().toISOString(), overrideIds, selectedIds: [], packages: [], explicitIds: [], loadedIds: [], diagnostics: [],
});

export class SkillService {
  readonly storePath: string;
  constructor(private readonly db: BuildWardenDatabase) {
    this.storePath = join(dirname(db.getFilePath()), "skill-packages");
  }

  async list(): Promise<IntegratedSkillMetadata[]> {
    const { INTEGRATED_SKILLS_CATALOG } = await catalog();
    const seen = new Set<string>();
    const bundled = INTEGRATED_SKILLS_CATALOG.filter((skill) => {
      const key = `${skill.source}:${skill.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((skill) => ({
      ...skillMetadata(skill), resourceCount: skill.references.length + 1,
      diagnostics: findMissingSkillResources(skill.content, new Map(skill.references.map((reference) => [reference.path, Buffer.from(reference.content)]))),
    }));
    return [...bundled, ...this.db.listSkillPackages().map((record) => record.metadata)];
  }

  async import(input: SkillImportInput): Promise<IntegratedSkillMetadata> {
    if (!isSkillImportInput(input)) throw new Error("Invalid skill import request.");
    const files = input.source === "local" ? await readSkillDirectory(input.path) : await readGitSkill(this.storePath, input);
    const record = parseSkillPackage(files, input);
    await storeSkillFiles(this.storePath, files);
    this.db.saveSkillPackage(record);
    return record.metadata;
  }

  remove(id: string): void {
    if (!this.db.listSkillPackages().some((record) => record.metadata.id === id)) throw new Error("Only imported skills can be removed.");
    this.db.removeSkillPackage(id);
    // Immutable files remain available to historical snapshots and interrupted sessions.
  }

  private async resolvePackage(id: string): Promise<SkillPackageRecord | undefined> {
    const imported = this.db.listSkillPackages().find((record) => record.metadata.id === id);
    if (imported) return imported;
    const skill = (await catalog()).INTEGRATED_SKILLS_BY_ID[id];
    return skill ? packageBundledSkill(this.storePath, skill) : undefined;
  }

  async content(id: string): Promise<string | null> {
    const record = await this.resolvePackage(id);
    if (!record) return null;
    return (await readSkillDirectory(skillPackagePath(this.storePath, record.hash))).get("SKILL.md")?.toString("utf8") ?? null;
  }

  setSelection(kind: "run" | "chat", id: string, ids: string[] | null): void {
    if (!isSkillSelection(ids)) throw new Error("Select at most 200 valid skill IDs.");
    const state = this.db.getSessionSkills(kind, id) ?? emptySkillSnapshot();
    this.db.setSessionSkills(kind, id, { ...state, overrideIds: ids === null ? null : [...new Set(ids)] });
  }

  async prepare(kind: "run" | "chat", id: string, prompt: string, projectId?: string, recovery?: SkillSessionSnapshot): Promise<SkillSessionSnapshot> {
    // Recovery restores the exact selection and package hashes, independent of later settings/imports.
    if (recovery?.version === 1) {
      this.db.setSessionSkills(kind, id, recovery);
      return recovery;
    }
    const previous = this.db.getSessionSkills(kind, id);
    const settings = this.db.getSettings();
    const disabled = new Set(parseIntegratedSkillsDisabledSetting(settings[APP_SETTING_KEYS.integratedSkillsDisabled]));
    const defaults = projectId ? parseProjectActiveSkillsSetting(settings[APP_SETTING_KEYS.projectActiveSkills])[projectId] ?? [] : [];
    const explicitIds = extractSkillMentions(prompt);
    const state = emptySkillSnapshot(previous?.overrideIds ?? null);
    state.selectedIds = [...new Set([...(state.overrideIds ?? defaults), ...explicitIds])];
    if (state.selectedIds.length > 200) throw new Error("Select at most 200 skills per session.");
    for (const skillId of state.selectedIds) {
      if (disabled.has(skillId)) {
        state.diagnostics.push({ skillId, status: "disabled", message: "Disabled globally; not available this turn." });
        continue;
      }
      try {
        const record = await this.resolvePackage(skillId);
        if (!record) throw new Error("Skill is no longer installed.");
        state.packages.push(record);
        state.diagnostics.push({ skillId, status: "available", message: record.diagnostics.join("\n") || undefined });
        if (explicitIds.includes(skillId)) state.explicitIds.push(skillId);
      } catch (error) {
        state.diagnostics.push({ skillId, status: "unavailable", message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.db.setSessionSkills(kind, id, state);
    return state;
  }

  recordEvent(kind: "run" | "chat", id: string, metadata?: Record<string, unknown>): void {
    if (metadata?.skillEvent !== true || typeof metadata.skillId !== "string") return;
    const state = this.db.getSessionSkills(kind, id);
    if (!state || !state.selectedIds.includes(metadata.skillId)) return;
    const status = metadata.skillStatus;
    if (status !== "loaded" && status !== "unavailable" && status !== "omitted") return;
    if (status === "loaded" && !state.loadedIds.includes(metadata.skillId)) state.loadedIds.push(metadata.skillId);
    state.diagnostics = state.diagnostics.map((diagnostic) => diagnostic.skillId === metadata.skillId
      ? { ...diagnostic, status, message: typeof metadata.skillMessage === "string" ? metadata.skillMessage : diagnostic.message } : diagnostic);
    this.db.setSessionSkills(kind, id, state);
  }
}
