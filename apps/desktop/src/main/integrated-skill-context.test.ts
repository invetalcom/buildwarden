import type { IntegratedSkillDefinition } from "@buildwarden/shared";
import { describe, expect, it } from "vitest";
import { buildIntegratedSkillContext } from "./integrated-skill-context";

const skill = (overrides: Partial<IntegratedSkillDefinition> = {}): IntegratedSkillDefinition => ({
  id: "example",
  source: "openai",
  category: "official",
  name: "example",
  title: "Example skill",
  description: "Example guidance",
  license: null,
  relativeDir: "skills/example",
  sourceUrl: "https://example.com/skill",
  content: "Use the example workflow.",
  references: [],
  ...overrides,
});

describe("buildIntegratedSkillContext", () => {
  it("returns no context when the project has no active skills", () => {
    expect(buildIntegratedSkillContext([])).toBeUndefined();
  });

  it("includes complete skill content when it fits the budget", () => {
    const context = buildIntegratedSkillContext([skill()]);
    expect(context).toContain("## Example skill (example)");
    expect(context).toContain("Use the example workflow.");
  });

  it("uses the summary and only referenced files when the full body exceeds the budget", () => {
    const context = buildIntegratedSkillContext(
      [
        skill({
          content: `${"x".repeat(500)} See references/needed.md`,
          references: [
            { path: "references/needed.md", content: "Required reference" },
            { path: "references/unmentioned.md", content: "Unmentioned reference" },
          ],
        }),
      ],
      700,
    );
    expect(context).toContain("Full skill body omitted due to context budget");
    expect(context).toContain("Required reference");
    expect(context).not.toContain("Unmentioned reference");
  });
});
