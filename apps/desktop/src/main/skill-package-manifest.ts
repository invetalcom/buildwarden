import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type { SkillImportInput, SkillPackageRecord } from "@buildwarden/shared";
import { checkSkillFiles, findMissingSkillResources, hashSkillFiles, type SkillFiles } from "./skill-packages";

// Kept apart from skill-packages so run and chat workers, which only read stored packages, never
// load the YAML parser. Import this module on demand when a skill is imported.
export const parseSkillPackage = (files: SkillFiles, source: SkillImportInput): SkillPackageRecord => {
  checkSkillFiles(files);
  const text = files.get("SKILL.md")?.toString("utf8");
  const header = text?.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!text || !header) throw new Error("SKILL.md must contain YAML frontmatter with name and description.");
  const document = parseDocument(header[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid SKILL.md frontmatter: ${document.errors[0]!.message}`);
  const parsed: unknown = document.toJS({ maxAliasCount: 20 });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Skill frontmatter must be a mapping.");
  const data = parsed as Record<string, unknown>;
  if (typeof data.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64) throw new Error("Skill name must be lowercase words separated by hyphens (up to 64 characters).");
  if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024) throw new Error("Skill description is required (up to 1024 characters).");
  const diagnostics = findMissingSkillResources(text, files);
  const hash = hashSkillFiles(files);
  const location = source.source === "local" ? resolve(source.path) : `${source.url}#${source.subdirectory}`;
  const id = `${source.source}:${data.name}:${createHash("sha256").update(location).digest("hex").slice(0, 12)}`;
  return {
    hash, resources: [...files.keys()].sort(), diagnostics,
    ...(source.source === "git" ? { revision: source.revision.toLowerCase() } : {}),
    metadata: {
      id, source: source.source, category: "custom", name: data.name, title: data.name,
      description: data.description.trim(), license: typeof data.license === "string" ? data.license : null,
      relativeDir: source.source === "git" ? source.subdirectory : "", sourceUrl: source.source === "git" ? source.url : "",
      contentHash: hash, diagnostics, resourceCount: files.size,
      ...(source.source === "git" ? { revision: source.revision.toLowerCase() } : {}),
      ...(typeof data.compatibility === "string" ? { compatibility: data.compatibility } : {}),
    },
  };
};
