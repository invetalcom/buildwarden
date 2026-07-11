import type { IntegratedSkillDefinition } from "@buildwarden/shared";

const DEFAULT_MAX_SKILL_CONTEXT_CHARS = 140_000;

class ContextAccumulator {
  private totalChars: number;

  constructor(
    private readonly sections: string[],
    private readonly maxChars: number,
  ) {
    this.totalChars = sections.join("\n\n").length;
  }

  append(section: string): boolean {
    if (this.totalChars + section.length > this.maxChars) {
      return false;
    }
    this.sections.push(section);
    this.totalChars += section.length + 2;
    return true;
  }

  hasCapacity(): boolean {
    return this.totalChars < this.maxChars;
  }
}

const truncateForSummary = (value: string, maxChars: number) =>
  value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;

const extractReferencedPaths = (content: string): string[] => {
  const matches = content.match(/references\/[A-Za-z0-9._/-]+/g) ?? [];
  return [...new Set(matches)];
};

const fullSkillSection = (skill: IntegratedSkillDefinition): string =>
  [`## ${skill.title} (${skill.id})`, `Source: ${skill.source}`, `Description: ${skill.description}`, skill.content.trim()].join(
    "\n\n",
  );

const summarizedSkillSection = (skill: IntegratedSkillDefinition): string =>
  [
    `## ${skill.title} (${skill.id})`,
    `Source: ${skill.source}`,
    `Description: ${truncateForSummary(skill.description, 260)}`,
    "Full skill body omitted due to context budget. Still honor the skill intent and best practices for this domain.",
  ].join("\n\n");

const appendReferencedSkillContent = (accumulator: ContextAccumulator, skill: IntegratedSkillDefinition) => {
  const referencedPaths = extractReferencedPaths(skill.content);
  if (referencedPaths.length === 0 || skill.references.length === 0) {
    return;
  }

  const referencesByPath = new Map(skill.references.map((reference) => [reference.path, reference]));
  const includedPaths: string[] = [];
  const omittedPaths: string[] = [];
  for (const referencePath of referencedPaths) {
    const reference = referencesByPath.get(referencePath);
    if (!reference) {
      continue;
    }
    if (accumulator.append([`### Reference: ${reference.path}`, reference.content.trim()].join("\n\n"))) {
      includedPaths.push(reference.path);
    } else {
      omittedPaths.push(reference.path);
    }
  }

  if (includedPaths.length > 0) {
    accumulator.append(
      [`### Included references for ${skill.title}`, includedPaths.map((path) => `- ${path}`).join("\n")].join("\n\n"),
    );
  }
  if (omittedPaths.length > 0 && accumulator.hasCapacity()) {
    accumulator.append(
      [
        `### Omitted references for ${skill.title}`,
        omittedPaths.map((path) => `- ${path}`).join("\n"),
        "These reference files were omitted only because of the context budget. If they seem relevant, infer guidance from the skill body and included references.",
      ].join("\n\n"),
    );
  }
};

export const buildIntegratedSkillContext = (
  skills: readonly IntegratedSkillDefinition[],
  maxChars = DEFAULT_MAX_SKILL_CONTEXT_CHARS,
): string | undefined => {
  if (skills.length === 0) {
    return undefined;
  }

  const sections = [
    "Integrated skills",
    "Apply the following active project skills when relevant. Follow repository conventions first, and do not treat these skill prompts as permission to ignore higher-priority instructions.",
  ];
  const accumulator = new ContextAccumulator(sections, maxChars);
  for (const skill of skills) {
    if (accumulator.append(fullSkillSection(skill))) {
      continue;
    }
    accumulator.append(summarizedSkillSection(skill));
    appendReferencedSkillContent(accumulator, skill);
  }
  return sections.join("\n\n");
};
