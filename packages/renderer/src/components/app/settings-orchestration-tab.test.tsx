import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrchestrationSettingsTab } from "./settings-orchestration-tab";

describe("OrchestrationSettingsTab", () => {
  it("uses the shared compact controls for model and role configuration", () => {
    const markup = renderToStaticMarkup(
      <OrchestrationSettingsTab
        models={[{
          id: "model-1",
          providerAccountId: "provider-1",
          modelId: "claude-sonnet",
          displayName: "Claude Sonnet",
          baseUrlOverride: null,
          configJson: "{}",
          capabilitiesJson: "{}",
          enabled: 1,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        }]}
        providerAccounts={[{
          id: "provider-1",
          providerType: "ai-sdk",
          label: "Anthropic",
          apiBaseUrl: null,
          apiKeyRef: "secret-ref",
          configJson: "{}",
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        }]}
        serializedValue={JSON.stringify({
          version: 1,
          maxConcurrentTasks: 3,
          maxTasksPerOrchestration: 12,
          models: [{ modelId: "model-1", enabled: true, defaultEffort: "high", maxConcurrent: 2 }],
          roles: [],
        })}
        canEdit
        onSave={vi.fn()}
      />,
    );

    expect(markup).not.toContain("<select");
    expect(markup.match(/role="combobox"/g)).toHaveLength(4);
    expect(markup).toContain('role="switch"');
    expect(markup).toContain("Parallel tasks");
    expect(markup).toContain("Default effort");
    expect(markup).toContain("1 active");
    expect(markup).toContain("Maximum concurrent tasks");
    expect(markup).toContain("Extra tasks");
    expect(markup).toContain("Lifetime task limit");
    expect(markup).toContain("not a target");
    expect(markup).toContain("Researcher");
    expect(markup).toContain("Implementer");
    expect(markup).toContain("Reviewer");
  });
});
